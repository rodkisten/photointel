# Rastreabilidade código → documentação e lacunas

**Snapshot auditado:** `main@22c01bc86ce789dde937a5d215c54740ca6b93f6` em 04/11/2026. Esta tabela relaciona **o que existe em código**, **o que exige configuração**, e **o que não deve ser anunciado como validado em produção**.

## 1. Fontes de verdade por domínio

| Assunto | Código a conferir | Documento principal | Estado |
|---|---|---|---|
| Proxy SPA + API | `infra/cloudflare/cloud-run-proxy/worker.mjs`, `deploy-worker.yml` | [Infraestrutura](INFRASTRUCTURE_AND_DEPLOY.md) | implementado, deploy real externo |
| API FastAPI e contratos | `main.py`, `routers/*`, `packages/contracts/openapi.json` | [Componentes](COMPONENTS_AND_STACK.md) | implementado |
| Banco, migrations, pgvector | `models.py`, `infra/migrations/versions/*` | [Dados](DATA_AND_INFERENCE.md) | implementado, schema remoto requer inspeção |
| Ingestão Apple | `ingestion.py`, `discovery.py`, `session_store.py` | [Ingestão](INGESTION_AND_RECOVERY.md) | configurável, Apple real não inferível |
| Fila e despacho | `jobs.py`, `leases.py`, `outbox.py`, `cloud_dispatch.py` | [Ingestão](INGESTION_AND_RECOVERY.md) | implementado |
| Imagens e previews | `media.py`, `preview_repair.py`, `storage.py` | [Dados](DATA_AND_INFERENCE.md) | implementado, recursos antigos dependem da fonte |
| Inferência | `gpu/modal_app.py`, `services/inference.py` | [Dados](DATA_AND_INFERENCE.md) | opcional; execução Modal exige evidência |
| Busca | `routers/catalog.py`, `services/search.py`, `query_cache.py` | [Dados](DATA_AND_INFERENCE.md) | implementado |
| Proteção e credenciais | `auth.py`, `config.py`, `apps/manage/src/auth.ts` | [Segurança](SECURITY_AND_SECRETS.md) | implementado, IAM/política remota requerem validação |
| Deploy GCP | `infra/gcp/*`, `gcp-*.yml` | [Infraestrutura](INFRASTRUCTURE_AND_DEPLOY.md) | automação implementada |
| Manage | `apps/manage/src/api.ts`, `router.tsx`, `routes/*` | [Frontends](FRONTENDS_AND_BRIDGE.md) | implementado |
| PWA / push | `apps/web/public/sw.js`, `fcm.js`, `services/fcm_notify.py` | [Frontends](FRONTENDS_AND_BRIDGE.md) | implementado, device real requer teste |
| Sentry e logs | `sentry_observability.py`, `observability.py`, `apps/manage/src/log*` | [Operação](OBSERVABILITY_AND_OPERATIONS.md) | parcialmente dependente de providers |
| Telegram / Notify | `telegram_notify.py`, `job_notify.py`, `.github/actions/notify` | [Operação](OBSERVABILITY_AND_OPERATIONS.md) | configurável |
| Apple Bridge | `bridges/pyto/bridge.py`, `routers/bridge.py` | [Frontends](FRONTENDS_AND_BRIDGE.md) | protocolo implementado; writer nativo não comprovado |
| Backup/restore | `services/backup.py`, `infra/scripts/backup*` | [Disaster recovery](../../DISASTER_RECOVERY.md) | mecanismo implementado, teste real externo |

## 2. Discrepâncias históricas identificadas

1. Documentos anteriores chamam a entrega principal de **Cloudflare Pages**. O caminho atual de produção é **Worker unificado** (SPA + `/v1/*`) e um Worker distinto para Manage.
2. A frase **“13 workflows”** está obsoleta; existem dezenas de YAMLs em `.github/workflows`.
3. O guia antigo cita checkbox `database_ready`/confirmação de projeto na UI. O `release.sh` atual realiza gate **read-only de revisão do schema**; scripts de bootstrap ainda contêm verificações de segurança/custo de `apply`.
4. A aplicação principal usa **React Router**, e o Manage usa **TanStack Router**. Não dizer que ambos foram migrados.
5. O processador de imagens gera **WebP** com fallback JPEG e AVIF opcional; não garantir que todas as variantes antigas de R2 já tenham sido recuperadas.
6. O reparo automático possui **passagens por catálogo e R2**, mas falhas não recuperáveis de origem, permissões e catálogo continuam possíveis.
7. O sistema tem endpoint de estatísticas de custo e jobs, mas **não foi comprovada uma atribuição de custo faturado por execução nos três provedores GitHub/GCP/Modal**.
8. Modal e FCM possuem código/configuração real, porém não há comprovação aqui do estado de billing/quotas, segredos e execução da conta externa.

## 3. Classificação da documentação existente

A documentação anterior permanece por razões diferentes. Não atualizar conclusões históricas sem reexecutar os testes.

- **Guias vivos, exigir revisão quando implementação mudar:** `README.md`, `ARCHITECTURE.md`, `API.md`, `DATABASE.md`, `CLOUDFLARE_SETUP.md`, `CLOUD_RUN_SETUP.md`, `NEON_SETUP.md`, `MODAL_SETUP.md`, `ICLOUD_SETUP.md`, `ICLOUD_SESSION_SETUP.md`, `OPERATIONS.md`, `DISASTER_RECOVERY.md`, `COST_MODEL.md`, `LIMITATIONS.md`, `VALIDATION.md`, `PYTO_BRIDGE.md`, `apps/manage/README.md` e `docs/operations/*`.
- **Guias de implementação/processo:** `docs/deployment/*`, `docs/fcm-job-notifications.md`, `docs/notify-jobs.md`, `docs/architecture/CLOUD_RUN_TARGET.md`, `docs/architecture/ingestion-manifest-v11.md`, `docs/DELIVERY.md`, `docs/DEVELOPMENT_CONTRACT.md` e `docs/IMPLEMENTATION_PLAN.md`. Algumas regras são contextuais ou históricas; preferir contrato de código.
- **Histórico imutável de auditoria e evidência:** `docs/audit/*`, `docs/evidence/*` e `docs/previews/*`. Títulos, datas, métricas e claims pertencem à revisão original.
- **Subprojetos e design:** `apps/web/DESIGN_SYSTEM.md`, `apps/web/PWA_BRANDING.md`, `bridges/ios-native/README.md`, `packages/*/README.md`, `services/*/README.md`, `tests/e2e/README.md`. As pastas `services/*` podem representar módulos/contratos legados, não necessariamente serviços deployados independentemente; verificar árvore/código antes de anunciar um microserviço.

## 4. Lacunas de prova e próximos critérios

| Questão | Como comprovar |
|---|---|
| Qual release de fato atende `photos.migos.club`? | Worker deployment, release SHA, headers, `/__app/version` e Cloud Run revision/digest |
| Jobs mantêm cron e backfill atualizados? | lista de Scheduler com status, execuções Cloud Run, outbox, `jobs`/`job_events` e ausência de claims vencidos |
| iCloud reautentica e importa mídia real? | sessão válida com 2FA, lote finito, manifests e mídia testada no R2 |
| Fotos antigas estão legíveis? | auditoria completa de catálogo/R2, verificação hashes e GET privado por amostragem |
| Neon comporta catálogo inteiro? | consumo/índices HNSW, TPS/latência, volume e orçamento em banco real |
| GPU/Modal entrega vetores reais e tags? | deploy/revisões, chamada autenticada, persistência e teste de busca imagem/texto |
| FCM funciona no iOS? | PWA instalada, permissão, token/instalação, evento recebido em background |
| Manage enxerga logs exatos? | IDs de ponta a ponta, JSON da origem, horários UTC, caso real Sentry/GCP/Cloudflare |
| Quanto custou cada execução? | contrato por provedor com custo **faturado** versus estimado, timestamp e plano de cobrança |
| Apple Bridge escreve keywords? | capacidade PhotoKit demonstrada no aparelho, approval, write e verificação Apple posterior |

**Regra editorial:** ao modificar uma rota, política, job, tecnologia, cron, custo ou secret, incluir no mesmo PR o documento técnico correspondente e o teste que comprova o contrato. Documentar separadamente o que foi observado (testes/logs) do que é inferido dos manifests.
