# Retenção e limpeza de artefatos: GitHub Actions, Cloud Build e Artifact Registry

A palavra *artifact* identifica coisas distintas neste projeto. Não confunda relatórios ZIP de Actions, arquivos de staging do Cloud Build e imagens Docker usadas por Cloud Run.

## Política adotada no repositório

| Classe | Criação | Retenção |
|---|---|---|
| GitHub CI (`.github/workflows/ci.yml`) | Unit/integration/browser reports | Só falha ou execução manual; 3 dias |
| GCP offline validation (`.github/workflows/gcp-validation.yml`) | Planos e renderizações | Só falha ou execução manual; 3 dias; mudanças apenas de documentação não disparam o workflow |
| Release provenance (`.github/workflows/release-manifest.yml`) | Manifesto de release | Manual; 90 dias, intencionalmente mais longo para auditoria |
| Cloud Build staging GCS | Upload `source/*.tgz` | Arquivo de política 7 dias, **ainda não aplicada na conta** |
| Artifact Registry Docker `photointel/api` | Nova imagem por SHA distinto | Política de 90 dias + proteção das 20 versões mais recentes e tags `retain-*`, **somente arquivo de modelo, dry-run primeiro** |
| Cloud Run Service/Jobs | Revisões que apontam para imagens | Não apagar imagens/revisões sem inventariar workloads e caminhos de rollback |

**Não há builds automáticos no workflow GCP**: `gcp-deploy.yml` roda somente por `workflow_dispatch`. `build` usa tag SHA completo da revisão para rastreabilidade. No mesmo SHA, o workflow verifica a existência da imagem antes de iniciar Cloud Build e **reutiliza-a** quando a versão e digest são válidos. Para um SHA **novo**, a publicação gera imagem nova (mesmo para commit apenas de docs, se o operador pedir build desse commit).

## GitHub Actions: por que aparecia um Artifact a cada commit?

`gcp-validation.yml` antes monitorava `README.md` e o guia de Cloud Run, além de publicar `gcp-offline-definitions` em **todo** sucesso. O workflow geral `ci.yml` também salvava arquivos de teste em todos os runs. Agora ambos gravam artifacts principalmente quando úteis para diagnóstico ou execução manual; relatórios expiram após 3 dias.

O GitHub guarda também **registros de execução e logs**. Ajuste o padrão em [Settings → Actions → General](https://github.com/rodkisten/photointel/settings/actions) → Artifact and log retention. Recomenda-se configurar 7 a 14 dias conforme necessidade de auditoria; os `retention-days` individuais de 3 dias continuam mais curtos. A mudança da configuração do repositório **não altera retroativamente** o vencimento de artefatos antigos.

Para apagar antigos, abra [Actions](https://github.com/rodkisten/photointel/actions) → run → seção Artifacts → ícone de lixeira; confira o conteúdo antes, especialmente `release-provenance` e evidências de builds antes de apagar. O CLI do GitHub permite listar sem alterar:

```bash
gh api "repos/rodkisten/photointel/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | [.id,.name,.size_in_bytes,.expired,.expires_at] | @tsv'
```

Não criamos uma rotina que apaga indiscriminadamente artifacts de workflows antigos.

## Artifact Registry: proteger imagens de produção antes da limpeza

O repositório Docker fica em `us-central1-docker.pkg.dev/photointel/photointel`. O pacote da API é `api`. Uma tag `:SHA` aponta para uma versão com digest imutável `sha256:...`; várias versões são esperadas ao longo do tempo.

O arquivo [`infra/gcp/artifact-registry-cleanup.json`](../../infra/gcp/artifact-registry-cleanup.json) define:

- **Delete**: versões `api` com mais de **90 dias**, tagged ou untagged.
- **Keep**: ao menos as **20 versões mais recentes** de `api`, independentemente da idade.
- **Keep**: versões com tag `retain-*`, destinadas a produção/rollback.

O período sozinho **não é garantia de preservar a imagem usada por Cloud Run**. Antes de ativar Delete, confira o digest/tags das revisões em execução e dos Jobs. Atribua `retain-SHA` a cada imagem que deva sobreviver à limpeza, por uma identidade com `roles/artifactregistry.writer` no repositório.

```bash
# Execute apenas após validar que a revisão é necessária para prod ou rollback:
IMAGE="us-central1-docker.pkg.dev/photointel/photointel/api"
SHA="COLE_SHA_COMPLETO_DA_IMAGEM"
gcloud artifacts docker tags add \
  "$IMAGE:$SHA" "$IMAGE:retain-$SHA" --project=photointel
```

Veja imagens:

```bash
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/photointel/photointel/api \
  --include-tags --project=photointel
gcloud run services describe photointel-api \
  --region=us-central1 --project=photointel \
  --format="yaml(spec.template.spec.containers,status.traffic)"
gcloud run jobs list --region=us-central1 --project=photointel
```

Faça **dry-run** com o arquivo versionado e examine o [resultado no audit log](https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy) (processamento periódico, aproximadamente um dia):

```bash
gcloud artifacts repositories set-cleanup-policies photointel \
  --project=photointel --location=us-central1 \
  --policy=infra/gcp/artifact-registry-cleanup.json --dry-run
```

**Somente após** inventariar e proteger as imagens de produção e rollback, revisar o dry-run, e autorizar exclusão, habilite explicitamente:

```bash
gcloud artifacts repositories set-cleanup-policies photointel \
  --project=photointel --location=us-central1 \
  --policy=infra/gcp/artifact-registry-cleanup.json --no-dry-run
```

Este comando muda uma política do repositório **inteiro**, potencialmente sobrescrevendo políticas já existentes. O cleanup é assíncrono, não uma exclusão instantânea. Não execute em um repositório compartilhado sem inventário.

## Cloud Storage staging: arquivos do Cloud Build

O bucket `gs://photointel-photointel-build-source` guarda tarballs de código em `source/`. O arquivo [`infra/gcp/staging-bucket-lifecycle.json`](../../infra/gcp/staging-bucket-lifecycle.json) define exclusão de objetos do prefixo `source/` ao atingir 7 dias. Não afeta o bucket R2 onde ficam os arquivos privados da biblioteca.

Antes de ativar, **leia as regras de ciclo de vida existentes**: aplicar este JSON substitui a configuração anterior do bucket, caso exista.

```bash
gcloud storage buckets describe \
  gs://photointel-photointel-build-source \
  --project=photointel --format="default(lifecycle_config)"
# Depois de revisar o conteúdo e autorizar a política:
gcloud storage buckets update \
  gs://photointel-photointel-build-source \
  --project=photointel \
  --lifecycle-file=infra/gcp/staging-bucket-lifecycle.json
```

Uma regra GCS de lifecycle é executada de forma assíncrona. Pode haver retenção de *soft delete* configurada no bucket, portanto a cobrança e a exclusão definitiva podem não ser imediatas.

## Permissões e limites de segurança

- Alterações de cleanup do Artifact Registry exigem permissão de update e, para exclusões, deleção de versions; execute como **operador humano/admin**, não dê esses poderes ao `photointel-builder` ou `photointel-deployer`.
- Atualização de lifecycle GCS precisa de `storage.buckets.update`, preferencialmente concedida só ao administrador do bucket de staging.
- **Nenhuma política de exclusão foi aplicada automaticamente** por commits, bootstrap ou workflows de deploy. Os arquivos JSON são modelos versionados para revisão e aprovação.
- Não remova revisões Cloud Run, bancos, buckets R2, secrets nem imagens `retain-*` como parte da limpeza de staging/CI.
