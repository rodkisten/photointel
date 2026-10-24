# 📱 Notify! — Live Activity e notificações por step

Esta integração usa a API do [Notify!](https://getnotifyapp.com/apidocs/), **sem** um serviço adicional e **sem** publicar credenciais no repositório.

## ✅ O que está implementado

| Workflow | Live Activity no iPhone | Push por step operacional |
|---|---|---|
| [🧱 GCP Bootstrap](../../.github/workflows/gcp-bootstrap.yml) | ✅ Começa após checkout, atualiza a cada step e encerra com status final | ✅ |
| [🚀 GCP Deploy](../../.github/workflows/gcp-deploy.yml) | ✅ Começa após checkout, atualiza build/jobs/API/scheduler e encerra | ✅ |
| [🧪 CI](../../.github/workflows/ci.yml) | Não | ✅ |
| Os outros dez workflows especializados | Não | ✅ |

**Total:** 13 workflows, **197 steps operacionais** instrumentados. Steps pulados não geram push. Cada conclusão de step executado envia sucesso, falha ou cancelamento. Os próprios steps de notificação não são notificados (evita loop infinito). Jobs inteiros ignorados não geram alerta.

Notificações de todos os jobs de um run compartilham o `groupType` por ID da execução do GitHub para ficarem agrupadas no app, em vez de espalhar alertas sem relação.

## 🔐 Configuração única em GitHub Actions Secrets

**ATENÇÃO:** se você já compartilhou um webhook URL com `token=` em um chat, issue, screenshot ou log, **gere um NOVO token pelo Notify!** antes de cadastrá-lo. Não aproveite um token exposto.

Abra **[Settings → Secrets and variables → Actions](https://github.com/rodkisten/photointel/settings/secrets/actions)**, na seção **Repository secrets**, e adicione:

| Repository secret | Conteúdo |
|---|---|
| `NOTIFY_DEVICE_ID` | ID do seu iPhone exibido pelo Notify! (ex.: prefixo `IO` em instalações recentes) |
| `NOTIFY_TOKEN` | **Novo** token do dispositivo, gerado pelo Notify! após a rotação |

**Por que no repositório, não só no Environment `production`?** Os workflows CI, WebKit, ZIP e outros não têm acesso ao Environment de produção, por decisão de segurança. Repository secrets são injetados somente nas execuções autorizadas pelo GitHub e são omitidos para PRs de forks não confiáveis. Não altere as permissões desses workflows só para permitir notificações.

Os dois valores são secretos. **Não** crie `vars.NOTIFY_TOKEN`, não preencha com valores reais em YAML nem faça `echo` dos tokens nos logs. Os workflows usam somente expressões:

```yaml
with:
  device-id: ${{ secrets.NOTIFY_DEVICE_ID }}
  token: ${{ secrets.NOTIFY_TOKEN }}
```

Sem esses secrets, o integrador apenas informa "Notify! disabled" e os workflows continuam normalmente. Isso permite revisar as mudanças antes de habilitar pushes.

## 🧩 Arquitetura

- [`infra/notify/notify.py`](../../infra/notify/notify.py): transporte HTTPS, JSON para `/notify-json/{id}` e `/live-activity/{id}`; timeout limitado, **nunca imprime o token/URL autenticado**.
- [`.github/actions/notify/action.yml`](../../.github/actions/notify/action.yml): composite action local; interface `start`, `step` e `end`.
- [`infra/gcp/tests/test_notify.py`](../../infra/gcp/tests/test_notify.py): testes com HTTP simulado e verificação da cobertura dos workflows.

### Etapas da Live Activity

1. `start`: inicia no iPhone após checkout com `new=1`, cria **uma Live Activity própria por run**, recebe seu `activityId` e oferece um link para a execução no GitHub.
2. `step`: após cada step real, envia um push e, se o workflow for GCP, também atualiza o **mesmo `activityId`**. A barra vai de 0 até aproximadamente 95% durante os steps.
3. `end`: executa com `always()`, encerra pelo `activityId` usando `DELETE` e deixa o estado final visível por 90 segundos. Só coloca 100% se o job teve sucesso. Uma falha não é registrada como conclusão bem-sucedida.

A etapa final é best-effort; se o runner for interrompido à força, não há garantia de execução de seu cleanup. A própria Live Activity do iOS expira conforme os limites do Notify!/Apple.

### Notificações de cada step

Cada step operacional recebe um ID estável e um step observador:

```yaml
- name: "🔔 [NOTIFY] 🏗️ [BUILD] Compilar imagem"
  if: ${{ always() && (steps.build_image.outcome == 'success' || steps.build_image.outcome == 'failure' || steps.build_image.outcome == 'cancelled') }}
  continue-on-error: true
  uses: ./.github/actions/notify
  with:
    action: step
    device-id: ${{ secrets.NOTIFY_DEVICE_ID }}
    token: ${{ secrets.NOTIFY_TOKEN }}
    workflow: ${{ github.workflow }}
    job: ${{ github.job }}
    step: "🏗️ [BUILD] Compilar imagem"
    outcome: ${{ steps.build_image.outcome }}
```

`continue-on-error: true` somado às exceções capturadas no Python significa que **uma falha de rede do Notify! não mascara nem provoca falha no deploy/CI**. Os steps originais mantêm suas condições/saídas e a execução continua ou interrompe conforme o comportamento original.

## ⚠️ Volume de notificações

Este recurso envia **um push por step que realmente executar**, exatamente como solicitado. Um workflow CI pesado pode enviar muitas notificações durante um run; o agrupamento por run melhora a organização, mas **não silencia o som nem elimina a quantidade de pushes**. Se for demais, remova temporariamente os secrets ou configure a política de notificações do Notify!/iOS. Não use o token antigo para teste.

## 🧪 Testar com segurança

1. Configure os dois repository secrets.
2. Execute um workflow manual leve (por exemplo, `🧾 Release Manifest`) ou `GCP Bootstrap` em modo `plan` (sem mutação no Google Cloud).
3. Verifique a notificação em cada step concluído; no modo GCP, confira também a Live Activity iniciar, atualizar e desaparecer após o término.
4. Consulte os logs de cada `🔔 [NOTIFY]`. Se o serviço falhar, você verá um `::warning::` **sem URL autenticada**.

Uma Live Activity aparece apenas em iPhone/iPad com o Notify! configurado, permissões de notificações e Live Activities habilitadas. A API não transforma um browser ou Mac em dispositivo de Live Activity.

Referência oficial: [Notify! API Docs](https://getnotifyapp.com/apidocs/).
