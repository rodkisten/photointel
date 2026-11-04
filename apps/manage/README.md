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

## Sentry · Manage (one DSN, no new API token)

PhotoIntel Manage has an **independent Sentry project**, separate from PhotoIntel
frontend and Python. Add **one public DSN** to the existing
production `GCP_CONFIG_ENV` dotenv editor:

```dotenv
MANAGE_SENTRY_DSN=https://PUBLIC_KEY@o123.ingest.sentry.io/PROJECT_ID
```

The prefixed `EXTRA_ENVIRONMENT__MANAGE_SENTRY_DSN` spelling is also supported.
In JSON, use `extra_environment.MANAGE_SENTRY_DSN`.
Never replace the main PhotoIntel `SENTRY_DSN` or `VITE_SENTRY_DSN`.

Save with auto-apply: **only Manage** is rebuilt and republished.
The same DSN is sent to the independent Manage Cloudflare Worker
(`SENTRY_DSN`) and injected into the Vite browser build
(`VITE_MANAGE_SENTRY_DSN`). It is a public ingestion key, **not** an API token.
It captures browser uncaught/render/promise errors and server-side Access,
GitHub, GCP and Cloudflare failures, including failures swallowed by
`Promise.allSettled`. The UI shows correlation IDs and event references;
provider credentials and Cloudflare Access JWTs are not sent.

The existing `extra_environment.SENTRY_ORG` is reused for links;
`workflow_secrets.MANAGE_SENTRY_API_TOKEN` remains **optional** and is only
needed to list unresolved issues in the Manage Logs tab. If that existing
read-only token is absent, events still reach the new Sentry project, and you
can open issues directly in the Sentry dashboard. Do not create
`VITE_SENTRY_API_TOKEN` or expose read tokens in the browser.

The initial `Manage · Publish → apply` can also activate a new DSN if
automatic Manage publishing is disabled. A successful CI build is not proof of
ingestion: verify a real new occurrence in Sentry after publication.

## Diagnóstico de token efetivo (GitHub e Cloudflare)

Abra **Sistema → Diagnóstico de credenciais → Testar credenciais**.
O teste roda no Worker autenticado, nunca no navegador, usando os mesmos
`GITHUB_API_TOKEN` e `CLOUDFLARE_API_TOKEN` que estão instalados no runtime.
Ele consulta via GET o repositório, as execuções, os workflows, a variável
`production/GCP_CONFIG_ENV` e os Workers Cloudflare. Retorna HTTP status,
uma causa classificada e, quando o GitHub fornece, o header seguro
`X-Accepted-GitHub-Permissions`. Não retorna valores de variáveis nem tokens.

O campo **Secret Manager versão** mostra a versão da referência
`WORKFLOW_SECRETS__MANAGE_GITHUB_API_TOKEN__VERSION` usada **no último deploy**.
Mudar uma referência no `.env` não atualiza o segredo do Worker sem publicar
`Manage · Publish → apply`. O workflow agora publica automaticamente em
pushes para `main` que afetem exclusivamente o Manage; o primeiro apply
manual já foi realizado.

- GitHub `403`: diferencie token inválido, acesso ao repositório,
  SSO, limite de API ou permissão faltante pela resposta do teste. As chamadas
  Actions exigem permissão Actions (read/write conforme o verbo).
  A configuração `GCP_CONFIG_ENV` usa Environments (read/write).
- Cloudflare `400/9106`: falha de autenticação, não simplesmente lista
  vazia de Workers. Confirme a versão do secret
  `MANAGE_CLOUDFLARE_API_TOKEN` instalada, sem trocar o token usado pelo deploy.
- Na publicação, uma checagem não destrutiva desses dois secrets é incluída
  no resumo do GitHub Actions, sem registrar o conteúdo dos tokens.
- Chaves `.env` repetidas **com o mesmo valor** são preservadas com seus
  comentários, e o editor mostra os números das linhas. Chaves repetidas
  com valores diferentes continuam sendo recusadas.

## Secret Manager no painel

Na aba **Secrets**, o Manage consulta o inventário do Google Secret Manager no
projeto fixo photointel e cruza todos os secrets com as referências em
production/GCP_CONFIG_ENV, tanto SECRETS__* (API e jobs) quanto
WORKFLOW_SECRETS__*. Agora os secrets sem referência também aparecem.
Um item ausente no GCP é marcado "Ausente"; uma referência não verificada
por falta de IAM é marcada "Não verificado". O nome conhecido
ICLOUD_SESSION_KEY → photointel-session-aead-key é exibido mesmo que a
referência esteja ausente do .env, para orientar a recuperação.

O fluxo mobile oferece busca por nome/variável, link direto com
`?tab=secrets&secret=ICLOUD_SESSION_KEY`, histórico paginado de versões,
estados ENABLED/DISABLED/DESTROYED, visualização segura de apenas três caracteres
do início e três do fim do payload (ou máscara integral para dados binários/
multilinha), adição de versões de até 64 KiB e criação de containers com prefixo
photointel-. É possível escolher e **ativar uma versão ENABLED anterior** no
GCP_CONFIG_ENV sem copiar ou revelar seu valor. Versões anteriores são
preservadas; não existe função de apagar/destruir/desabilitar no Manage.

Ao adicionar uma versão, a opção de atualizar as referências existentes no .env
é separada da criação em GCP. Para referências existentes, a atualização é
otimista pelo hash SHA-256, preservando comentários e demais linhas .env;
todas as referências desse mesmo secret são reconciliadas. Os workflows
aplicáveis são solicitados, não necessariamente concluídos. Secrets sem
referência podem receber versões, mas só entram em produção após vincular
NAME e VERSION na aba Ambiente. Criar container também não cria referências
automaticamente.

**Permissões necessárias:** abra a aba Secrets e use **Sincronizar IAM**,
ou execute **🧱 Setup GCP → permissions** na main após atualizar o código.
O botão solicita o workflow privilegiado e exibe link para acompanhá-lo;
não apresenta o dispatch como se a execução já tivesse terminado. O bootstrap concede à identidade Access-allowlisted
photointel-manage@photointel.iam.gserviceaccount.com, somente no projeto
photointel, as funções roles/secretmanager.viewer,
roles/secretmanager.secretAccessor e roles/secretmanager.secretVersionAdder.
Essas permissões dão leitura de payloads e criação de versões em **todos**
os segredos do projeto, um aumento deliberado de privilégio pedido para este
painel de administração. O worker expõe ao navegador apenas trechos mascarados.
Para criar containers, o bootstrap instala um papel IAM customizado
photointelManageSecretCreator, contendo exclusivamente a permissão
secretmanager.secrets.create. Não concede Secret Manager Admin/Editor, alteração
de IAM pelo Worker nem destruição de versões.

O bootstrap também deve ser executado novamente sempre que a configuração
de identidade ou a federação Cloudflare Access mudar. Se o inventário não
aparecer, o painel explica a necessidade de atualizar IAM em vez de apresentar
uma lista falsamente vazia.

**Atenção ao iCloud:** ICLOUD_SESSION_KEY não é a senha da Apple. O payload
precisa conter 32 bytes aleatórios em base64 (normalmente 44 caracteres).
O formulário valida o tamanho e permite gerar uma chave AES-256, mas uma
nova chave perde a capacidade de descriptografar sessões e manifests antigos.
O botão de atualizar referências começa desmarcado para esse secret. Prefira
ativar a **versão original** caso ainda exista.

Os valores integrais não são retornados à UI, logs ou Sentry. A criação de
novas versões ou containers exige confirmação explícita na sessão protegida
pelo Cloudflare Zero Trust Access.

## Estrutura modular do frontend

`src/App.tsx` é o layout persistente com topbar, sidebar e bottom nav.\n`src/router.tsx` define as rotas tipadas usando TanStack Router (configuração em código,\nsem geração automática). Telas em `src/pages/`,
componentes comuns em `src/components/` e o editor de Secret Manager
em `src/features/secrets/` (lista, cartão da versão, formulário,
orquestração e tipos). O backend do editor fica separado entre
`src/routes/secrets.ts` e `src/secret-manager.ts`.

## JSON View, ScrollArea e CodeMirror 6

O visualizador comum `src/components/json-view.tsx` segue os padrões
documentados no **Geist JSON View**: árvore recolhível, chaves e valores
com coloração por tipo, `defaultExpandDepth`, pesquisa por texto literal
com `highlightPattern`, navegação por botões acessíveis e cópia do dado.
É uma implementação local do padrão visual e interativo, não um pacote
proprietário importado do site da Vercel. JSON válido é interpretado como
objeto ou array; outros logs são apresentados como texto sem perder conteúdo.
A árvore evita abrir automaticamente mais de 1.200 propriedades por nó.

`src/components/scroll-area.tsx` implementa ScrollArea do shadcn/Radix
com scrollbars vertical e horizontal. É compartilhado por logs GitHub,
Cloudflare, GCP, Sentry e estruturas JSON.

O editor do Environment GitHub, em
`src/components/codemirror-env-editor.tsx`, usa **CodeMirror 6** com
`@codemirror/lang-json` e modo de tokens dotenv. Seleciona o modo pelo
conteúdo de `GCP_CONFIG_ENV`, oferece highlighting, busca e lint JSON.
O editor não normaliza linhas, strings, comentários nem quebras no dotenv.
O backend continua usando validação, optimistic hash e planejamento
de deploy antes de salvar. A fonte do editor usa 16px para evitar zoom
automático ao focar no iOS.

Os componentes usam dependências instaladas e travadas no
`apps/manage/package-lock.json`, sem ESM/CDN externo.

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

## Navegação TanStack Router

O Manage usa URLs próprias e histórico do navegador para todas as páginas:

| Tela | Rota |
| --- | --- |
| Visão geral | `/` |
| Deploys e execuções | `/deploys`, `/deploys/$runId` |
| Logs (provedor e investigação) | `/logs?source=gcp&correlation=...` |
| Ambiente | `/environment` |
| Secrets | `/secrets` |
| iCloud | `/icloud` |
| Sistema | `/system` |

Links legados `/?tab=...` de PhotoIntel, GitHub Actions e Telegram
são redirecionados, mantendo parâmetros de logs (job, correlation, ray,
entry, event e período). Use `<Link>` e `useNavigate` para novas
navegações internas; não modifique `window.history` diretamente.
A aplicação continua protegida pelo Cloudflare Access inclusive em URLs
abertas diretamente ou após recarregar.

## Painel de custos (GitHub, GCP, Cloudflare Workers e Modal)

`/costs` mostra custos por mês, fontes verificadas e incompletas,
cota do GitHub Actions, detalhamento do GCP, workloads Modal e uso dos Workers.
As telas `/deploys`, detalhes de run e Visão geral exibem tempo de execução e
**estimativa bruta** por job. O cálculo usa minutos arredondados por job,
o runner indicado pelo GitHub e preços oficiais consultados em novembro/2026.
Um workflow não corresponde ao valor cobrado pelo GCP durante o deploy.
Execuções self-hosted ou runners sem tarifa identificável permanecem indisponíveis;
subtotal parcial é identificado por `≥`.

**GitHub:** o Worker consulta a Billing Usage Summary API (com filtro por repositório)
e só exibe valor oficial quando encontra itens de Actions. Consulta separadamente o\nconsumo de Actions de toda a conta para calcular a cota, sem somar outros\nrepositórios ao gasto do PhotoIntel. Conta pessoal pode
não disponibilizar esses dados nesta API. Use um token que tenha também o acesso
de Billing exigido pela conta ou organização (Plan:read para conta pessoal,\nAdministration:read para organização). Os endpoints antigos `/timing`
não são usados porque foram descontinuados. Em `GCP_CONFIG_ENV` no formato dotenv:

```dotenv
EXTRA_ENVIRONMENT__MANAGE_GITHUB_BILLING_OWNER=rodkisten
EXTRA_ENVIRONMENT__MANAGE_GITHUB_BILLING_SCOPE=users
EXTRA_ENVIRONMENT__MANAGE_GITHUB_ACTIONS_INCLUDED_USD=12
```

O último valor **é apenas um exemplo**. Ajuste à franquia em USD do seu plano
(Free, Pro, Team etc.). Não é seguro assumir uma cota de minutos fixa nem
deduzir automaticamente o plano pelo repositório.

**GCP:** habilite na conta Cloud Billing a exportação **Standard** ou **Detailed**
para BigQuery. A exportação não é retroativa e pode sofrer atraso. Configure
a tabela real (substitua os valores de exemplo):

```dotenv
EXTRA_ENVIRONMENT__MANAGE_GCP_BILLING_TABLE=photointel.billing.gcp_billing_export_v1_ACCOUNT_ID
```

O Manage consulta somente lançamentos com `project.id=photointel` e agrega
`cost + credits`. O orçamento de processamento da query é limitado a 100 MB.
`🧱 Setup GCP → permissions` atualiza `roles/bigquery.jobUser` e
`roles/bigquery.dataViewer` na conta `photointel-manage` para o projeto local;
`apply` também habilita a API BigQuery. Se a exportação estiver em outro
projeto, dê `bigquery.dataViewer` **no dataset** daquele projeto e
`bigquery.jobUser` no projeto que executa as queries, sem abrir acesso global.
O bootstrap não cria exportações do Cloud Billing nem altera contas de cobrança.

**Cloudflare:** o adaptador lê Analytics GraphQL com permissão de **Account
Analytics:Read**, agrupando requests por Worker. Exibe por Worker um valor
**hipotético marginal** a US$ 0,30/milhão de requests. Não inclui franquia,
CPU, Workers subscription, R2/D1, outros produtos nem representa a fatura:
por isso não soma Cloudflare ao total oficial.

**Modal:** requer plano Team/Enterprise para billing programático.
Crie um secret Modal `photo-intelligence-billing` com
`MANAGE_COSTS_TOKEN` gerado aleatoriamente (32+ caracteres) e execute:

```sh
uv run --group gpu modal deploy gpu/modal_billing.py
```

Depois configure a URL real do endpoint e referencie o **mesmo token** de maneira
segura no Google Secret Manager, sem colocá-lo em plaintext no dotenv:

```dotenv
EXTRA_ENVIRONMENT__MANAGE_MODAL_BILLING_URL=https://YOUR-ENDPOINT.modal.run/report
WORKFLOW_SECRETS__MANAGE_MODAL_BILLING_TOKEN__NAME=photointel-manage-modal-billing-token
WORKFLOW_SECRETS__MANAGE_MODAL_BILLING_TOKEN__VERSION=1
```

O Manage valida domínio HTTPS `*.modal.run` e encaminha o token exclusivamente
no backend. O endpoint Modal chama `Workspace.billing.summary()` (faturado após
ajustes) e `Workspace.billing.report()` (detalhamento antes de ajustes).
Se o plano não expõe a API, o painel indica ausência, **não** US$ 0.

Depois de editar as variáveis, execute o workflow `🚀 Manage · Publish`.
Os dados de billing e tokens nunca são armazenados no frontend. O total geral
permanece marcado **parcial** enquanto nem todas as fontes tiverem valores de
fatura comparáveis em USD; moedas diferentes não são convertidas implicitamente.

Fontes de preços e APIs:
- https://docs.github.com/en/billing/reference/actions-runner-pricing
- https://docs.github.com/en/rest/billing/usage
- https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery
- https://developers.cloudflare.com/workers/platform/pricing/
- https://modal.com/docs/guide/billing
