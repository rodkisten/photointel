# Photo Intelligence Cloud: do zero ao deploy (Google Cloud + GitHub Actions)

> Guia operacional para o repositório `rodkisten/photointel`, projeto GCP `photointel`, região `us-central1` e branch `main`. A execução de comandos que criam recursos **pode gerar cobranças**. Nada aqui autoriza o uso automático de recursos ou a importação de fotos pessoais.
>
> **Ordem segura:** configuração local → serviços externos → configuração de produção → bootstrap com operador administrativo → versões dos secrets → WIF/IAM → GitHub Environment → build → Jobs → migração controlada → API → Cloudflare → testes → Scheduler (pausado).

## 0. Pré-requisitos

- Contas Google Cloud (projeto `photointel` com faturamento autorizado), GitHub (repositório `rodkisten/photointel`), Neon, Cloudflare e R2; Modal é opcional e começa desabilitado.
- Uma identidade humana com privilégios administrativos **somente para o primeiro bootstrap**. Não dê Owner/Editor ou administração permanente ao `photointel-deployer`.
- Cloud Shell ou terminal Linux com `gcloud`, Python 3.12, Git e acesso ao código. No Codespaces, use o Dev Container; o `gcloud` não está disponível diretamente no a-Shell iOS.
- Defina alertas de cobrança, quotas e limites de instâncias. Alertas não interrompem automaticamente o faturamento. Consulte [COST_MODEL.md](../../COST_MODEL.md) e [LIMITATIONS.md](../../LIMITATIONS.md).
- Migrações de banco só são executadas com **`action=migrate`, `migration_mode=apply`** e confirmações explícitas. O modo `release` nunca migra; bases existentes exigem recibo válido de backup e restauração.

## 1. Desenvolvimento local e BUILD_CA_FILE

`BUILD_CA_FILE` é o **caminho de um arquivo PEM/CRT de CAs confiáveis**, não um token nem uma chave privada. O Docker Compose injeta esse arquivo como secret BuildKit `build_ca` apenas durante o build, sem desativar TLS ou incorporá-lo à imagem.

| Host do Docker Compose | Valor recomendado |
|---|---|
| Ubuntu, Linux, WSL2 Ubuntu, Codespaces | `/etc/ssl/certs/ca-certificates.crt`, normalmente já existente |
| macOS | Caminho absoluto retornado por `python3 -c "import certifi; print(certifi.where())"` após instalar `certifi` |
| Windows nativo com PowerShell | Caminho absoluto retornado por `py -c "import certifi; print(certifi.where())"`, preferencialmente via WSL2 |
| Ambiente com proxy TLS corporativo | Bundle confiável que inclui a CA aprovada do proxy, sem suprimir validação TLS |

Em Ubuntu/Codespaces:

```bash
ls -lh /etc/ssl/certs/ca-certificates.crt
# Caso não exista:
sudo apt-get update && sudo apt-get install -y ca-certificates
sudo update-ca-certificates
```

No `.env` da raiz, mantenha `BUILD_CA_FILE=/etc/ssl/certs/ca-certificates.crt` (ou adapte ao caminho no **host**, não no contêiner). Se existir proxy empresarial, obtenha a CA com o administrador da rede; não gere uma CA aleatória.

```bash
make setup                             # cria .env privado e instala dependências
make dev                               # Postgres, MinIO, API, jobs locais, web
docker compose --env-file .env -f infra/docker/compose.dev.yml config --quiet
make doctor
```

PWA local: `http://localhost:5173`; API: `http://localhost:8000`. Para Codespaces no iPhone, mantenha a porta 5173 **Private** e use `python3 infra/scripts/setup-env.py --codespaces-origin` quando a origem mudar. `make stop` preserva os dados.

## 2. Preparar Google Cloud e serviços externos

No [Cloud Console](https://console.cloud.google.com/home/dashboard?project=photointel), confirme **Project ID** `photointel` e **Project Number** `799387180206` (os dois não são intercambiáveis). No [Billing](https://console.cloud.google.com/billing?project=photointel), revise a conta de cobrança, orçamento e alertas. Escolha `us-central1` como região desta instalação.

No [Cloud Shell](https://shell.cloud.google.com/), usando sua conta humana:

```bash
gcloud config set project photointel
gcloud projects describe photointel --format="value(projectNumber)"
gcloud auth list
git clone https://github.com/rodkisten/photointel.git
cd photointel
git checkout main
```

Se o repositório não for público, autentique seu Git normalmente. Não crie credenciais JSON permanentes de service accounts.

Antes de ativar o deployment, prepare:

1. **Neon:** crie PostgreSQL, obtenha URLs `pooled` para a API e `direct` para migrações, com TLS e roles separadas. [NEON_SETUP.md](../../NEON_SETUP.md).
2. **Cloudflare R2:** crie bucket **privado**, endpoint `https://ACCOUNT.r2.cloudflarestorage.com` e par de credenciais restritas ao bucket. Guarde Access Key ID/Secret Access Key apenas em Secret Manager, nunca em `GCP_CONFIG_ENV`.
3. **Cloudflare Zero Trust:** crie aplicação *Self-hosted* para o domínio escolhido (por exemplo, `photos.migos.club`), política Allow para o e-mail autorizado e copie **Team domain** (ex.: `equipe.cloudflareaccess.com`) e **Application AUD tag**. Configure a aplicação separada Service Auth do Bridge apenas se for utilizá-lo. [CLOUDFLARE_SETUP.md](../../CLOUDFLARE_SETUP.md).
4. **Cloudflare Pages/Worker:** serão publicados **depois** da API existir e informar o `run.app` real. Não publique a API pessoal sem autenticação verificada.

## 3. Fonte única de configuração: GCP_CONFIG_ENV

O workflow `.github/workflows/gcp-deploy.yml` usa **exclusivamente** a variável multiline `vars.GCP_CONFIG_ENV` do GitHub Environment `production`. O conversor `infra/gcp/gcp-env.py` transforma esse dotenv em `infra/gcp/config.local.json`, acrescenta o SHA da revisão e envia ao GitHub os identificadores WIF. **Não** usa `GCP_CONFIG_JSON`, `GCP_CONFIG_SECRET` nem uma chave Google JSON.

Modelo de valores não secretos (substitua TODOS os placeholders pelos valores reais e preserve o formato):

```dotenv
PROJECT_ID=photointel
REGION=us-central1
REPOSITORY=photointel
FRONTEND_ORIGIN=https://photos.migos.club
API_ORIGIN=https://photos.migos.club
ACCESS_TEAM_DOMAIN=sua-equipe.cloudflareaccess.com
ACCESS_AUDIENCE=COLE_O_AUD_REAL
ACCESS_ALLOWED_EMAILS=json:["seu-email@exemplo.com"]
STORAGE_ENDPOINT=https://seu-account-id.r2.cloudflarestorage.com
STORAGE_BUCKET=photointel
ENABLE_ICLOUD=json:false
ENABLE_GPU=json:false
ICLOUD_ACCOUNT=
ICLOUD_LIBRARY=
API_MAX_INSTANCES=json:3
API_CONCURRENCY=json:8
API_TIMEOUT_SECONDS=json:300
JOB_TASK_COUNT=json:1
JOB_PARALLELISM=json:1
JOB_MAX_JOBS=json:100
JOB_DEADLINE_SECONDS=json:2400
JOB_TIMEOUT_SECONDS=json:2700
SCHEDULER_TIMEZONE=Etc/UTC
DISCOVERY_SCHEDULE=0 * * * *
WORKER_SCHEDULE=*/10 * * * *
MAINTENANCE_SCHEDULE=17 */6 * * *
DATABASE_PROFILE=limited
DATABASE_CATALOG_LIMIT=json:1000
SECRETS__DATABASE_URL__NAME=photointel-database-url
SECRETS__DATABASE_URL__VERSION=1
SECRETS__MIGRATION_DATABASE_URL__NAME=photointel-migration-database-url
SECRETS__MIGRATION_DATABASE_URL__VERSION=1
SECRETS__STORAGE_ACCESS_KEY__NAME=photointel-r2-access-key
SECRETS__STORAGE_ACCESS_KEY__VERSION=1
SECRETS__STORAGE_SECRET_KEY__NAME=photointel-r2-secret-key
SECRETS__STORAGE_SECRET_KEY__VERSION=1
SECRETS__BRIDGE_TOKEN_PEPPER__NAME=photointel-bridge-pepper
SECRETS__BRIDGE_TOKEN_PEPPER__VERSION=1
SECRETS__BRIDGE_ENROLLMENT_SECRET__NAME=photointel-bridge-enrollment
SECRETS__BRIDGE_ENROLLMENT_SECRET__VERSION=1
SECRETS__ICLOUD_SESSION_KEY__NAME=photointel-session-aead-key
SECRETS__ICLOUD_SESSION_KEY__VERSION=1
EXTRA_ENVIRONMENT=json:{}
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/799387180206/locations/global/workloadIdentityPools/github-actions/providers/photo-intelligence
GCP_DEPLOY_SERVICE_ACCOUNT=photointel-deployer@photointel.iam.gserviceaccount.com
```

Regras importantes:

- Campos com `json:` viram booleanos, inteiros, arrays ou objetos; `SECRETS__...__VERSION` é uma **string numérica**, não `json:1` nem `latest`.
- `SECRETS__...__NAME` guarda **somente o nome do secret**, não senha, URL de conexão, R2 Access Key nem caminho de recurso Google.
- O provider correto neste projeto é `photo-intelligence`; `photointel` é **outro** identificador e produziu `invalid_target` anteriormente.
- O e-mail da service account usa o **Project ID** (`photointel`), não o número `799387180206`.
- Se habilitar iCloud, configure conta/biblioteca e valide o fluxo de sessão separadamente; não ligue por padrão.
- Se habilitar o Bridge, use `EXTRA_ENVIRONMENT__ACCESS_BRIDGE_AUDIENCE=...` e `EXTRA_ENVIRONMENT__ACCESS_BRIDGE_SERVICE_TOKENS=[...]` **como string JSON**, somente com Client IDs públicos; Client Secret do dispositivo fica no Keychain.
- Versões diferentes de secrets exigem atualizar a variável quando houver rotação.

Para usar exatamente a mesma configuração no Cloud Shell, salve o texto acima num arquivo privado **fora do Git**, por exemplo em `$HOME/photointel-production.env`, com permissão `0600`. No diretório do repositório:

```bash
chmod 600 "$HOME/photointel-production.env"
python3 -m venv "$HOME/.venvs/photointel-gcp"
source "$HOME/.venvs/photointel-gcp/bin/activate"
python -m pip install python-dotenv==1.2.4
export GCP_CONFIG_ENV="$(cat "$HOME/photointel-production.env")"
export CONFIRM_PROJECT=photointel
export RELEASE_SHA="$(git rev-parse HEAD)"
python3 infra/gcp/gcp-env.py
python3 infra/gcp/manage.py render
python3 infra/gcp/manage.py bootstrap               # plano offline, sem mutação
```

O exemplo `config.example.json` é outro ponto de partida possível, mas requer preencher manualmente `image` e `release_git_sha`, além dos demais campos. `config.local.json` é privado e fica fora do Git.

## 4. Bootstrap com GitHub Actions (fluxo preferencial)

Foi criado um [workflow administrativo idempotente](https://github.com/rodkisten/photointel/actions/workflows/gcp-bootstrap.yml), separado do deploy, que utiliza a conta `photointel-bootstrap` e comandos `gcloud` para verificar e criar recursos ausentes. Antes do primeiro uso, crie uma vez a conta e a confiança WIF com sua identidade humana. Consulte [passo a passo do bootstrap administrativo](GCP_BOOTSTRAP_ACTION.md). O modo `plan` não altera recursos; `apply` exige autorização explícita. O deploy normal não oferece mais a opção `bootstrap`.

A alternativa abaixo é a execução inicial no Cloud Shell pela conta humana administradora.

## 4. Bootstrap: uma única vez com operador administrativo

**Recomendado:** execute o `bootstrap` no Cloud Shell com sua identidade **humana** administradora, não pelo token WIF do `photointel-deployer`. A conta Deployer é criada/configurada pelo próprio bootstrap, então tentar usá-la para conceder seu próprio IAM gera um ciclo de privilégios.

O operador pode precisar de permissões para habilitar APIs (Service Usage Admin), criar Artifact Registry, GCS, Service Accounts e secrets, e alterar IAM em nível de projeto/recurso. Essas permissões são **temporárias e administrativas**, não concedidas aos usuários de execução.

```bash
# Primeiro conferir o plano:
python3 infra/gcp/manage.py bootstrap

# Depois de revisar recursos, políticas, billing e escopo:
python3 infra/gcp/manage.py bootstrap \
  --apply --authorize-charges --confirm-project photointel
```

O bootstrap implementado em `infra/gcp/manage.py`:

- Habilita Run, Scheduler, Secret Manager, Artifact Registry, Cloud Build, IAM, IAM Credentials e STS.
- Cria o repositório **Docker privado** `photointel` em `us-central1`, caso não exista.
- Cria seis service accounts: `photointel-api`, `photointel-jobs`, `photointel-migrate`, `photointel-scheduler`, `photointel-builder` e `photointel-deployer`.
- Cria as **referências vazias** dos secrets; não preenche valores.
- Cria o bucket de upload de código `gs://photointel-photointel-build-source` e configura IAM do bucket, repositório, runtime e deploy.

O bucket existente pode estar na multirregião `US`: **não o recrie** somente porque o projeto usa `us-central1` para Artifact Registry. Verifique o estado real antes de rodar bootstrap novamente.

### Permissões esperadas depois do bootstrap

| Quem | Onde | Papel |
|---|---|---|
| `photointel-builder` | Bucket de staging | `roles/storage.objectViewer` |
| `photointel-builder` | Repositório Artifact Registry `photointel` em `us-central1` | `roles/artifactregistry.writer` |
| `photointel-builder` | Projeto (Cloud Logging) | `roles/logging.logWriter` |
| `photointel-deployer` | Bucket de staging | `roles/storage.objectAdmin` |
| `photointel-deployer` | Projeto | `roles/cloudbuild.builds.editor`, `roles/run.admin`, `roles/cloudscheduler.admin`, `roles/artifactregistry.reader` |
| `photointel-deployer` | Contas `api`, `jobs`, `migrate`, `scheduler` e **`builder`** | `roles/iam.serviceAccountUser` |
| `api`, `jobs`, `migrate` | Cada Secret Manager pertinente | `roles/secretmanager.secretAccessor`, conforme `bootstrap()` |

O `bootstrap()` atual também concede **`roles/serviceusage.serviceUsageConsumer`** ao Deployer para o uso de APIs, mas **não** concede poderes de habilitar serviços. Se o bootstrap executado antes desta revisão não concluiu essa etapa, o operador autorizado pode regularizar com:

```bash
gcloud projects add-iam-policy-binding photointel \
  --member="serviceAccount:photointel-deployer@photointel.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer" --quiet
```

**Service Usage Consumer não habilita APIs**. Para `serviceusage.services.enable`, o operador de bootstrap precisa de `roles/serviceusage.serviceUsageAdmin`. Se escolher `bootstrap` no GitHub Actions, a identidade federada precisa de todas as permissões administrativas acima. **Não mantenha esses poderes no Deployer após o provisionamento.**

## 5. Popular Secret Manager (sem imprimir credenciais)

Com o bootstrap concluído, use o comando interativo do projeto. Ele usa prompt oculto e `--data-file=-`, sem gravar o valor no JSON:

```bash
for secret in DATABASE_URL MIGRATION_DATABASE_URL STORAGE_ACCESS_KEY STORAGE_SECRET_KEY BRIDGE_TOKEN_PEPPER BRIDGE_ENROLLMENT_SECRET ICLOUD_SESSION_KEY; do
  echo "Adicionando versão para $secret"
  python3 infra/gcp/manage.py secret-add --secret "$secret" \
    --apply --authorize-charges --confirm-project photointel
done
```

Valores: conexão Neon pooled, conexão Neon direct, credenciais R2 restritas, pepper aleatório, segredo de matrícula aleatório e chave AES-GCM de **32 bytes codificados em base64**. Para gerar somente estas últimas no seu terminal privado:

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'        # pepper e enrollment: gerar valores DISTINTOS
python3 -c 'import base64,secrets; print(base64.b64encode(secrets.token_bytes(32)).decode())'
```

**Não** cole saídas de secrets no GitHub Variables, no README, nos logs, no shell history ou nos tickets. Se credenciais R2 já foram expostas, **revogue e gere novas** antes do deploy.

Verifique os números reais das versões e atualize `SECRETS__...__VERSION` na configuração. O `bootstrap` cria apenas o contêiner do secret; a **versão 1 não passa a existir** até incluir o valor.

## 6. Workload Identity Federation (GitHub → Google sem chave JSON)

Configuração verificada neste projeto: Pool `github-actions`, Provider `photo-intelligence`, ambos em `global`; projeto numérico `799387180206`. Crie somente se ainda não existirem.

O Google Cloud precisa confiar **apenas** no repositório, branch e environment corretos. No Cloud Shell, com conta administrativa:

```bash
PROJECT=photointel
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud iam workload-identity-pools list --project="$PROJECT" --location=global
gcloud iam workload-identity-pools providers list \
  --project="$PROJECT" --location=global --workload-identity-pool=github-actions
```

Se forem inexistentes, crie com IDs **exatos**:

```bash
gcloud iam workload-identity-pools create github-actions \
  --project=photointel --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc photo-intelligence \
  --project=photointel --location=global \
  --workload-identity-pool=github-actions \
  --display-name="Photo Intelligence" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository=='rodkisten/photointel' && assertion.ref=='refs/heads/main' && assertion.environment=='production'"
```

Se o provider já existir, **não** execute `create-oidc`: confira a configuração dele no Console antes de alterar uma relação de confiança existente.

Conceda `Workload Identity User` **na conta Deployer** para o principalSet do repo:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  photointel-deployer@photointel.iam.gserviceaccount.com \
  --project=photointel \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/rodkisten/photointel"
```

O uso de `environment: production` na job e o `id-token: write` são necessários no GitHub. O provider de produção também deve rejeitar refs não-main e outros repositórios. Nunca permita `attribute.repository_owner` sozinho ou todos os repositórios GitHub.

Referências Google: [WIF com pipelines](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) e [service accounts no Cloud Build](https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts).

## 7. Configurar GitHub Environment e workflows

No GitHub, abra `Settings → Environments → New environment → production`. Configure **Required reviewers** se seu plano/repositório permitir, restrinja a deployment branch a `main` e exija revisão dos valores.

Em `production → Environment variables`, crie **uma variável multiline**:

| Nome | Conteúdo |
|---|---|
| `GCP_CONFIG_ENV` | O bloco dotenv completo da seção 3, incluindo os dois identificadores WIF. **Somente parâmetros públicos e nomes/versões de secrets.** |

Não armazene `GCP_CONFIG_ENV` como GitHub secret se o workflow permanecer usando `vars.GCP_CONFIG_ENV`; ajustar o local de armazenamento exige atualizar a expressão no workflow. A **credencial** de cada Secret Manager permanece no Google, não no GitHub.

Workflows:

| Arquivo | Quando roda | Faz |
|---|---|---|
| `.github/workflows/gcp-validation.yml` | PR/push em arquivos relevantes ou manual | Testes offline, render, plano de bootstrap; **não** autentica no Google |
| `.github/workflows/gcp-deploy.yml` | **Somente** `workflow_dispatch` na `main` + `production` + checkbox de cobrança | Autentica com WIF e executa **uma** operação selecionada |
| `.github/workflows/gcp-deploy.yml` `bootstrap` | Manual, somente se autorizou IAM administrativo temporário | Provisiona recursos; **prefira o Cloud Shell para esta etapa** |

O job gera `config.local.json` privado a partir da variável, calcula imagem tagueada com o SHA do próprio checkout, autentica via `google-github-actions/auth@v2`, instala `gcloud` e executa `manage.py`. Não cria chave JSON persistente. A opção `authorize_charges` começa **desmarcada**.

## 8. Preflight antes de gastar com um novo build

Depois de IAM, secrets e WIF, no Cloud Shell:

```bash
PROJECT=photointel
gcloud services list --enabled --project="$PROJECT" \
  --filter="config.name=cloudbuild.googleapis.com" --format='value(config.name)'
gcloud storage buckets describe "gs://$PROJECT-photointel-build-source" \
  --project="$PROJECT" --format='value(name,location)'
gcloud iam service-accounts describe \
  "photointel-builder@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT"
gcloud artifacts repositories describe photointel \
  --location=us-central1 --project="$PROJECT"
```

No IAM verifique especificamente:

- `deployer` pode gravar no bucket. Um bucket existir **não** prova permissão de upload.
- `deployer` tem `iam.serviceAccounts.actAs` na **builder** via `roles/iam.serviceAccountUser`. Sem isso: `caller does not have permission to act as service account`.
- `builder` tem **Writer** no repositório Docker e **Logs Writer** no projeto. Sem o repositório: `name unknown: Repository "photointel" not found`.
- `deployer` tem **Reader** no Artifact Registry. O `manage.py` verifica o digest por `gcloud artifacts docker images list --include-tags --format=json`; não precisa `containeranalysis.occurrences.list`.

Uma conta builder **não é criada** por `build`. Execute bootstrap administrativo antes, ou crie/configure manualmente com os papéis acima.

## 🧩 Scripts do release separados do GitHub Actions

O [YAML do deploy](https://github.com/rodkisten/photointel/blob/main/.github/workflows/gcp-deploy.yml) **não contém blocos Bash ou Python inline**. Ele define permissões, `vars.GCP_CONFIG_ENV`, inputs, condições e ordem das fases. Toda execução chama arquivos versionados:

| Arquivo | Responsabilidade |
|---|---|
| [`infra/gcp/release.sh`](../../infra/gcp/release.sh) | Entrypoint Bash, gates de segurança, dispatch das fases `gate`, `preflight`, `cache`, `build`, `verify`, `jobs-deploy`, `deploy`, `scheduler` e `cleanup` |
| [`infra/gcp/release_image.py`](../../infra/gcp/release_image.py) | Preflight do Cloud Build, consulta read-only ao Artifact Registry, validação de SHA/digest e output `skip=true/false` para reutilizar builds |
| [`infra/gcp/manage.py`](../../infra/gcp/manage.py) | Executa comandos de publicação `gcloud`, com verificação de flags de autorização |
| [`.github/actions/gcp-config/action.yml`](../../.github/actions/gcp-config/action.yml) | Reutiliza `vars.GCP_CONFIG_ENV` para gerar JSON temporário e limpar arquivos após qualquer resultado |

O workflow chama, por exemplo, `bash infra/gcp/release.sh preflight` e `bash infra/gcp/release.sh build`. `release.sh` usa as variáveis `CONFIRM_PROJECT` e `RELEASE_SHA` que o workflow injeta. As verificações de imagem **falham com permissão negada ou digest inválido**, sem disparar um novo build erroneamente.

A CI testa esses scripts sem acessar Google Cloud, em [`test_release_workflow.py`](../../infra/gcp/tests/test_release_workflow.py) e [`test_release_image.py`](../../infra/gcp/tests/test_release_image.py). Para validar localmente: `bash -n infra/gcp/release.sh && python3 -m unittest discover -s infra/gcp/tests -v`.

## 🚀 Workflow único: dropdown por etapa ou release

O [🚀 GCP Controlled Release](https://github.com/rodkisten/photointel/actions/workflows/gcp-deploy.yml) oferece o dropdown **`action`** com `build`, `jobs-deploy`, `migrate`, `deploy`, `scheduler`, `cleanup` e **`release`**. Todas as opções executam no mesmo workflow, com os mesmos valores de `vars.GCP_CONFIG_ENV` do Environment `production`.

| Seleção | Operações executadas | Observação |
|---|---|---|
| `build` | Verifica prerequisitos → reutiliza imagem do SHA, ou compila/publica | Não cria recursos Cloud Run de runtime |
| `jobs-deploy` | Confere imagem do SHA → publica 4 Jobs de processamento | Não executa migração |
| **`migrate`** | Alembic no GitHub → Neon; `plan`, `diagnose` e `apply` | Não faz parte de `release` |
| `deploy` | Confirma `database_ready` → confere imagem → publica API | A migração deve estar concluída |
| `scheduler` | Cria/atualiza 3 cron jobs **pausados** | Não dispara processamento |
| `cleanup` | Pausa cron jobs | Não deleta imagens, dados ou services |
| **`release`** (padrão) | Confirma `database_ready` → build/reuso → verifica imagem → Jobs → API | Tudo em **uma execução**, interrompendo na primeira falha; Scheduler permanece separado |

**⚠️ Primeira implantação:** o `release` **não executa migrações**. O booleano `database_ready` começa **desmarcado** e só deve ser marcado após confirmar que a migração do Neon foi realizada, as versões referenciadas dos secrets existem e o controle de acesso Cloudflare foi preparado. Isso protege a publicação da API sem banco pronto. Para sua primeira instalação, siga `build` → `jobs-deploy` → **`migrate` (plan e depois apply protegido)** → `deploy` → `scheduler`. Para **releases seguintes**, com o banco migrado/compatível, use `release`. Para criar/ajustar os agendamentos, escolha `scheduler` separadamente; o release não altera agendamentos.

O `release` trabalha com **um único SHA** durante toda a execução. Reaproveita uma imagem existente desse SHA; caso contrário, constrói uma nova, publica-a e verifica o digest antes de alterar os Jobs. Alterar `main` depois de um build anterior significa um SHA novo e portanto uma imagem potencialmente nova.

**Como acionar:** `Run workflow` → branch `main` → action `release` (ou etapa isolada) → `confirm_project=photointel` → `authorize_charges=true` após revisão → para `release`/`deploy`, marque `database_ready` somente se verificado. A execução publica um resumo por etapa e remove arquivos temporários do runner ao final.

## 🗃️ Neon migrations diretamente no GitHub Actions

**Arquitetura:** `GitHub Actions → Alembic (Python isolado) → Neon PostgreSQL`. Não há execução, deploy nem logs de migração no Cloud Run. A API e os Jobs de processamento continuam no Cloud Run; o recurso legado `photointel-migrate`, se existente, não é apagado automaticamente, mas não é mais usado.

O [GCP Deploy](https://github.com/rodkisten/photointel/actions/workflows/gcp-deploy.yml) oferece `action=migrate` com `migration_mode=plan`, `diagnose` ou `apply`:

- `plan` / `diagnose`: conecta ao endpoint **direto** do Neon, mostra a revisão Alembic atual, a quantidade de tabelas de aplicação e executa somente `alembic current -v`. Não altera o banco e não exige `authorize_charges`.
- `apply`: exige `authorize_charges=true` e `migration_database=initial-empty` ou `existing-with-backup`. Executa `alembic upgrade head` no runner GitHub e mostra as transições de revisão e dicas de troubleshooting no próprio Action. **O modo `release` continua sem migrations.**

**Credenciais protegidas:** o runner autentica com WIF como `photointel-deployer`, impersona temporariamente **somente** `photointel-migrate` e lê a versão fixa de `MIGRATION_DATABASE_URL` do Secret Manager em memória. A identidade migradora é a única que tem acesso ao secret; o deployer não precisa ganhar acesso direto a todos os segredos. O URL nunca é registrado em logs ou artefatos. O script usa a política TLS verificada com psycopg/SCRAM channel binding e recusa endpoints `-pooler`. O ambiente virtual instala apenas Alembic, SQLAlchemy, psycopg, asyncpg e python-dotenv, com versões fixas do lockfile. Os arquivos temporários são eliminados no encerramento.

**Configuração inicial obrigatória:** execute [GCP Bootstrap → apply](https://github.com/rodkisten/photointel/actions/workflows/gcp-bootstrap.yml) **uma vez** depois de atualizar a `main`. Isso aplica `roles/iam.serviceAccountTokenCreator` ao deployer **apenas sobre a conta `photointel-migrate`**; mantém `roles/secretmanager.secretAccessor` somente na conta de migração. Sem esse passo, o CLI falha antes de ler o Neon, com instrução clara sobre o IAM.

**Primeira implantação:** no perfil `initial-empty`, o CLI consulta o Neon antes de qualquer alteração e recusa prosseguir se encontrar tabelas de aplicação ou revisão Alembic diferente de `base`. Não marque essa opção para um banco existente ou parcialmente migrado. No perfil `existing-with-backup`, exige `backup.json`, `manifest.enc` e `restore-verification.json`, associados a uma restauração testada e recente (até 24h); encontra o prefixo privado GCS automaticamente apenas quando é único. O recebimento desses metadados **não cria nem testa um backup**.

**Troubleshooting TLS:** o erro `NEON_TLS`/ `NEON_CA` antes da inspeção SQL significa que a conexão segura foi recusada, não que a migration parcialmente aplicou mudanças. O runner isolado usa agora o pacote `certifi==2026.7.22` (fixado no lockfile) para apontar explicitamente `sslrootcert` para um arquivo CA confiável, em vez de depender de `sslrootcert=system` resolvido de maneira diferente pelo libpq do wheel do psycopg. O script aplica o mesmo URL normalizado tanto à inspeção com psycopg quanto ao Alembic, sempre com `sslmode=verify-full` e `channel_binding=require` quando exigido pelo Neon. URLs com CA customizada explícita preservam sua configuração. O preflight verifica a presença do bundle antes de ler os secrets. Caso `NEON_CA` persista, compare o hostname de conexão com o certificado no Neon e examine os detalhes da cadeia de certificados de forma privada, **sem** baixar a proteção para `sslmode=require` ou `disable`.

**Troubleshooting:** `migrate → diagnose` lê o estado do banco diretamente, sem depender de `roles/logging.viewer` ou logs do Cloud Run. A saída do Alembic exibe transições de revisão; mensagens de erro são classificadas e filtradas para não revelar URLs, senhas ou SQL sensível. Em falhas, examine o **Job Summary** do GitHub, antes de repetir `apply` em um banco possivelmente alterado.

Scripts: [`migrate_workflow.py`](../../infra/gcp/migrate_workflow.py), [`migration-requirements.txt`](../../infra/gcp/migration-requirements.txt), [`release.sh`](../../infra/gcp/release.sh). Execute a migração somente com `action=migrate`.

## 9. Build → Jobs → migração → API → Scheduler

Em [GitHub Actions](https://github.com/rodkisten/photointel/actions/workflows/gcp-deploy.yml), escolha `Run workflow`, branch `main`, `confirm_project=photointel` e marque a autorização de cobrança **após revisar** a ação.

1. Execute **`build`**. Ele gera o manifesto de release e a imagem `us-central1-docker.pkg.dev/photointel/photointel/api:COMMIT_SHA_COMPLETO`; upload GCS → Docker → push Artifact Registry → verificação tag/digest. **Build não publica a API.**
2. Confira o status **SUCCESS** e o digest/tag no [Artifact Registry](https://console.cloud.google.com/artifacts?project=photointel). O builder usa `infra/gcp/cloudbuild.yaml` com logs em Cloud Logging; `gcloud builds submit` pode não transmitir esses logs ao terminal. Consulte a página do build.
3. Execute **`jobs-deploy`**. Publica os quatro Jobs Run de processamento, com a imagem tagueada pelo SHA; migrações são executadas no GitHub Actions.
4. **Migração é uma ação individual do mesmo workflow**, mas nunca executada no modo `release`. Use `migrate` → `plan` para inspecionar opcionalmente o Job, depois `migrate` → `apply` com a escolha de banco vazio ou backup e recibo de restauração. O SHA é detectado automaticamente. Veja a seção **Executar `migrate` pelo mesmo GitHub Actions** acima. O Cloud Shell permanece uma alternativa avançada:

   Para banco realmente vazio:

   ```bash
   python3 infra/gcp/manage.py migrate \
     --apply --authorize-charges --confirm-project photointel \
     --initial-empty-database
   ```

   Para **banco existente**, **não** use `--initial-empty-database`. Exija backup PostgreSQL + R2, teste de restauração isolada e recibo dentro da validade, então, como alternativa via Cloud Shell, use:

   ```bash
   python3 infra/gcp/manage.py migrate \
     --apply --authorize-charges --confirm-project photointel \
     --backup-directory backups/RELEASE \
     --backup-receipt backups/RELEASE/restore-verification.json
   ```

   Consulte [DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md). A migração chama o Job criado na etapa 3; nunca rode antes de publicar os Jobs. Um Cloud Shell atualizado para outro commit pode ter config/imagem de SHA diferente: valide o release antes da migração.
5. Execute **`deploy`** no Actions para publicar o Service `photointel-api`. O manifesto configura o `run.app` como transporte publicamente alcançável, com autenticação JWT Cloudflare **validada pela aplicação**, não por cabeçalhos fornecidos pelo usuário.
6. Configure Cloudflare Pages + Worker com upstream `run.app` **fixo** e política Access, conforme [CLOUDFLARE_SETUP.md](../../CLOUDFLARE_SETUP.md). Proteja também `pages.dev` e previews.
7. Execute **`scheduler`**: cria três cron jobs `discover`, `worker` e `maintenance`, **todos pausados**. Não os retome antes de confirmar Neon/R2/Access/limites e gates.
8. Execute smoke/análise de JWT autorizado e não autorizado; só habilite iCloud/Modal em operação separada e aprovada.

O fluxo manual deve ser repetido para **cada commit** que altera o release: a imagem tem tag do SHA exato. Um `build` bem-sucedido para commit anterior não corresponde automaticamente ao novo `main`.

## 10. Verificações após publicar

```bash
gcloud run services describe photointel-api \
  --project=photointel --region=us-central1 \
  --format="value(status.url)"
gcloud run jobs list --project=photointel --region=us-central1
gcloud scheduler jobs list --project=photointel --location=us-central1
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/photointel/photointel/api \
  --include-tags --project=photointel
```

Com a URL real `https://...run.app`:

```bash
python3 infra/gcp/manage.py smoke \
  --apply --origin https://ORIGIN_REAL.run.app
```

O smoke anônimo verifica a proteção de rotas privadas (esperado `401/403`); depois faça o teste real com Cloudflare Access no Safari. **Não** importa dados pessoais até confirmar a autenticação de ponta a ponta.

### Troubleshooting baseado nos erros reais desta instalação

| Log | Causa / correção |
|---|---|
| `invalid_target` (WIF) | Provider ID incorreto ou pool/provider desativado; aqui é `github-actions/providers/photo-intelligence`, não `providers/photointel` |
| `serviceusage.services.enable denied` | `bootstrap` foi executado com `deployer` sem poderes administrativos. Execute via operador ou com privilégio temporário revisado |
| `forbidden accessing bucket` | Bucket staging ausente ou `deployer` sem acesso ao bucket/`serviceusage.services.use` |
| `Unknown service account photointel-builder` | Bootstrap não criou Builder ou conta incorreta; crie e configure IAM |
| `caller does not have permission to act as service account` | Falta `roles/iam.serviceAccountUser` ao **deployer na service account builder** |
| `Repository "photointel" not found` | Crie Docker Artifact Registry `photointel` na região `us-central1`; não é o repositório GitHub |
| `containeranalysis.occurrences.list denied` | `images describe` antigo exigia Artifact Analysis. O `manage.py` atual lista imagens e confere SHA/digest via Artifact Registry Reader |
| Cloud Build `SUCCESS` mas workflow falha | Inspecione a **etapa após o build** e não reconstrua sem necessidade; o push anterior pode já ter sido concluído |
| Cloud Run `channel_binding=require` / `asyncpg does not support channel_binding` | URL padrão do Neon exige SCRAM-SHA-256-PLUS, que `asyncpg` não implementa. `db_connection.py` seleciona `postgresql+psycopg` automaticamente e preserva `channel_binding=require`, `sslmode=verify-full` e CAs do sistema. A imagem Docker valida esse perfil sem credenciais antes da publicação. Faça **novo build** da `main` com a correção, depois `deploy` ou `release` após verificar `database_ready`. Não remova `channel_binding=require` nem exponha o URL do banco. |

## Política de retenção e builds idempotentes

Para entender por que uma nova tag SHA aparece no Artifact Registry e por que CI gerava ZIPs em cada commit, consulte [Retenção e limpeza de artefatos](ARTIFACT_RETENTION.md). O workflow GCP é **manual**: commits no GitHub não iniciam o Cloud Build automaticamente. O build só é executado quando você escolhe a operação `build`; a mesma tag SHA agora é reaproveitada se a imagem já existe no registro, com digest verificado.

A validação offline do GCP não publica mais artifacts para cada sucesso e não é disparada por mudanças somente na documentação. Os artifacts de testes problemáticos ou manuais expiram em 3 dias.

Os arquivos `infra/gcp/artifact-registry-cleanup.json` (versões `api` com mais de 90 dias, mantendo as últimas 20 e tags `retain-*`) e `infra/gcp/staging-bucket-lifecycle.json` (tarballs `source/` com mais de 7 dias) estão versionados. **Não são aplicados automaticamente**. O primeiro exige dry-run e proteção de versões usadas em Cloud Run, Jobs e rollback; o segundo exige inspeção da configuração de lifecycle existente.

## 11. Rollback, custos e próximos releases

- `cleanup` no Actions apenas **pausa os agendamentos**, não remove dados/repositórios.
- `rollback` requer uma **revisão Cloud Run conhecida** e flags explícitas; a ação não está disponível no workflow manual simplificado. Consulte [CLOUD_RUN_SETUP.md](../../CLOUD_RUN_SETUP.md).
- Não faça downgrade destrutivo de banco automaticamente. Retenha backups/R2 e teste o restore.
- Mantenha a identidade administrativa fora do fluxo de CI e remova papéis temporários do Deployer após o bootstrap.
- Monitore Cloud Build (tipo da máquina), Artifact Registry (armazenamento e eventual scanning), Cloud Run (tempo/requests), Cloud Scheduler, logs, Neon e R2. Defina orçamento e revise políticas de retenção.

Este guia descreve **como executar** a implantação; ele não certifica que uma conta, serviço ou domínio está operacional neste momento. Verifique cada preflight e os logs reais de cada execução antes de avançar.
