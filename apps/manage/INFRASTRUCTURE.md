# Infraestrutura do PhotoIntel Manage

**Rota:** `https://photos-manage.migos.club/infrastructure`  
**Projeto autorizado:** `photointel` / `us-central1`  
**Terminal autorizado:** `photointel-terminal` / `us-central1-a`

Esta página é um painel operacional de GCP. Reaproveita **Cloudflare Access**,
Workload Identity Federation e a conta `photointel-manage` existentes. O Worker
não usa uma chave de service account nem revela tokens ao navegador.

## Funcionalidades

| Área | Como funciona |
| --- | --- |
| Cloud Build | Lista builds e triggers regionais e globais; executa manualmente somente UUIDs na allowlist, sempre em `main`; exibe status e etapas |
| Provisionamento | Os triggers autorizados podem executar `infra/gcp/cloudbuild-manage-provision.yaml` (plano/permissões/aplicação) |
| Release | `infra/gcp/cloudbuild-manage-release.yaml` gera uma imagem da revisão e aplica os manifestos de jobs, serviço e scheduler |
| Inventário | Lê serviços e jobs de Cloud Run e agendamentos do Cloud Scheduler |
| Terminal | Liga e desliga **apenas** a VM preexistente `photointel-terminal`; rejeita VMs com labels inesperadas |
| Expiração | Ajusta `maxRunDuration` + `instanceTerminationAction=STOP` enquanto a VM estiver desligada; aguarda concluir a operação antes de iniciar |
| Logs | Lê Cloud Logging e somente eventos conhecidos do serial da VM; 5 segundos de polling, severidades, busca e JSON expandível |

O painel é **quase em tempo real por polling**, não SSE/WebSocket. A indicação
de expiração tenta usar `resourceStatus.scheduling.terminationTimestamp`, calculando
pela última inicialização apenas quando o GCP não tiver esse valor.

## Ativação única

1. Faça merge das alterações em `main` e publique o Manage pelo fluxo atual
   `.github/workflows/manage-deploy.yml`.
2. Rode o workflow `🧱 Setup GCP` (`gcp-bootstrap.yml`), com `mode=apply`,
   para habilitar `compute.googleapis.com` e reconciliar o papel customizado
   `photointelManageInfrastructure`. O modo `permissions` apenas reconcilia IAM,
   sem habilitar APIs não existentes.
3. Em Secret Manager, crie **`photointel-gcp-config`** e adicione uma versão
   contendo a configuração **completa** equivalente à variável
   `production/GCP_CONFIG_ENV` do GitHub. A versão é usada como `GCP_CONFIG_ENV`
   nos Cloud Builds, sem imprimir o valor nos logs. Configure política de acesso
   exclusiva para as contas que executam esses builds.
4. Conecte `rodkisten/photointel` ao Cloud Build (GitHub, branch `main`). Crie
   triggers **manuais** privados, com os arquivos:

   - `infra/gcp/cloudbuild-manage-provision.yaml`
   - `infra/gcp/cloudbuild-manage-release.yaml`

   O primeiro vem com `_MODE=permissions` por segurança. Para provisionar
   **toda** a infraestrutura a partir dele, crie um trigger de aplicação com
   substituições `_MODE=apply` e `_AUTHORIZE_CHARGES=true`. Um terceiro
   trigger separado pode executar `plan`.
5. Use uma **conta de serviço dedicada no Cloud Build para cada tipo de trigger**.
   A conta de provisionamento precisa de privilégios administrativos de bootstrap;
   a conta de release precisa dos privilégios de deploy já usados pelo projeto.
   Ambas devem poder ler somente a versão de configuração necessária e gravar logs
   no Cloud Logging. Garanta também acesso à origem GitHub. Não vincule estas
   contas privilegiadas a triggers públicos ou que executem pull requests de forks.
6. Copie os UUIDs reais dos triggers criados e configure na variável de ambiente
   de produção `GCP_CONFIG_ENV`, dentro de `extra_environment`:

   ```dotenv
   EXTRA_ENVIRONMENT__MANAGE_CLOUDBUILD_ALLOWED_TRIGGERS=us-central1:UUID_DO_TRIGGER,us-central1:UUID_DO_SEGUNDO_TRIGGER
   ```

   Em JSON, use a chave `MANAGE_CLOUDBUILD_ALLOWED_TRIGGERS` dentro de
   `extra_environment`. O script `infra/scripts/deploy_manage.py` valida a
   lista e a transmite como `GCP_CLOUDBUILD_ALLOWED_TRIGGERS` ao Worker.
   Repita a publicação do Manage após atualizar esta configuração.

Os **UUIDs de exemplo devem ser substituídos pelos IDs reais**. Sem allowlist,
a consulta continua disponível, mas a execução é bloqueada.

## Segurança operacional

- Autorização de entrada: JWT assinado de Cloudflare Access, audience dedicada
  e allowlist de e-mails. Alterações exigem `Origin` igual ao domínio Manage.
- Somente `cloudbuild.builds.create/get/list` e operações específicas do Compute
  Engine são adicionadas à conta Manage. A API rejeita submissão de comandos e
  `Build` arbitrário, aceitando apenas triggers allowlisted.
- **Atenção:** `cloudbuild.builds.create` é uma permissão privilegiada. A segurança
  também depende da configuração do trigger e da conta que executa o build. Uma
  alteração maliciosa no repositório ou num trigger pode executar código com essa
  identidade. Restrinja alteração dos triggers e proteja `main`.
- A VM deve ser `photointel-terminal`, na zona definida, com labels
  `app=photointel` e `purpose=terminal`. O Worker não permite definir
  nome da VM, zona, comando shell ou metadata via request.
- `prepare` só aceita VM parada e duração de 15 a 720 minutos. `start`
  somente é permitido se o limite corresponder ao solicitado e o GCP tiver
  `instanceTerminationAction=STOP`. `stop` é permitido durante `RUNNING`.
- Não exiba conteúdo serial bruto. Só eventos de inicialização pré-definidos
  atravessam a API. Entradas do Cloud Logging recebem redaction de tokens.
- O desligamento ocorre no **GCP**, independentemente do browser. Se a VM já
  estiver ligada sem expiração configurada, o painel avisa o operador.
- Provisionamento e releases podem gerar custos. A confirmação no Manage não
  substitui controle de orçamento ou permissões de billing.

## Endpoints

Todos requerem sessão válida de Cloudflare Access:

```text
GET  /api/infrastructure
GET  /api/infrastructure/vm
POST /api/infrastructure/vm/prepare   { "minutes": 120 }
POST /api/infrastructure/vm/start     { "minutes": 120 }
POST /api/infrastructure/vm/stop      {}
GET  /api/infrastructure/vm/operations/{operation_name}
GET  /api/infrastructure/vm/logs
POST /api/infrastructure/builds/run   { "location":"us-central1", "id":"<UUID>", "confirm":"RUN us-central1:<UUID>" }
GET  /api/infrastructure/builds/logs?id=<UUID>
```

No navegador, a página configura a expiração, espera a operação zonal terminar,
e só então solicita o start. Em eventual erro de IAM, verifique o resultado
do workflow GCP bootstrap e a configuração WIF; a interface não marca sucesso
antes da confirmação de operação.

## Custos e diagnóstico

- Builds ficam no Cloud Build e não consomem minutos dos runners hospedados no
  GitHub. O Cloud Build e as VMs ainda podem gerar cobrança pelo GCP.
- Para logs ausentes, confirme `roles/logging.viewer`, que o build escreva em
  Cloud Logging e que a API Compute Engine esteja habilitada.
- Para trigger não listado, confira a região do Cloud Build, o UUID e a allowlist
  publicada no Worker. Triggers desativados não podem ser disparados.
- Para conectar por SSH, use o Tailscale já configurado no terminal do projeto.
  O Manage não implementa um terminal remoto dentro da página.

## Documentação da API do Google Cloud

- [Executar um trigger](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.locations.triggers/run)
- [VM setScheduling](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/setScheduling)
- [Contas de serviço no Cloud Build](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)
