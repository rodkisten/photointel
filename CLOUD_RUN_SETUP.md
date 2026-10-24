# Google Cloud Run + Neon — implantação controlada pelo iPhone

**[Comece pelo guia completo: do zero ao deploy](docs/deployment/CLOUD_RUN_FROM_ZERO.md).** Ele traz os comandos e configurações atuais de Cloud Shell, GCP IAM, WIF com GitHub, Artifact Registry, Cloud Build, Secret Manager, Cloudflare, BUILD_CA_FILE e GitHub Actions, incluindo diagnóstico de erros já encontrados.

Este documento aprofunda migração/rollback, recursos finitos e autenticação. **O estado de contas Google, permissões, domínio e bancos deve ser confirmado no Console e pelos logs de cada execução:** repositório versionado ou teste offline não prova que a produção está operacional. Criar recursos pode gerar cobranças.

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

**Execute esse bootstrap inicialmente com identidade humana administrativa no Cloud Shell**, ou com identidade de CI que recebeu poderes administrativos temporários e aprovados. A conta `photointel-deployer` não consegue habilitar APIs e criar sua própria infraestrutura sem permissões extras. O bootstrap habilita APIs, cria Artifact Registry privado, bucket privado de
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

O caminho de implantação adotado por este projeto é o workflow **manual** `.github/workflows/gcp-deploy.yml`: a ação `build` executa `infra/gcp/manage.py build`, que utiliza `infra/gcp/cloudbuild.yaml`, envia o contexto da **raiz do repositório** e publica a imagem `api:SHA_COMPLETO` no Artifact Registry previamente criado. Não faz deploy da API ou dos Jobs. O workflow gera `release_git_sha` e `image` do mesmo commit de `main`; não é necessário registrar manualmente um digest antes desse fluxo. Ele verifica ao final que a tag aparece no registro com digest SHA-256, por `gcloud artifacts docker images list --include-tags --format=json`, sem exigir Container Analysis.

O trigger alternativo em `/cloudbuild.yaml` permanece disponível para operadores que preferem Cloud Build nativo e exige configurar suas próprias substituições/digests. **Não confunda os dois fluxos.** Em qualquer um, o repositório Docker `photointel` deve existir na região `us-central1`. O build pode gerar custos; inspecione logs no Cloud Logging quando `gcloud builds submit` não exibir o log completo.

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

## 6. GitHub Actions, WIF, identidade e preflight

**Fluxo detalhado no [guia do zero ao deploy](docs/deployment/CLOUD_RUN_FROM_ZERO.md#6-workload-identity-federation-github--google-sem-chave-json).** O workflow `.github/workflows/gcp-validation.yml` valida offline sem credenciais nem criação de recursos. `.github/workflows/gcp-deploy.yml` só executa por `workflow_dispatch` em `main`, ambiente GitHub `production`, com `id-token: write`, confirmação do projeto e autorização explícita de cobranças (desmarcada por padrão). Uma execução realiza apenas a operação escolhida. A migração permanece bloqueada no Actions até a verificação manual do banco e dos backups.

No Google Cloud, use o Pool WIF **`github-actions`** e Provider OIDC **`photo-intelligence`** em `global` com issuer `https://token.actions.githubusercontent.com`. O recurso correto nesta instalação é:

```text
projects/799387180206/locations/global/workloadIdentityPools/github-actions/providers/photo-intelligence
```

Restrinja o provider via `assertion.repository == 'rodkisten/photointel'`, `assertion.ref == 'refs/heads/main'` e `assertion.environment == 'production'`, com mapeamento `google.subject` e `attribute.repository` (e atributos auxiliares utilizados pela condição). Conceda `roles/iam.workloadIdentityUser` **na service account** `photointel-deployer@photointel.iam.gserviceaccount.com` para o principalSet do repo exato. Não use `providers/photointel` nem e-mail `@799387180206.iam.gserviceaccount.com`.

No GitHub `Settings → Environments → production → Environment variables`, crie a única variável **multiline** `GCP_CONFIG_ENV`, com valores não secretos e referências `SECRETS__...__NAME/VERSION`, além de `GCP_WORKLOAD_IDENTITY_PROVIDER` e `GCP_DEPLOY_SERVICE_ACCOUNT`. O workflow passa **`vars.GCP_CONFIG_ENV`** para `infra/gcp/gcp-env.py`, que gera `config.local.json` privado, adiciona o SHA de `main` e expõe os dois identificadores WIF como outputs. **As instruções antigas com `GCP_CONFIG_JSON` não se aplicam a este workflow.** Nunca inclua R2 secrets, senha Neon, Bridge pepper, cookies iCloud ou chaves Google no dotenv do GitHub.

### IAM mínimo para o fluxo de build

| Conta | Recurso e papel |
|---|---|
| `photointel-deployer` | `roles/cloudbuild.builds.editor`, `roles/artifactregistry.reader` e, quando exigido, `roles/serviceusage.serviceUsageConsumer` no projeto |
| `photointel-deployer` | `roles/storage.objectAdmin` no bucket `gs://photointel-photointel-build-source` |
| `photointel-deployer` | `roles/iam.serviceAccountUser` **sobre** `photointel-builder`, para `iam.serviceAccounts.actAs` |
| `photointel-builder` | `roles/storage.objectViewer` no bucket de staging, `roles/artifactregistry.writer` no repositório Docker e `roles/logging.logWriter` no projeto |

O `bootstrap` também concede papéis extras de deploy Run/Scheduler/actAs sobre as demais identidades. O operador inicial precisa dos poderes administrativos para criar recursos e definir IAM; **não os mantenha permanentemente no Deployer**. O preflight de `build` consulta identidade, API, bucket, conta Builder e repositório Artifact Registry, mas não garante sozinho toda a permissão de escrita. O build real é a última confirmação.

**Erros já solucionados:** `invalid_target` (provider ID), `serviceusage.services.enable` (bootstrap com conta sem privilégio), bucket de staging inacessível, Builder ausente, `caller does not have permission to act as service account` (falta actAs), `Repository "photointel" not found` (Artifact Registry não criado) e `containeranalysis.occurrences.list` (consulta antiga substituída no manage). Veja tabela de diagnóstico no guia novo.

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

Não presuma que o deploy está completo porque o Cloud Build retornou SUCCESS: isso comprova a construção/publicação da imagem, não os Jobs, migrações, Cloud Run Service, Zero Trust, Apple ou Modal. Verifique cada recurso e seus gates com os comandos do guia.

Os identificadores públicos de service token do Bridge podem ser informados em
`extra_environment.ACCESS_BRIDGE_SERVICE_TOKENS` como string JSON de uma lista,
e a audience própria em `ACCESS_BRIDGE_AUDIENCE`. Isso é uma allowlist de client
IDs, não de client secrets. Os segredos Access do dispositivo ficam no Keychain
do Pyto. Não envie service-token secrets ao frontend ou à configuração pública.
