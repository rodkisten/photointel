# Contrato interno de implementação

Python package: `apps/api/src/photointel`, instalado pelo pyproject raiz com uv.
Configuração: `photointel.config.Settings`, `get_settings()`.
Database: `photointel.database.Base`, `SessionLocal`, `get_session()` (AsyncSession).
Models: `photointel.models` exporta Library, Asset, AssetResource, AssetMetadata,
Tag, TagAlias, AssetTag, ModelRegistry, InferenceRun, Embedding, Job, JobBatch,
IngestionRun, DeviceMapping, BridgeDevice, MetadataSnapshot, SyncOperation,
AuditEvent, Album, AlbumAsset, DuplicateGroup, DuplicateMember, Setting,
SavedSearch, JobEvent, WorkerState. UUID IDs usam uuid.UUID. Datas em UTC.

Auth: `photointel.auth.require_identity` dependency; identity tem subject e email.
Storage: `photointel.storage.get_storage()` com put(key, bytes, mime), get(key),
delete(key), presign_get(key, expires=60); operações síncronas são chamadas via
asyncio.to_thread. SDK não expõe segredos e não aceita keys arbitrárias da API.

Services: código runtime fica em `photointel.services`; diretórios `services/`
contêm launchers e documentação. Routers são APIRouter em `photointel.routers`.
Apple: `photointel.routers.bridge.router`, `photointel.services.apple_sync`.
Worker: `photointel.services.jobs`, `worker`, `ingestion`, `media`.
GPU interface independente em `gpu/` + client `photointel.services.inference`.

API URLs sob /v1; listagens `{items: [...], next_cursor: string|null}`.
Datas são ISO8601; status capabilities `{state, reason}`. Frontend gera client
em `apps/web/src/api/schema.d.ts` usando OpenAPI em packages/contracts/openapi.json.
Frontend requests usam credentials same-origin; local dev Vite proxy /v1 /health.

Nomes dos campos seguem o prompt. Asset: visibility_status='active',
ingestion_status='pending', content_revision='1', representation_revision='1',
classification_status='pending', last_error nullable. AssetResource.resource_type
identifica thumbnail_small, thumbnail_medium, preview_large, inference_input.
ModelRegistry.revision obrigatório; embeddings dimensão checkpoint 768 para
google/siglip2-base-patch16-224 após verificação e migração.

Job: job_type, asset_id nullable, payload JSON, worker_id nullable, progress JSON,
priority int default 0, attempts 0, maximum_attempts 3, scheduled_at UTC, status
queued. JobBatch: total_assets/completed/failed/skipped, status, counters.
Tag canonical_key unique; AssetTag unique asset_id/tag_id/origin/model_version,
user_status='unreviewed', review_status='pending'. Rejeições têm row origin user.
AlbumAsset chave composta album_id/asset_id. Setting chave string + value JSON.

Não editar arquivos de outro responsável sem coordenar. Escrever testes próprios
em arquivos separados. Nenhum stub silencioso, resposta inventada ou operação
destrutiva sobre fotos. Documentação final em português brasileiro.
