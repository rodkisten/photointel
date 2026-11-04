# 📱 Notify! — Live Activity e notificações por step

> **Nota de revisão arquitetural (04/11/2026):** Notify! é integração de entrega **best effort**. Cada workflow/run, Job UUID e Sentry event ID tem identidade própria; uma Live Activity não substitui os eventos persistidos nem confirma entrega no iPhone. Consulte [a referência técnica](../architecture/OBSERVABILITY_AND_OPERATIONS.md).

Esta integração usa a API do [Notify!](https://getnotifyapp.com/apidocs/), **sem** um serviço adicional e **sem** publicar credenciais no repositório.

## ✅ Apenas execuções estratégicas

Notify! está ativo somente nos workflows **GCP Deploy**, **Setup GCP**, **Pages** e **ZIP Patch**. CI, testes, smoke, validações, WebKit, SSH e geração de manifesto não produzem notificações.

Deploy e Setup GCP criam uma **Live Activity por execução**, atualizada nas fases de interesse. O conteúdo usa **etapas concluídas**, como `2/4` e uma barra segmentada para fluxos com mais de uma fase, **sem `endsIn` ou relógio regressivo**. Cada atividade tem exatamente **um botão contextual**, substituído durante o avanço:

- **Ver workflow:** enquanto a execução inicia.
- **Ver step:** abre o job e, quando disponível, diretamente o step atual do GitHub Actions. O identificador do job é consultado com `github.token` e `actions:read`, com fallback para o índice conhecido do step e depois para o job/workflow, sem inventar IDs.
- **Logs GCP:** quando um step de API, Cloud Run Jobs ou Build falha, abre o painel pertinente do Google Cloud. Falhas do Alembic/Neon permanecem no GitHub, pois migrations rodam diretamente no runner e não têm logs de Cloud Run.

Os updates de fase são silenciosos. Falhas ou cancelamentos de fases importantes geram push curto; sucesso intermediário não gera push. O fim de deploy/setup envia **um único push de sucesso** (ou mantém a notificação de falha da fase) e encerra a Live Activity com 60 segundos de permanência.

Pages e ZIP Patch enviam somente avisos das etapas críticas que falharem e o resultado bem-sucedido final; não criam Live Activities. `Notify!` é sempre `best-effort`: indisponibilidade de rede não muda o status dos jobs.

## 🔐 Configuração única em GitHub Actions Secrets

**ATENÇÃO:** se você já compartilhou um webhook URL com `token=` em um chat, issue, screenshot ou log, **gere um NOVO token pelo Notify!** antes de cadastrá-lo. Não aproveite um token exposto.

Abra **[Settings → Secrets and variables → Actions](https://github.com/rodkisten/photointel/settings/secrets/actions)**, na seção **Repository secrets**, e adicione:

| Repository secret | Conteúdo |
|---|---|
| `NOTIFY_DEVICE_ID` | ID do seu iPhone exibido pelo Notify! (ex.: prefixo `IO` em instalações recentes) |
| `NOTIFY_TOKEN` | **Novo** token do dispositivo, gerado pelo Notify! após a rotação |

**Por que no repositório, não só no Environment `production`?** O workflow ZIP não exige o Environment de produção, por decisão de segurança. Repository secrets são injetados somente nas execuções autorizadas pelo GitHub e são omitidos para PRs de forks não confiáveis. Não altere as permissões desses workflows só para permitir notificações.

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

### Como o contador funciona

O seletor `action` define a quantidade real de fases estratégicas. Em `release` são três: **Build → Jobs → API**; `scheduler` e outras ações individuais têm uma única fase. Em Setup GCP há a fase **Setup**. Os eventos `running` atualizam o botão para o step que vai começar; eventos `success` aumentam a contagem somente depois da conclusão. Etapas ignoradas não contam. Falhas preservam o último contador válido.

A API Notify! aceita `steps` (de 2 a 20), `step` (concluídas), `trailing` (`2/4`) e `button: {title, url, open: true}`. O campo `endsIn` não é enviado ao iniciar nem atualizar, e é limpo ao finalizar. Consulte [a documentação oficial](https://getnotifyapp.com/apidocs/).

**Segurança dos links:** `github.token` é usado apenas na chamada privada ao GitHub para descobrir o job; **não** aparece na URL do botão. O dispositivo precisa estar autenticado no GitHub para abrir a página privada. Um botão por atividade, nunca múltiplos botões empilhados.

## 🧪 Testar com segurança

1. Configure os dois repository secrets.
2. Execute `Setup GCP` em modo `plan` (sem mutação) ou um deploy de Pages (sem mutação no Google Cloud).
3. No GCP, confira a Live Activity sem cronômetro, o contador e o botão Ver step; Pages/ZIP alertam apenas sobre falhas importantes e sucesso final.
4. Consulte os logs de cada step `📱` ou `🔔`. Se o serviço falhar, você verá um `::warning::` **sem URL autenticada**.

Uma Live Activity aparece apenas em iPhone/iPad com o Notify! configurado, permissões de notificações e Live Activities habilitadas. A API não transforma um browser ou Mac em dispositivo de Live Activity.

Referência oficial: [Notify! API Docs](https://getnotifyapp.com/apidocs/).
