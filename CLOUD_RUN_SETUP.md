# Google Cloud Run + Neon — implantação controlada pelo iPhone

Este é um segundo destino de produção, preservando Compose e Oracle/VPS como
alternativas. Os arquivos implementam a implantação; sua presença não comprova
provisionamento. Não foram criados recursos Google, não foram fornecidas
credenciais e não houve cobrança cloud neste trabalho. A autorização para
implementar não é autorização para contratar recursos.

## 1. Preparar contas e limites

No Safari, abra Google Cloud Console, Neon, Cloudflare e Modal. Escolha a região
Google próxima à região Neon; operações R2 e tráfego entre provedores podem ser
cobrados. Ative faturamento somente após revisar [COST_MODEL.md](COST_MODEL.md)
e configure alertas no Google Billing. Alertas não são limites rígidos.

No Codespaces ou Cloud Shell, clone a revisão que pretende publicar. Use um
terminal privado. Não é necessário Mac, Windows, Xcode ou chave JSON de service
account. No Cloud Shell a sessão gcloud já tem identidade; no Codespaces execute:

```bash
gcloud auth login --no-launch-browser
gcloud auth application-default login --no-launch-browser
cp infra/gcp/config.example.json infra/gcp/config.local.json
chmod 600 infra/gcp/config.local.json
```

Edite `config.local.json` pelo editor web. Esse arquivo é ignorado pelo Git e pelo
upload Cloud Build. Contém apenas identificadores, parâmetros e referências de
secrets: nunca valores de credenciais. Configure projeto, região, hostnames,
Access audience/allowlist, endpoint/bucket R2 e a imagem com tag do Git SHA
completo. `:latest` e versões `latest` de secrets são rejeitados. Para imagem por
digest, configure também `release_git_sha` com o commit de origem.

Examine planos sem qualquer chamada Google:

```bash
make gcp-doctor
make gcp-bootstrap
make gcp-jobs-deploy
make gcp-deploy
make gcp-scheduler
python3 -m unittest discover -s infra/gcp/tests -v
```

O padrão de **todos** os comandos é um plano offline. `doctor --apply` executa
somente consultas. Mutações exigem simultaneamente `--apply`,
`--authorize-charges` e `--confirm-project` com o projeto exato. Ninguém deve
ativar isso por instalar dependências ou executar testes.

## 2. Criar infraestrutura após autorização de cobrança

Depois de revisar o plano e autorizar os custos, substitua o projeto abaixo:

```bash
make gcp-doctor GCP_ARGS='--apply'
make gcp-bootstrap GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
```

O bootstrap habilita APIs, cria Artifact Registry privado, bucket privado de
staging do código, seis service accounts e secrets **vazios**. Não cria banco
Neon, bucket R2, recursos Modal nem políticas Access. O staging não contém
`.env`, sessões, backups, fotos ou credenciais: `build.gcloudignore` e
`.dockerignore` removem esses arquivos. Ainda assim revise o código enviado ao
Cloud Build. Configure retenção curta no bucket de código e no Artifact Registry
para evitar acumulação. O bootstrap não remove imagens ou objetos existentes.

Permissões do operador inicial: habilitar serviços, administrar IAM e criar os
recursos citados no projeto selecionado. Não conceda esses privilégios às
identidades de runtime.

| Identidade | Acesso |
|---|---|
| `photointel-api` | Secrets necessários; `run.invoker` somente nos quatro Jobs permitidos |
| `photointel-jobs` | Secrets R2/sessão/inferência e invocação dos quatro Jobs; sem credencial DDL |
| `photointel-migrate` | Somente as duas referências de banco; sem R2 ou sessão Apple |
| `photointel-scheduler` | `run.invoker` somente discover, worker e maintenance |
| `photointel-builder` | Escrita no repositório de imagens, leitura do staging e logs |
| `photointel-deployer` | Administração Run/Scheduler/Build; actAs somente identidades nomeadas |

Os privilégios de deploy são separados dos de runtime. Scheduler e API não podem
executar migration, alterar command/args do Job nem usar overrides de execução.

## 3. Neon, R2 e Secret Manager

Crie um banco Neon no dashboard e habilite pgvector conforme
[NEON_SETUP.md](NEON_SETUP.md). O endpoint pooled recebe a role limitada da
aplicação; o endpoint **direto** recebe a role de migrações. Ambos usam TLS
verificado. `channel_binding=require` é uma opção libpq e deve ser removida da
URL asyncpg; a aplicação continua verificando CA e hostname.

Crie um bucket R2 privado e um token restrito a esse bucket. Não habilite r2.dev,
custom domain público ou CORS permissivo. A API entrega imagens com autorização;
o navegador não recebe credenciais R2.

Carregue cada valor por prompt oculto, sem argumentos, arquivo de código ou
histórico de shell. Execute o comando para cada referência configurada:

```bash
python3 infra/gcp/manage.py secret-add --secret DATABASE_URL --apply --authorize-charges --confirm-project SEU_PROJECT_ID
python3 infra/gcp/manage.py secret-add --secret MIGRATION_DATABASE_URL --apply --authorize-charges --confirm-project SEU_PROJECT_ID
python3 infra/gcp/manage.py secret-add --secret STORAGE_ACCESS_KEY --apply --authorize-charges --confirm-project SEU_PROJECT_ID
python3 infra/gcp/manage.py secret-add --secret STORAGE_SECRET_KEY --apply --authorize-charges --confirm-project SEU_PROJECT_ID
python3 infra/gcp/manage.py secret-add --secret BRIDGE_TOKEN_PEPPER --apply --authorize-charges --confirm-project SEU_PROJECT_ID
python3 infra/gcp/manage.py secret-add --secret BRIDGE_ENROLLMENT_SECRET --apply --authorize-charges --confirm-project SEU_PROJECT_ID
python3 infra/gcp/manage.py secret-add --secret ICLOUD_SESSION_KEY --apply --authorize-charges --confirm-project SEU_PROJECT_ID
```

Crie pepper/enrollment com pelo menos 32 caracteres aleatórios; a chave de sessão
é de 32 bytes aleatórios codificados em base64. Guarde chaves em gerenciador
privado. O prompt usa `getpass`, não grava o valor no JSON, e o envia pelo stdin
para Secret Manager. Atualize o número da versão no JSON após rotação; cada
revisão Run recebe versões fixas. Uma versão desabilitada causa falha explícita.
A senha Apple nunca é um secret deste sistema: o login inicial é interativo.

GPU e iCloud continuam desativados. Para habilitar depois dos gates, configure
`enable_gpu`/`enable_icloud` como booleanos explícitos e publique uma nova revisão.
Modal também requer `MODAL_TOKEN`, `MODAL_PROXY_KEY`, `MODAL_PROXY_SECRET` nas
referências de secrets e `extra_environment.MODAL_ENDPOINT` HTTPS. Revise os
limites diários/mensais do backend e os controles do provedor.

## 4. Compilar, migrar e publicar

Um trigger de repositório no Cloud Build deve usar **arquivo de configuração**
`/cloudbuild.yaml`, com contexto na raiz do repositório. Selecionar somente
`infra/docker/` como contexto impede o acesso a `uv.lock`, `apps/` e `packages/`.
Esse fluxo constrói e envia a imagem ao Artifact Registry já provisionado; não
publica API, não altera Jobs e não executa ingestão. O trigger precisa informar
`COMMIT_SHA`; o manifesto dentro da imagem identifica esse commit e não aprova
gates. A tag `$BUILD_ID` é única; obtenha o digest da imagem no registro e
configure `image` e `release_git_sha` no JSON antes dos comandos de deploy abaixo.
Não conceda `run.admin` à identidade usada somente para builds. Configure
`_REGION`, `_REPOSITORY` e `_IMAGE_NAME` no trigger conforme o registro existente.
Criar/executar o trigger pode gerar cobrança e continua sendo ação do operador.

O Dockerfile Cloud Build é compatível com o builder clássico. O Compose local
usa `api.buildkit.Dockerfile` para disponibilizar um certificado CA personalizado
pelo segredo temporário `build_ca`, sem incorporar esse certificado à imagem
final nem desativar validação TLS. `BUILD_CA_FILE` seleciona o bundle local.

Antes de migrar dados existentes, crie backup PostgreSQL + cópia dos objetos R2,
verifique integridade autenticada e restaure uma amostra isolada; consulte
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md). O runner Alembic é separado do
startup API, usa URL direta e advisory lock de sessão.

A tag de imagem deve ser o `git rev-parse HEAD` do checkout limpo. O build gera
um `release-manifest.json` sem secrets, inclui-o na imagem e remove a cópia local
no final. Não sobrescreve um manifesto existente. A imagem registra também a
label OCI do SHA. O manifesto dentro da imagem não pode incluir o próprio digest
sem uma referência circular; registre o digest depois do build no manifesto de
release externo.

```bash
make gcp-build GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-jobs-deploy GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
# Somente na PRIMEIRA instalação em banco comprovadamente vazio:
make gcp-migrate GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --initial-empty-database'
# Para banco existente, restaure o backup em destino isolado e use o recibo:
make gcp-migrate GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --backup-directory backups/RELEASE --backup-receipt backups/RELEASE/restore-verification.json'
make gcp-deploy GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-scheduler GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
```

Escolha apenas uma variante de `gcp-migrate`. O recibo deve corresponder ao ID e
SHA-256 do manifesto criptografado e ter restauração feita há menos de 24 horas.
Somente `verification_kind=database-and-object-restore` com fingerprints do banco,
head de migração e leitura dos objetos restaurados é aceito. `verify` sozinho não
libera a migração; siga o restore isolado em [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
É uma proteção operacional baseada em evidência fornecida pelo operador, sem
assinatura independente do processo. O destino da primeira instalação deve ser
verificado como vazio antes de usar a exceção explícita.

O bootstrap do Scheduler publica três agendamentos e os deixa **pausados**.
Não há backfill periódico. Jobs do Scheduler usam OAuth para a API Google
`https://run.googleapis.com/v2/projects/PROJECT/locations/REGION/jobs/NAME:run`;
não use OIDC voltado a uma URL Run. `discover` é horário, `worker` a cada dez
minutos e `maintenance` a cada seis horas por padrão. Custo de Scheduler, Jobs e
cold starts deve ser medido antes de aumentar a frequência.

Só retome os agendamentos depois de verificar autenticação, banco, R2 e gates:

```bash
gcloud scheduler jobs resume photointel-worker --location REGION --project PROJECT
gcloud scheduler jobs resume photointel-maintenance --location REGION --project PROJECT
# Após autenticação Apple válida e aprovação de Gate B:
gcloud scheduler jobs resume photointel-discover --location REGION --project PROJECT
```

O workload não depende da vida do API container. Cada task executa no máximo
`job_max_jobs` e termina ao atingir o deadline. `job_task_count`/`job_parallelism`
particionam por aquisição atômica PostgreSQL, não por offset da biblioteca Apple.
O limite de trabalho é por task, portanto multiplique antes de aumentar tasks.
Cloud Run pode repetir a execução; as constraints/idempotency/leases protegem
resultados. A janela entre deadline e timeout reserva pelo menos 60 segundos
para SIGTERM e persistência.

## 5. Cloudflare e validação do origin

Siga [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) e o proxy em
`infra/cloudflare/cloud-run-proxy/`. Pages publica a PWA; o Worker roteia somente
para o origin Run fixo e preserva o JWT assinado do Access. As origens do template
podem usar o mesmo hostname; se usar hostnames separados configure CORS exato.
Proteja também previews Pages e o domínio pages.dev.

A URL `run.app` é alcançável pela Internet. O IAM `allUsers/run.invoker` permite
o transporte HTTP necessário ao proxy, mas **não** autoriza dados: FastAPI
valida assinatura/issuer/audience e allowlist em todas as rotas privadas,
inclusive media e Bridge. Não descreva essa rede como privada. Não habilite
simultaneamente um requisito IAM incompatível com o JWT Access do navegador.
O container não confia em `X-Forwarded-*` arbitrário.

```bash
make gcp-smoke GCP_ARGS='--apply --origin https://ORIGIN_REAL.run.app'
```

Esse smoke anônimo testa ausência de JWT e header de identidade forjado nas
rotas privadas. O resultado esperado é HTTP 401/403, sem redirecionamento que
mascare acesso. A validação completa com JWT válido/inválido/expirado e Media
está na suíte de segurança e deve ser repetida no ambiente real. Verifique `/v1`
através do Access no Safari antes de importar dados.

## 6. CI sem chave Google persistente

`.github/workflows/gcp-validation.yml` valida recursos offline sem credenciais.
`gcp-deploy.yml` é somente manual, branch main, ambiente `production`, permissão
OIDC e confirmação explícita de projeto/cobrança. Configure aprovadores do
ambiente no GitHub. Ele executa apenas a operação escolhida; não faz migração
sem backup e não provisiona contas automaticamente.

Crie Workload Identity Federation no Console: provider GitHub OIDC,
`https://token.actions.githubusercontent.com`, audience padrão do provider,
attribute mapping `google.subject=assertion.sub`,
`attribute.repository=assertion.repository`, `attribute.ref=assertion.ref` e
condição restringindo **seu repositório exato**, branch main e environment
production. Conceda `roles/iam.workloadIdentityUser` na conta
`photointel-deployer` somente ao principalSet desse repositório. Nunca conceda a
todos os repositórios do GitHub.

No ambiente GitHub `production`, configure variáveis não secretas:
`GCP_WORKLOAD_IDENTITY_PROVIDER` (nome completo do provider),
`GCP_DEPLOY_SERVICE_ACCOUNT` e `GCP_CONFIG_JSON` (mesmo JSON sem valores secretos).
Credenciais vêm da identidade federada de curta duração. A aplicação usa ADC da
service account Run, sem arquivo Google JSON ou token no bundle web.

## 7. Rollback e interrupção

```bash
make gcp-cleanup GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-rollback GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --revision photointel-api-REVISAO_VERIFICADA'
```

Cleanup apenas pausa Scheduler. Rollback troca tráfego para revisão API já
verificada; não executa downgrade destrutivo, não restaura banco e não altera
Jobs/R2. Para Jobs, volte o digest no JSON e execute `gcp-jobs-deploy`. Preserve
compatibilidade expand-migrate-contract e os dados. Se uma migração falhar,
interrompa rollout e siga o runbook de recuperação antes de repetir.

A implantação real permanece pendente de autorização de cobrança, contas,
credenciais, quotas e gates físicos. Uma definição renderizada ou um teste
mockado não comprova Cloud Run, Neon, R2, Apple ou Modal operacionais.

Os identificadores públicos de service token do Bridge podem ser informados em
`extra_environment.ACCESS_BRIDGE_SERVICE_TOKENS` como string JSON de uma lista,
e a audience própria em `ACCESS_BRIDGE_AUDIENCE`. Isso é uma allowlist de client
IDs, não de client secrets. Os segredos Access do dispositivo ficam no Keychain
do Pyto. Não envie service-token secrets ao frontend ou à configuração pública.
