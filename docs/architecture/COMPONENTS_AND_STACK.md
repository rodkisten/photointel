# Componentes, bibliotecas e organização de código

**Base auditada:** `22c01bc` em 04/11/2026. Versões são as declaradas nos manifests, não necessariamente as efetivamente instaladas em produção.

## Monorepo

```text
apps/
  api/src/photointel/      # FastAPI, SQLAlchemy, routers, serviços, jobs
  web/                     # React PWA do catálogo, Vite, service worker
  manage/                  # React/TanStack Router + Worker administrativo
bridges/pyto/              # Apple Bridge opcional com integração PhotoKit
gpu/                       # contrato/modelos, Modal e serviço de inferência
infra/
  cloudflare/              # proxy Worker, headers, configuração
  gcp/                     # render, bootstrap, release, IAM, migrações
  migrations/versions/     # Alembic sequencial
  docker/, scripts/, notify/, oracle/
packages/
  contracts/openapi.json   # contrato para cliente tipado
  configuration/           # pins e metadados de checkpoints
  icloudpd-source/         # cópia de módulos do upstream pinado
  taxonomy/                # taxonomia e migrações
.github/workflows/         # validação, deploy, migração e monitoramento
tests/                     # unitários, integrações, GPU, E2E
docs/                      # arquitetura, decisões, operação, evidências
```

## Linguagens e runtime

| Área | Stack conferida | Particularidades |
|---|---|---|
| API | Python ≥3.12 <3.14, FastAPI, Uvicorn, Pydantic 2, pydantic-settings | endpoints privados sob `/v1`, OpenAPI somente fora de produção, limites de body |
| Persistência | SQLAlchemy 2 async, asyncpg, psycopg, Alembic, PostgreSQL, pgvector | modo Neon pooler transaction/NullPool; conexão direta para migração |
| Mídia | Pillow, pillow-heif, OpenCV, NumPy, imagehash | orientação EXIF, WebP/AVIF conforme codec, pHash, avaliação heurística |
| Apple | icloudpd 1.32.3 + código local licenciado, sessão criptografada | SDK não oficial; dispositivos e 2FA não são simuláveis em produção |
| GPU | Modal 1.x, PyTorch, Transformers 5.10.2, JoyTag, SigLIP 2 | `gpu/modal_app.py` pinado separadamente, T4, um container máximo no manifesto atual |
| Web principal | React 19, TypeScript 5.9, Vite 7, React Router 7 | Tailwind CSS 4, Zustand 5, TanStack Query 5 e Virtual 3 |
| Manage | React 19, TanStack Router 1.170.46, React Query 5, CodeMirror 6 | Worker Cloudflare, editor .env/JSON, Radix, Tailwind 4 |
| UI | Tailwind 4, Radix, Lucide, CVA, tokens locais | biblioteca de componentes **estilo shadcn**, não confundir com instalação integral de shadcn CLI |
| Qualidade | Ruff, mypy, pytest, ESLint, TypeScript, Vitest, Playwright, Prettier | checks em `Makefile`, scripts npm, Actions |
| Telemetria | structlog, Sentry SDK / @sentry/react, Cloud Logging, logs Worker | correlation ID, links cruzados, limites para dados sensíveis |

O `pyproject.toml` define grupos `dev`, `ingest` e `gpu`. O `gpu/modal_app.py` contém pins de imagem específicos; mudar apenas o lock do backend não altera automaticamente o container Modal. O `apps/web/package.json` e `apps/manage/package.json` possuem lockfiles próprios.

## Servidores e módulos

### FastAPI

- `main.py`: instancia aplicação, middlewares, correlation ID, handlers, readiness e routers.
- `auth.py`: validação Cloudflare Access; produção não deve confiar em header de e-mail arbitrário.
- `config.py`: variáveis tipadas e invariantes; `effective_settings` agrega overrides persistidos.
- `routers/catalog.py`: assets, mídia, tags, álbuns, duplicatas, saved searches, busca.
- `routers/operations.py`: jobs, batches, ingestão, capacidades, estatísticas, exportação.
- `routers/job_control.py`: pausa/retomada/cancelamento e operação global da fila.
- `routers/preview_audit.py`: estado de previews e automação.
- `routers/bridge.py`: enrollment, mapeamentos, propostas, aprovação, ACK e verificação.
- `routers/push.py`: registro de instalação Firebase, teste e status.
- `routers/observability.py` e `routers/readiness.py`: diagnósticos e observabilidade.

### Serviços de backend

| Serviço | Papel |
|---|---|
| `discovery.py`, `ingestion.py` | snapshots Apple, manifesto, dedupe, import policy e agendamento |
| `download_cache.py`, `media.py` | integridade da fonte, decode, recursos derivados, reparo e órfãos |
| `worker.py`, `jobs.py`, `leases.py` | fila, transitions, idempotência, heartbeats, fencing |
| `task_runner.py` | processos Cloud Run finitos: discover/backfill/worker/maintenance/migrate |
| `outbox.py`, `cloud_dispatch.py` | intenção transacional e Google Jobs API via ADC |
| `inference.py`, `query_cache.py`, `search.py` | modelos, persistência, embeddings textuais, busca/filtros |
| `taxonomy.py`, `duplicates.py`, `apple_sync.py` | revisão de tags, imagens semelhantes e contrato Apple |
| `session_store.py`, `session_admin.py`, `icloud_web_auth.py` | snapshots criptografados, login/2FA e reconexão |
| `fcm_notify.py`, `telegram_notify.py`, `job_notify.py` | fan-out de notificações e cursores duráveis |
| `backup.py`, `verification.py` | backup verificável e requisitos de operações sensíveis |

### GitHub / Cloudflare

- `infra/cloudflare/cloud-run-proxy/worker.mjs` é o único relay do **PhotoIntel web**; protege endpoints especiais, entrega assets, encaminha somente caminhos de API autorizados e gera correlation IDs.
- `apps/manage/src/worker.ts` executa API administrativa e serve a SPA do Manage; `auth.ts` valida JWT no edge, `api.ts` orquestra provedores e `routes/secrets.ts` gerencia versões de segredos.
- `apps/manage/src/router.tsx` define rotas reais: `/`, `/deploys`, `/deploys/$runId`, `/logs`, `/environment`, `/secrets`, `/icloud`, `/system`. Parâmetros `?tab=` legados redirecionam para páginas novas.
- `apps/web/src/App.tsx` ainda usa React Router; as rotas são `/library`, `/search`, `/tags`, `/albums`, `/duplicates`, `/jobs`, `/icloud`, `/bridge`, `/settings` e `/setup`.

## Como adicionar uma funcionalidade

1. Adicionar modelo/migração se alterar estado durável. Evitar sincronizar esquema via `create_all` em produção.
2. Adicionar endpoint/validação em router e serviço; documentar auth, limites, status HTTP e erro.
3. Atualizar `packages/contracts/openapi.json` e regenerar `apps/web/src/api/schema.d.ts` quando o contrato mudar.
4. Alterar a página e hooks de UI mantendo estados de falha e readiness explícitos.
5. Criar teste unitário, de integração com Postgres real, de UI e/ou E2E conforme a fronteira alterada.
6. Revisar permissões IAM/WIF, env não secretos e Secret Manager quando houver nova integração.
7. Atualizar o fluxograma e a tabela de implementação em [Mapa de referências](IMPLEMENTATION_REFERENCE.md).

Para detalhes de dados e do pipeline, siga [Dados](DATA_AND_INFERENCE.md) e [Ingestão](INGESTION_AND_RECOVERY.md).
