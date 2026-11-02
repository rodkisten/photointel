# PhotoIntel Manage · Operational Control Center

**Separate Cloudflare Worker:** photointel-manage  
**Private URL:** https://photos-manage.migos.club  
**Code:** apps/manage/  
**Auth:** independent Cloudflare Zero Trust Access application, backed by a signed
RS256 JWT, fixed audience and explicit e-mail allowlist. Both HTML and /api/*
require verified Access; no unauthenticated static assets.

This admin panel does not share PhotoIntel's public Worker, routes, assets,
deploy frequency, browser tokens or runtime authorization.

## Available operations

| Screen | Integration |
| --- | --- |
| Visão geral | GitHub Actions, Cloudflare Workers, Cloud Run service inventory and provider status |
| Deploys | Fixed allowlist of workflow_dispatch actions, input choices, confirmation, runs, jobs and step-level logs, retry failed |
| Logs | Cloudflare Workers Observability query API, GCP Cloud Logging (optional OIDC federation), GitHub job logs, recent unresolved Sentry issues |
| Ambiente | Edit the *environment variable* production/GCP_CONFIG_ENV (JSON or dotenv) via GitHub REST, with optimistic SHA-256 version checks and project validation |
| Sistema | Access identity, provider configuration, GCP jobs, Cloudflare worker domain inventory |

The backend returns status 503 with a useful setup hint if a provider is not
configured. It **never** displays simulated or guessed GCP/Cloudflare status.

## First deployment

1. On Google Secret Manager, create a new secret containing a dedicated
   **fine-grained GitHub PAT** for repository rodkisten/photointel (without the
   space), selecting at minimum **Actions: Read and Write** and
   **Environments: Read and Write**. GitHub variables use the Environments
   permission. Use a dedicated credential, not the ephemeral GITHUB_TOKEN.
2. Add to the existing **production Environment variable** GCP_CONFIG_ENV:

   Under extra_environment, add a distinct **administrator-only** allowlist.
   This never inherits PhotoIntel photo-viewer privileges:

       "MANAGE_ACCESS_ALLOWED_EMAILS": "[\"admin@example.com\"]"

   Replace the example address with your authorized operator address(es).
   The first deployment fails closed if this list is missing.

   JSON form, merged into existing workflow_secrets:

       "MANAGE_GITHUB_API_TOKEN": {
         "name": "photointel-manage-github-token", "version": "1"
       }

   Optional dedicated read-only tokens:

       "MANAGE_CLOUDFLARE_API_TOKEN": {
         "name": "photointel-manage-cloudflare-token", "version": "1"
       },
       "MANAGE_SENTRY_API_TOKEN": {
         "name": "photointel-manage-sentry-token", "version": "1"
       }

   They are under the existing workflow_secrets object, **not** top-level
   secrets. Existing deploy machinery grants the GCP deployer accessor rights.
   Do not put token values in GCP_CONFIG_ENV.

3. Run **🧱 Setup GCP → permissions** to create the dedicated
   `photointel-manage@photointel.iam.gserviceaccount.com` account if missing and
   reconcile its read-only `roles/run.viewer`, `roles/logging.viewer` and
   `roles/cloudscheduler.viewer` project bindings. This mode also reconciles
   Secret Manager permissions for workflow secret references. Provide the
   pinned secret versions separately in Secret Manager. An initial full GCP
   bootstrap can instead use **apply**; it provisions the same Manage identity.
4. GitHub Actions → **🚀 Manage · Publish** → mode **plan**.
   The plan inventories the intended separate Access application.
5. Select mode **apply**. The job builds apps/manage, creates/reconciles the
   independent Access app photointel-manage using ONLY the dedicated
   MANAGE_ACCESS_ALLOWED_EMAILS admin list, obtains its real audience, deploys the standalone
   Worker at photos-manage.migos.club and sets Worker secrets via stdin.
6. After verifying login, set production Environment variable
   MANAGE_ENABLED=true **as a repository Actions variable** if you want this independent Worker automatically
   published whenever its own files change on main.

The existing photos.migos.club worker, access policies, Cloud Run deploys,
D1, R2, iCloud, image buckets and release workflows remain independent.
Do not enable automatic deploy until the first manual apply succeeds.

**Cloudflare privileges:** the deployment token needs the existing Workers
Scripts and Access Apps/Policies management scopes and custom domain routing
permission. The **runtime** Cloudflare token may be a separate read-only token
with permissions for Workers Scripts Read, Workers Observability Write
(required for the telemetry query endpoint) and Worker Domains Read. Cloudflare
returns a request error if the account ID or query payload does not match.
A missing runtime token does not block GitHub functionality.

## Google Cloud without long-lived service account keys

The admin Worker uses **short-lived Access JWTs**. No service account JSON
keys are used or needed. Run **🧱 Setup GCP → permissions** after the
Cloudflare Access app has been created by **🚀 Manage · Publish → apply**.

The bootstrap now discovers the existing `photointel-manage` Access app
on `photos-manage.migos.club` through the **existing** Cloudflare API token
reference in `workflow_secrets`. It validates the app-specific audience,
retrieves the public RSA JWKS from the trusted Access team domain, and
creates/reconciles the Google Workload Identity Pool provider
`manage/cloudflare-access`.

The provider allows ONLY the exact Manage Access AUD and the allowlisted
`extra_environment.MANAGE_ACCESS_ALLOWED_EMAILS` identities. Bootstrap
grants impersonation of the **read-only** `photointel-manage` service account
only to the mapped allowlisted email principals, not the entire pool.

Project roles on that account:

- `roles/run.viewer`
- `roles/logging.viewer`
- `roles/cloudscheduler.viewer`

Cloudflare Access public signing keys are refreshed when bootstrap is run,
so rerun permissions after Access certificate rotation. The bootstrap
does not touch GitHub deploy federation or the PhotoIntel public Worker.

The separate Manage deployment automatically sets:

```dotenv
MANAGE_GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/799387180206/locations/global/workloadIdentityPools/manage/providers/cloudflare-access
MANAGE_GCP_IMPERSONATE_SERVICE_ACCOUNT=photointel-manage@photointel.iam.gserviceaccount.com
```

These are public identifiers, not secrets. You can omit them from
`extra_environment`; if explicitly set, they must match the dedicated
provider. Do not set a generic GitHub WIF provider here.

**Correct activation order:**

1. Run `Manage · Publish → apply` to create the protected Access app.
2. Run `Setup GCP → permissions` to reconcile the Manage reader SA,
   Cloudflare Access WIF pool/provider and principal-specific IAM bindings.
3. Run `Manage · Publish → apply` again to redeploy the Manage Worker.
4. In System, check real provider status and error details, not just the presence
   of environment values.

Cloud Logging queries remain bounded to project `photointel`, limited
resource types, and 5–240 minute windows. Sensitive messages are sanitized.

## Telegram no .env (sem Secret Manager)

O relay do Telegram pode usar as configurações diretamente no `GCP_CONFIG_ENV` em
formato dotenv:

```dotenv
TELEGRAM_NOTIFICATION_API_TOKEN=cole_seu_token_aqui
TELEGRAM_NOTIFICATION_URL=https://xtelegram-cf.migos.club/notifications/send
TELEGRAM_NOTIFICATION_CHAT_ID=-1001234567890
```

Também são aceitas as variantes
`EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_API_TOKEN`,
`EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_URL` e
`EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_CHAT_ID`. Quando ambas as formas
estiverem presentes, a versão `EXTRA_ENVIRONMENT__*` tem prioridade.

- A configuração direta prevalece sobre
  `SECRETS__TELEGRAM_NOTIFICATION_API_TOKEN__NAME/VERSION`; **não consulta o
  Secret Manager para este token** quando o valor inline estiver presente.
- Tanto os jobs/API no Cloud Run quanto as notificações de GitHub Actions usam o
  mesmo token e destino definidos no `.env`.
- `TELEGRAM_JOB_EVENTS_ENABLED` é derivado automaticamente quando token, URL
  e chat ID existem. Não precisa ser definido manualmente.
- Não gera imagem Docker nova: ao salvar no Manage, é solicitada uma
  sincronização da configuração de API/jobs reutilizando as imagens atuais.
- Valores do token são mascarados no resumo do GCP e nunca enviados para o
  frontend público ou retornados nos endpoints de saúde do painel.

**Atenção:** `GCP_CONFIG_ENV` está hoje configurado como uma **Environment
variable**, não como GitHub Actions Secret. Quem tiver permissão para ler essas
variables, logs de preparação que exponham inputs ou definições de ambiente
do Cloud Run poderá obter o token. Para um token sensível, prefira guardar o
`.env` inteiro em um GitHub Environment Secret com outro mecanismo de edição
ou manter a referência Secret Manager. A configuração direta é uma conveniência
com esse custo de segurança.

## Automação de mudanças no ambiente

Na aba **Ambiente**, o editor de `GCP_CONFIG_ENV` (JSON ou dotenv) compara
campos estruturais antes de salvar. A opção **Aplicar automaticamente as
alterações ao salvar** vem ativada, mas pode ser desmarcada.

O backend salva com proteção por versão SHA-256 e, depois de uma gravação
confirmada no GitHub, solicita apenas os workflows aplicáveis:

| Alteração | Workflow | Efeito |
| --- | --- | --- |
| Env do Cloud Run, configuração da API e parâmetros de jobs | `config-sync.yml` | Reconfigura apenas API e/ou jobs preservando a imagem e SHA já em produção. Não faz Docker build nem migração. |
| `VITE_*`, origem do frontend ou parâmetros do Worker | `deploy-worker.yml` | Recompila e publica o frontend/Worker. |
| Configuração do Manage e tokens de integração do painel | `manage-deploy.yml` | Recompila e publica exclusivamente o Manage. |
| Agendamento Cloud Scheduler | Revisão manual | Evita que alterações automáticas pausem jobs de produção. |
| Identidade/infraestrutura ou novo nome de secret | Revisão administrativa | Não aciona bootstrap privilegiado automaticamente. |
| Somente formatação | Nenhum | Evita execuções inúteis. |

Quando a API GitHub aceita o dispatch, o painel informa **Solicitado**,
não **Concluído**. Falha ao solicitar um workflow não desfaz o valor já salvo
no Environment: o painel retorna o erro e oferece link para o Actions.
O fluxo `config-sync.yml` verifica o hash do Environment no início: se
outro usuário editou a variável depois, interrompe para não aplicar
uma versão obsoleta. A identidade GCP continua via WIF sem chaves.

**Escopo:** o gatilho automático vale para alterações salvas na aba
Ambiente do Manage. Mudanças diretamente em GitHub Settings, via CLI ou
em versões do Secret Manager não produzem evento `push` e devem ser
aplicadas pelos workflows correspondentes.

## Sentry

Add extra_environment.SENTRY_ORG (public Sentry organization slug) and
workflow_secrets.MANAGE_SENTRY_API_TOKEN to see up to 30 recent unresolved
issues. Use a read-only Sentry token with org/project read permissions.
The token is used only on the Worker; never add VITE_SENTRY_API_TOKEN.

## Local development

    cd apps/manage
    npm ci
    npm run typecheck
    npm test
    npm run dev

For actual provider APIs, configure a local Cloudflare Worker with a safe
.dev.vars file (without the space), copied from .dev.vars.example.
The Vite UI proxies /api to the local Wrangler port 8788.

## Guardrails

- Cloudflare Access signed RS256 JWT, required issuer, separate manage
  audience, expiry and allowlisted email on every request, including assets.
- Same-origin write requests only, JSON content type, bounded payloads.
- Backend workflow allowlist; restricted inputs, required explicit confirmation.
- GCP_CONFIG_ENV concurrent editing uses SHA-256 and refuses stale versions
  (409). Existing secrets remain in GCP Secret Manager, never fetched via the
  editor.
- GitHub and cloud provider credentials reside only in Worker secrets, pinned
  Secret Manager versions and never in scripts or API responses.
- Sensitive logs sanitized and bounded; provider errors never return raw response
  bodies or secrets.
- No direct mutation of Cloud Run resources, R2 buckets or Access policies from
  the browser. Cloud deploys happen through established GitHub Actions workflows
  with their own WIF identities and validation gates.

Sources: GitHub REST Actions/Variables; Cloudflare Access and Workers
Observability REST API; Google Security Token Service and Cloud Run/Logging.
