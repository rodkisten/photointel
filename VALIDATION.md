# Validação da v1.1

Esta revisão valida uma aplicação local com PostgreSQL/pgvector, storage privado
S3 compatível, API, workers e PWA. Contas Apple, Google Cloud, Neon, Cloudflare e
Modal reais, assim como um iPhone físico, exigem verificações externas separadas.

As evidências anteriores da v1 permanecem em [docs/VALIDATION.md](docs/VALIDATION.md);
não comprovam a v1.1. Execuções intermediárias identificam SHA base, árvore dirty
e/ou hash do arquivo testado. Não são retroativamente atribuídas ao commit final.

## Resultado consolidado em 20/10/2026

**Local development ready.** A rodada final usa o commit limpo
`2ce4015f5b5f89caa198bf5f186c23b5b6354806`, incluindo a correção do Cloud Build,
a política ZIP e a versão correta do diagnóstico. A imagem local registra esse
SHA em seu label OCI e em `/v1/release`. Os testes e hashes estão em
[release-validation-v11.json](docs/evidence/release-validation-v11.json) e o
[manifesto](docs/evidence/release-manifest-v11.json) identifica essa mesma origem.
O commit posterior que publica estes documentos não muda o código testado.

Cloud Build usa o Dockerfile clássico e somente constrói/envia imagem, sem
deploy automático. Compose usa BuildKit com CA transitória; o rebuild final
passou com TLS, e a CA não está no runtime. API, workers, banco, storage e PWA
ficaram saudáveis; as 12 imagens e 36 derivados privados foram decodificados.
O diagnóstico retorna v1.1.0, banco/storage prontos e iCloud/GPU desligados.
A execução do Cloud Build na conta do operador continua não verificada.

| Verificação executada | Resultado | Escopo da evidência |
| --- | --- | --- |
| `APP_ENV=test .venv/bin/pytest -m 'not integration and not gpu and not e2e' -q --tb=short --junitxml=reports/release-unit.xml` | 319 passaram + 24 subtestes | Sem Apple, Modal ou recursos pagos |
| `APP_ENV=test .venv/bin/pytest -m integration -q --tb=short --junitxml=reports/release-integration.xml` | 94 passaram em 235,68 s | PostgreSQL local descartável, credencial via ambiente privado |
| `.venv/bin/ruff check .` | Passou | Fontes Python |
| `.venv/bin/mypy apps/api/src gpu bridges` | Passou em 60 arquivos | Tipos Python |
| `npm --prefix apps/web run typecheck` | Passou | TypeScript strict |
| `npm --prefix apps/web run lint` | 0 erros, 3 avisos Fast Refresh | Avisos conhecidos de organização de exports |
| `npm --prefix apps/web test -- --maxWorkers=2` | 37 passaram, 11 arquivos | Componentes e estado do frontend |
| `python3 -m unittest discover -s infra/gcp/tests -q` | 22 passaram | Planos/comandos offline; não invocou Google |
| `node --test infra/scripts/zip-patch-policy.test.cjs infra/cloudflare/cloud-run-proxy/worker.test.mjs` | 7 passaram | Relay Cloudflare com transporte controlado |

A rodada final de navegador passou 58 cenários e pulou duas capturas opcionais.
O banco/bucket descartáveis foram removidos. O executor sem root precisou de
`libgles2` extraída de pacote Debian oficial em `var/tools`, via `LD_LIBRARY_PATH`.
`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` contornou apenas a consulta
`ldconfig`, que não reconhece esse diretório; o WebKit real abriu e executou os
fluxos. Isso não é Safari físico. Os incidentes anteriores de disco e biblioteca
ausente, e suas recuperações, constam no JSON da rodada final.

As evidências anteriores abaixo preservam os horários e hashes originais; os
runners CPU/E2E não registraram SHA Git. Não são promovidas automaticamente a
atestados do novo commit:

- [CPU real atualizada](docs/evidence/real-cpu-v11.json): pesos verdadeiros JoyTag e
  SigLIP 2 com Transformers 5.10.2, 5.813 probabilidades, embedding 768 e persistência
  confirmada em nova sessão; **não executou GPU/Modal**.
- [E2E local](docs/evidence/e2e-v11.json): 58 passaram e 2 capturas opcionais foram
  puladas; Chromium e WebKit Linux, com inferência determinística somente em teste.
  O banco e o bucket descartáveis foram removidos. **Não é Safari físico**.
- [Restore](docs/evidence/application-restore-v11.json): conteúdo criptografado,
  banco, três imagens e referências restaurados no head `0007_model_preprocessing`.
- Compose executou API, worker, ingestão, PostgreSQL, MinIO e PWA; galeria com
  12 imagens procedurais concluídas e 36 derivados privados respondeu HTTP 200.
  Após reinício do executor, os dados e serviços continuaram disponíveis.

Os limites de capacidade medidos, inclusive a execução **não realizada** de
176.000 ativos, estão em [CAPACITY_REPORT.md](CAPACITY_REPORT.md). O relatório
com achados, matriz e comandos está em
[FINAL_REPORT_V11.md](docs/audit/FINAL_REPORT_V11.md).

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

- [Rodada final vinculada ao commit](docs/evidence/release-validation-v11.json).
- [Manifesto da imagem testada](docs/evidence/release-manifest-v11.json).
- [Ingestão e recuperação](docs/architecture/ingestion-manifest-v11.md).
- [Transações e fencing](docs/audit/WORKER_TRANSACTION_REMEDIATION.md).
- [Segurança](docs/audit/SECURITY_VERIFICATION.md).
- [Migração](docs/audit/MIGRATION_REPORT.md).
- [Restore de conteúdo](docs/evidence/application-restore-v11.json).
- [Pesos reais em CPU com Transformers 5.10.2](docs/evidence/real-cpu-v11.json).
- [Aceitação automatizada de browsers](docs/evidence/e2e-v11.json).
- [Planos GCP sem implantação](docs/evidence/gcp-offline-plans-v11.json).
- [Aceitação física no iPhone](docs/operations/iphone-acceptance.md).

Os gates B–F permanecem não verificados até testes reais e atestação do operador
para o SHA implantado. WebKit Linux não equivale a Safari físico, CPU não equivale
a Modal GPU, e dados sintéticos não comprovam throughput de uma biblioteca iCloud.
