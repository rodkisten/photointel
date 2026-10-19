# Validação da v1.1

Esta revisão valida uma aplicação local com PostgreSQL/pgvector, storage privado
S3 compatível, API, workers e PWA. Contas Apple, Google Cloud, Neon, Cloudflare e
Modal reais, assim como um iPhone físico, exigem verificações externas separadas.

As evidências anteriores da v1 permanecem em [docs/VALIDATION.md](docs/VALIDATION.md);
não comprovam a v1.1. Execuções intermediárias identificam SHA base, árvore dirty
e/ou hash do arquivo testado. Não são retroativamente atribuídas ao commit final.

## Reprodução local

```sh
make setup
make dev
make seed ASSETS=12
make lint
make typecheck
make test
make test-integration
make test-e2e
make build
make doctor
```

Integração e E2E devem usar banco e bucket descartáveis. O script
`infra/scripts/test-e2e-local.py`, chamado por `make test-e2e`, cria recursos
locais com UUID e os remove após a execução, preservando o catálogo do Compose.
Instale o Chromium com `npx --prefix apps/web playwright install chromium`;
use `make test-e2e E2E_ARGS=--webkit` depois de instalar também o WebKit e suas
bibliotecas. O runner recusa endpoints externos e configuração de produção.

O script interno
`infra/scripts/run-e2e.sh` exige explicitamente `APP_ENV=test`,
`INFERENCE_BACKEND=test`, `GPU_ENABLED=true` e revisões fictícias; o adaptador
determinístico é proibido fora desse ambiente. O Compose normal mantém GPU e
iCloud desativados e não produz classificações fabricadas.

## Verificações especializadas

```sh
python3 -m unittest discover -s infra/gcp/tests -v
node --test infra/cloudflare/cloud-run-proxy/worker.test.mjs
make restore-application-test POSTGRES_CONTAINER=photointel-v11-postgres
make capacity-benchmark CAPACITY_ASSETS=1000
```

O benchmark cria e remove somente bancos sintéticos próprios e exige
`CAPACITY_ADMIN_DATABASE_URL` local. Não o aponte para Neon ou para o catálogo.
`make gpu-test` é uma ação separada: não faz parte de setup nem dos testes locais
comuns e não autoriza gasto de GPU automaticamente.

## Evidência disponível

- [Ingestão e recuperação](docs/architecture/ingestion-manifest-v11.md).
- [Transações e fencing](docs/audit/WORKER_TRANSACTION_REMEDIATION.md).
- [Segurança](docs/audit/SECURITY_VERIFICATION.md).
- [Migração](docs/audit/MIGRATION_REPORT.md).
- [Restore de conteúdo](docs/evidence/application-restore-v11.json).
- [Planos GCP sem implantação](docs/evidence/gcp-offline-plans-v11.json).
- [Aceitação física no iPhone](docs/operations/iphone-acceptance.md).

Os gates B–F permanecem não verificados até testes reais e atestação do operador
para o SHA implantado. WebKit Linux não equivale a Safari físico, CPU não equivale
a Modal GPU, e dados sintéticos não comprovam throughput de uma biblioteca iCloud.
