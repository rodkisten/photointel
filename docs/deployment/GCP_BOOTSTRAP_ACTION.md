# Bootstrap GCP idempotente via GitHub Actions

O provisionamento administrativo **não** faz parte do workflow normal de deploy. Use:

- [🧱 Google Cloud administrative bootstrap](https://github.com/rodkisten/photointel/actions/workflows/gcp-bootstrap.yml): um fluxo manual, com modos `plan` (sem mutação) e `apply` (reconciliação).
- [🚀 Google Cloud controlled deployment](https://github.com/rodkisten/photointel/actions/workflows/gcp-deploy.yml): operações normais de build, Jobs, API, Scheduler e cleanup com `photointel-deployer`.
- `infra/gcp/bootstrap.sh`: operações de criação/consulta/IAM feitas **somente pela CLI `gcloud`**, com `jq` para ler identificadores do JSON local. Utiliza a mesma configuração `GCP_CONFIG_ENV` já validada pelo `gcp-env.py`.

## Por que uma identidade diferente?

A execução #22 do bootstrap anterior falhou com `serviceusage.services.enable denied` ao tentar executar `gcloud services enable` com `photointel-deployer`. Corrigir isso dando um papel Owner à conta de deploy permanente seria arriscado: a conta usada em releases cotidianos não deve ter privilégios para criar APIs, contas de serviço e políticas IAM.

A conta **`photointel-bootstrap@photointel.iam.gserviceaccount.com`** é exclusiva para essa operação administrativa. Ela requer poder elevado (em especial `resourcemanager.projects.setIamPolicy`, que pode escalar permissões), por isso:

1. Crie a identidade e configure WIF **uma única vez com uma conta humana administradora** via Cloud Shell.
2. Use um provider WIF separado, restrito ao repositório, à branch, ao GitHub environment e aos **caminhos exatos dos workflows bootstrap e terminal**.
3. Configure [GitHub Environment `production`](https://github.com/rodkisten/photointel/settings/environments) com **required reviewers** e acesso permitido somente pela branch protegida `main`, se disponível na sua conta/plano.
4. Autorize `apply` somente quando precisar criar/reconciliar infraestrutura. Considere **revogar o vínculo WIF do bootstrap quando não estiver usando** e restaurá-lo somente na próxima manutenção.

O fluxo normal `gcp-deploy.yml` usa o provider atual `github-actions/providers/photo-intelligence` e a service account limitada `photointel-deployer`. O bootstrap **não** usa nenhuma dessas duas identidades.

## Preparação única no Cloud Shell (administrador humano)

Projeto `photointel`; Project Number `799387180206`, região `us-central1`. **Todos os comandos abaixo são linhas únicas** para facilitar o uso no iPhone. Execute uma vez com `gcloud auth list` confirmando sua conta administrativa.

### 1. Criar a Service Account administrativa

```bash
gcloud iam service-accounts describe photointel-bootstrap@photointel.iam.gserviceaccount.com --project=photointel --quiet >/dev/null 2>&1 || gcloud iam service-accounts create photointel-bootstrap --display-name="PhotoIntel administrative bootstrap" --project=photointel --quiet
```

### 2. Conceder os papéis necessários

**Atenção:** estes papéis podem criar recursos, alterar IAM e gerar custos. Use a conta bootstrap somente em workflow autorizado e protegido. Estes papéis são mais restritos em escopo funcional do que Owner, mas `projectIamAdmin` ainda é muito poderoso.

```bash
for role in roles/serviceusage.serviceUsageAdmin roles/artifactregistry.admin roles/iam.serviceAccountAdmin roles/iam.workloadIdentityPoolAdmin roles/secretmanager.admin roles/storage.admin roles/resourcemanager.projectIamAdmin; do gcloud projects add-iam-policy-binding photointel --member="serviceAccount:photointel-bootstrap@photointel.iam.gserviceaccount.com" --role="$role" --quiet --format=none; done
```

### 3. Criar pool WIF separado

Não apague o pool `github-actions` já usado no deploy, nem altere o provider existente `photo-intelligence`.

```bash
gcloud iam workload-identity-pools describe github-bootstrap --location=global --project=photointel --quiet >/dev/null 2>&1 || gcloud iam workload-identity-pools create github-bootstrap --location=global --project=photointel --display-name="GitHub privileged bootstrap" --quiet
```

### 4. Criar provider GitHub OIDC específico para o bootstrap

Este provider aceita somente `.github/workflows/gcp-bootstrap.yml` e `.github/workflows/gcp-terminal.yml`, na branch `main` com Environment `production`.

```bash
gcloud iam workload-identity-pools providers describe photo-intelligence-bootstrap --location=global --workload-identity-pool=github-bootstrap --project=photointel --quiet >/dev/null 2>&1 || gcloud iam workload-identity-pools providers create-oidc photo-intelligence-bootstrap --location=global --workload-identity-pool=github-bootstrap --project=photointel --issuer-uri="https://token.actions.githubusercontent.com" --display-name="Photointel bootstrap only" --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" --attribute-condition="assertion.repository=='rodkisten/photointel' && assertion.ref=='refs/heads/main' && assertion.environment=='production' && assertion.workflow_ref in ['rodkisten/photointel/.github/workflows/gcp-bootstrap.yml@refs/heads/main','rodkisten/photointel/.github/workflows/gcp-terminal.yml@refs/heads/main']" --quiet
```

O bootstrap agora compara e atualiza a condição desse provider em `apply`; em
`plan`, não consulta nem altera o GCP. Execute **Setup GCP → apply** antes de
**GCP Terminal → provision**. Como o workflow bootstrap já é aceito pela condição
anterior, ele consegue autenticar e liberar o terminal automaticamente.

A identidade bootstrap precisa de `roles/iam.workloadIdentityPoolAdmin`, incluído
no passo 2. Se ela já existia sem esse papel, conceda-o uma única vez com sua conta
administradora no Cloud Shell:

```bash
gcloud projects add-iam-policy-binding photointel --member="serviceAccount:photointel-bootstrap@photointel.iam.gserviceaccount.com" --role=roles/iam.workloadIdentityPoolAdmin --condition=None --quiet --format=none
```

Se até o workflow bootstrap estiver bloqueado pela condição do provider, faça a
correção inicial com sua conta administradora (o workflow não consegue corrigir
uma condição que impede sua própria autenticação):

```bash
gcloud iam workload-identity-pools providers update-oidc photo-intelligence-bootstrap --project=photointel --location=global --workload-identity-pool=github-bootstrap --attribute-condition="assertion.repository=='rodkisten/photointel' && assertion.ref=='refs/heads/main' && assertion.environment=='production' && assertion.workflow_ref in ['rodkisten/photointel/.github/workflows/gcp-bootstrap.yml@refs/heads/main','rodkisten/photointel/.github/workflows/gcp-terminal.yml@refs/heads/main']" --quiet
```

Confira a condição no Console se o provider já existia. Um `describe` bem-sucedido **não garante** que o provider antigo tenha a condição segura; não continue até validar.

### 5. Permitir WIF usar SOMENTE a service account bootstrap

```bash
gcloud iam service-accounts add-iam-policy-binding photointel-bootstrap@photointel.iam.gserviceaccount.com --project=photointel --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/attribute.repository/rodkisten/photointel" --quiet --format=none
```

A condição do provider é a barreira que restringe o principalSet ao workflow, environment, branch e repo exatos. **Não** conceda essa identidade ao pool/provider normal de deploy.

### 6. Variáveis no GitHub Environment `production`

Mantenha a variável existente `GCP_CONFIG_ENV` (apenas referências não secretas; confira [guia geral](CLOUD_RUN_FROM_ZERO.md)). Adicione:

| Variável | Valor |
|---|---|
| `GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER` | `projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/providers/photo-intelligence-bootstrap` |
| `GCP_BOOTSTRAP_SERVICE_ACCOUNT` | `photointel-bootstrap@photointel.iam.gserviceaccount.com` |

Não crie JSON key. O GitHub Action troca tokens curtos por WIF. Os próprios valores dessas duas variáveis não são credenciais.

## Como executar

Abra [GitHub Actions: Administrative bootstrap](https://github.com/rodkisten/photointel/actions/workflows/gcp-bootstrap.yml), selecione a branch `main`, informe `confirm_project=photointel`:

1. **`mode=plan`**, `authorize_charges=false`: valida a configuração e lista o escopo **offline, sem exigir WIF administrativo nem acesso ao Google Cloud**, sem alterar recursos.
2. **`mode=apply`**, `authorize_charges=true`: aprova o provisionamento e reconcilia o projeto. O Environment pode exigir revisão antes de permitir execução.

A ação valida `GCP_CONFIG_ENV` e executa `bash infra/gcp/bootstrap.sh`. Em `plan`, não autentica no Google nem instala `gcloud`; em `apply`, autentica como `photointel-bootstrap` com `auth` e instala `gcloud` por `setup-gcloud` antes de executar o script. Os comandos `gcloud` da execução têm acesso aos logs do próprio Actions e param no primeiro erro.

### Idempotência e limites

- APIs: calcula as APIs ausentes; habilita apenas as ausentes.
- Artifact Registry Docker: verifica existência e formato; **não** recria repositório existente.
- Seis service accounts: cria apenas ausentes.
- Secret Manager: cria apenas *containers* de secret inexistentes, **sem** versões ou valores.
- GCS: cria bucket privado somente se ausente; não tenta mover um bucket existente na multirregião `US`.
- IAM: reaplica `add-iam-policy-binding`; o Google não cria concessões duplicadas para o mesmo membro/papel. Corrige vinculações que ainda faltam. Cada concessão declara `--condition=None` para compatibilidade com políticas IAM do projeto que já possuem bindings condicionais, sem remover ou modificar condições existentes. Essas novas concessões são **incondicionais**, como definido na matriz de acesso do bootstrap.
- **Não** deleta recursos, imagens, dados privados, versões de secrets nem revisões Cloud Run. Não ativa cobrança automaticamente: isso depende dos termos e configuração do projeto e de `apply` explicitamente autorizado.
- `plan` não faz inventário detalhado de diferenças no GCP; imprime um **resumo de alterações possíveis**. `apply` inspeciona e altera conforme necessário. Uma falha de IAM não é interpretada como “recurso não existe”.
- IAM bindings adicionados são reconciliados, mas políticas inesperadas de acesso **não são removidas**. Faça auditoria de IAM separadamente.

## Depois do bootstrap

Confirme os recursos e verifique se as versões dos secrets realmente existem. Só então execute `build` pelo [workflow normal](https://github.com/rodkisten/photointel/actions/workflows/gcp-deploy.yml). O bootstrap não inicia Cloud Build, não publica Cloud Run nem configura contas Neon/Cloudflare.

### Revogar acesso privilegiado após conclusão (opcional, recomendado)

Com a conta humana admin no Cloud Shell, revogue `roles/iam.workloadIdentityUser` na **service account bootstrap** usando o mesmo principalSet:

```bash
gcloud iam service-accounts remove-iam-policy-binding photointel-bootstrap@photointel.iam.gserviceaccount.com --project=photointel --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/attribute.repository/rodkisten/photointel" --quiet --format=none
```

Isso não apaga recursos nem altera o deploy normal. Para executar bootstrap no futuro, um administrador precisará reautorizar o vínculo. Consulte [documentação Google WIF](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) e [action gcloud](https://github.com/google-github-actions/setup-gcloud).
