"""Real inference, durable provenance and conservative budget reservations."""

import asyncio
import base64
import hashlib
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError
from sqlalchemy import delete, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gpu.models.adapters import RealModels
from gpu.pipelines.contracts import (
    MAX_IMAGE_BYTES,
    MAX_REQUEST_BYTES,
    ImageInput,
    ImageRequest,
    ImageResponse,
    ImageResult,
    ModelSpec,
    TextEmbedding,
    TextRequest,
)
from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset,
    AssetResource,
    AssetTag,
    Embedding,
    InferenceRun,
    ModelRegistry,
    Setting,
    Tag,
    TagAlias,
    utcnow,
)
from photointel.services.taxonomy import (
    TAXONOMY_VERSION,
    resolve_tag_targets,
    select_predictions,
)
from photointel.storage import get_storage


def model_spec(settings: Settings) -> ModelSpec:
    return ModelSpec(
        joytag_model_id=settings.joytag_model_id,
        joytag_revision=settings.joytag_model_revision,
        siglip_model_id=settings.siglip_model_id,
        siglip_revision=settings.siglip_model_revision,
    )


def estimated_cost(settings: Settings, count: int) -> float:
    return count * settings.gpu_estimated_seconds_per_asset / 3600 * (
        settings.gpu_hourly_cost_estimate
    )


def validate_spending(settings: Settings, count: int) -> float:
    if not settings.gpu_enabled:
        raise AppError(ErrorCode.GPU_UNAVAILABLE, "Inferência está desativada", 503)
    if not 1 <= count <= settings.gpu_max_assets_per_run:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Limite de imagens por execução excedido", 422,
        )
    # Reserve every possible transport retry conservatively before contacting Modal.
    attempts = 3 if settings.inference_backend == "modal" else 1
    cost = estimated_cost(settings, count) * attempts
    if cost > settings.gpu_max_cost_per_run:
        raise AppError(
            ErrorCode.GPU_UNAVAILABLE, "Estimativa excede limite por execução", 409,
        )
    return cost


@asynccontextmanager
async def inference_permit(settings: Settings, count: int) -> AsyncIterator[None]:
    cost = validate_spending(settings, count)
    if settings.inference_backend == "test":
        if settings.app_env != "test":
            raise AppError(
                ErrorCode.FORBIDDEN, "Adaptador sintético restrito a testes", 403,
            )
        yield
        return
    async with SessionLocal() as permit, permit.begin():
        acquired = False
        for slot in range(settings.max_gpu_concurrency):
            acquired = bool(await permit.scalar(
                text("SELECT pg_try_advisory_xact_lock(:slot)"), {"slot": 891000 + slot},
            ))
            if acquired:
                break
        if not acquired:
            raise AppError(
                ErrorCode.GPU_UNAVAILABLE, "Todos os slots de inferência ocupados", 503,
            )
        # Separate transaction commits reservations before any paid external call.
        # Reservations are never refunded automatically after an uncertain network error.
        async with SessionLocal() as ledger, ledger.begin():
            now = datetime.now(UTC)
            keys = [
                (f"gpu_budget_day_{now:%Y-%m-%d}", settings.gpu_daily_budget),
                (f"gpu_budget_month_{now:%Y-%m}", settings.gpu_monthly_budget),
            ]
            for key, limit in sorted(keys):
                await ledger.execute(
                    insert(Setting).values(key=key, value=0).on_conflict_do_nothing(),
                )
                row = await ledger.scalar(select(Setting).where(
                    Setting.key == key,
                ).with_for_update())
                assert row is not None
                reserved = float(row.value)
                if reserved + cost > limit:
                    raise AppError(
                        ErrorCode.GPU_UNAVAILABLE,
                        "Orçamento estimado de inferência esgotado", 409,
                    )
                row.value = reserved + cost
        yield


@lru_cache(maxsize=2)
def cpu_models(spec_json: str, cache: str) -> RealModels:
    from pathlib import Path
    return RealModels(ModelSpec.model_validate_json(spec_json), Path(cache), device="cpu")


def test_vector(value: bytes) -> list[float]:
    """Explicit deterministic test data. Never invoked outside APP_ENV=test."""
    vector = [
        (int.from_bytes(hashlib.sha256(value + i.to_bytes(2, "big")).digest()[:2], "big")
         / 32767.5 - 1)
        for i in range(768)
    ]
    norm = math.sqrt(sum(item * item for item in vector))
    return [item / norm for item in vector]


async def modal_request(path: str, body: dict[str, Any], settings: Settings) -> Any:
    if not settings.modal_endpoint.startswith("https://") or not settings.modal_token:
        raise AppError(
            ErrorCode.GPU_UNAVAILABLE, "Endpoint HTTPS autenticado não configurado", 503,
        )
    payload_size = len(__import__("json").dumps(body).encode())
    if payload_size > MAX_REQUEST_BYTES:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Lote excede limite de transmissão", 422,
        )
    headers = {"Authorization": f"Bearer {settings.modal_token.get_secret_value()}"}
    if settings.modal_proxy_key and settings.modal_proxy_secret:
        headers["Modal-Key"] = settings.modal_proxy_key.get_secret_value()
        headers["Modal-Secret"] = settings.modal_proxy_secret.get_secret_value()
    else:
        raise AppError(
            ErrorCode.GPU_UNAVAILABLE, "Autenticação de borda Modal não configurada", 503,
        )
    async with httpx.AsyncClient(
        timeout=settings.modal_timeout_seconds, follow_redirects=False,
    ) as client:
        for attempt in range(3):
            try:
                response = await client.post(
                    settings.modal_endpoint.rstrip("/") + path, json=body,
                    headers=headers,
                )
                if response.status_code == 200:
                    if len(response.content) > 16 * 1024 * 1024:
                        raise AppError(
                            ErrorCode.INFERENCE_FAILED, "Resposta GPU excessiva", 502,
                        )
                    return response.json()
                if response.status_code not in {429, 502, 503, 504}:
                    raise AppError(
                        ErrorCode.INFERENCE_FAILED,
                        "Serviço de inferência rejeitou a solicitação", 502,
                        {"upstream_status": response.status_code},
                    )
            except (httpx.TimeoutException, httpx.TransportError):
                # No response payload or exception containing credentials is logged.
                pass
            if attempt < 2:
                await asyncio.sleep(.25 * 2 ** attempt)
    raise AppError(
        ErrorCode.GPU_UNAVAILABLE, "Serviço GPU temporariamente indisponível", 503,
    )


async def embed_text(text: str, settings: Settings) -> TextEmbedding:
    validate_spending(settings, 1)
    request = TextRequest(models=model_spec(settings), text=text)
    async with inference_permit(settings, 1):
        try:
            if settings.inference_backend == "test":
                return TextEmbedding(
                    embedding=test_vector(text.encode()), runtime_ms=0,
                    model_revision=settings.siglip_model_revision,
                )
            if settings.inference_backend == "cpu":
                models = await asyncio.to_thread(
                    cpu_models, request.models.model_dump_json(),
                    str(settings.model_cache_directory),
                )
                return await asyncio.to_thread(models.embed_text, text)
            result = TextEmbedding.model_validate(await modal_request(
                "/embed-text", request.model_dump(mode="json"), settings,
            ))
            if result.model_revision != settings.siglip_model_revision:
                raise ValueError("Incompatible text model revision")
            return result
        except (ValidationError, ValueError):
            raise AppError(
                ErrorCode.INFERENCE_FAILED, "Resposta semântica inválida", 502,
            ) from None


async def image_inference(request: ImageRequest, settings: Settings) -> ImageResponse:
    async with inference_permit(settings, len(request.images)):
        if settings.inference_backend == "test":
            return ImageResponse(results=[
                ImageResult(
                    asset_id=item.asset_id, input_revision=item.input_revision,
                    embedding=test_vector(base64.b64decode(item.image_base64)),
                    model_revision=settings.siglip_model_revision,
                    joytag_revision=settings.joytag_model_revision,
                    probabilities={"outdoors": .92, "sky": .2, "black_shirt": .03},
                    runtime_ms=0, joytag_runtime_ms=0,
                ) for item in request.images
            ], total_runtime_ms=0)
        if settings.inference_backend == "cpu":
            models = await asyncio.to_thread(
                cpu_models, request.models.model_dump_json(),
                str(settings.model_cache_directory),
            )
            return await asyncio.to_thread(models.infer, request)
        try:
            return ImageResponse.model_validate(await modal_request(
                "/infer-images", request.model_dump(mode="json"), settings,
            ))
        except (ValidationError, ValueError):
            raise AppError(
                ErrorCode.INFERENCE_FAILED, "Resposta GPU inválida", 502,
            ) from None


async def registry(session: AsyncSession, settings: Settings) -> tuple[UUID, UUID]:
    await session.execute(text("SELECT pg_advisory_xact_lock(891100)"))
    from photointel.services.taxonomy import migrate_taxonomy
    await migrate_taxonomy(session)
    ids: list[UUID] = []
    for name, revision, architecture, dimension, capabilities in [
        (settings.joytag_model_id, settings.joytag_model_revision, "JoyTag-ViT-B16-448",
         None, ["tag_classification"]),
        (settings.siglip_model_id, settings.siglip_model_revision,
         "SigLIP2-base-patch16-224",
         768, ["image_embedding", "text_embedding", "multilingual"]),
    ]:
        await session.execute(update(ModelRegistry).where(
            ModelRegistry.provider == "huggingface", ModelRegistry.model_name == name,
            ModelRegistry.revision != revision,
        ).values(active=False))
        statement = insert(ModelRegistry).values(
            provider="huggingface", model_name=name, revision=revision,
            architecture=architecture, embedding_dimension=dimension,
            parameters={
                "taxonomy_version": TAXONOMY_VERSION, "normalized": dimension is not None,
            },
            capabilities=capabilities, active=True,
        ).on_conflict_do_update(
            index_elements=["provider", "model_name", "revision"],
            set_={"active": True},
        ).returning(ModelRegistry.id)
        ids.append((await session.execute(statement)).scalar_one())
    return ids[0], ids[1]


async def persist_result(
    session: AsyncSession, asset: Asset, result: ImageResult,
    joytag_id: UUID, siglip_id: UUID, settings: Settings,
    taxonomy_settings: dict[str, Any],
) -> None:
    if (
        result.asset_id != asset.id
        or result.input_revision != asset.representation_revision
        or result.joytag_revision != settings.joytag_model_revision
        or result.model_revision != settings.siglip_model_revision
    ):
        raise AppError(
            ErrorCode.INFERENCE_FAILED, "Resultado não corresponde à revisão atual", 409,
        )
    for model_id, runtime, raw in [
        (joytag_id, result.joytag_runtime_ms, {
            "probabilities": result.probabilities, "taxonomy_version": TAXONOMY_VERSION,
            "retention": "until_explicit_operator_purge",
        }),
        (siglip_id, result.runtime_ms, {
            "dimension": len(result.embedding), "normalized": True,
        }),
    ]:
        run = insert(InferenceRun).values(
            asset_id=asset.id, model_id=model_id, input_revision=result.input_revision,
            status="completed", runtime_ms=runtime, raw_predictions=raw,
            completed_at=utcnow(),
        )
        await session.execute(run.on_conflict_do_update(
            index_elements=["asset_id", "model_id", "input_revision"],
            set_={"status": "completed", "runtime_ms": runtime,
                  "raw_predictions": raw, "completed_at": utcnow(), "error": None},
        ))
    statement = insert(Embedding).values(
        asset_id=asset.id, model_id=siglip_id, input_revision=result.input_revision,
        vector=result.embedding,
    )
    await session.execute(statement.on_conflict_do_update(
        index_elements=["asset_id", "model_id", "input_revision"],
        set_={"vector": result.embedding},
    ))
    await persist_tags(
        session, asset, result.probabilities, result.joytag_revision,
        settings, taxonomy_settings,
    )
    asset.classification_status = "completed"
    asset.last_successful_inference = utcnow()
    asset.last_error = None
    await session.flush()


async def persist_tags(
    session: AsyncSession, asset: Asset, probabilities: dict[str, float],
    revision: str, settings: Settings, taxonomy_settings: dict[str, Any],
) -> None:
    predictions = select_predictions(
        probabilities, settings.joytag_threshold, settings.joytag_max_tags,
        taxonomy_settings.get("taxonomy_categories"),
        taxonomy_settings.get("taxonomy_overrides"),
        taxonomy_settings.get("taxonomy_compound_rules"),
    )
    # Retained raw results allow removing outdated threshold assertions without
    # modifying user decisions or losing model evidence.
    chosen_keys = [tag.canonical_key for tag, _ in predictions]
    chosen_ids = select(Tag.id).where(Tag.canonical_key.in_(chosen_keys))
    await session.execute(delete(AssetTag).where(
        AssetTag.asset_id == asset.id, AssetTag.origin == "joytag",
        AssetTag.model_version == revision, AssetTag.user_status == "unreviewed",
        AssetTag.review_status == "pending", AssetTag.tag_id.not_in(chosen_ids),
    ))
    if predictions:
        tags = [{
            "canonical_key": tag.canonical_key, "display_name": tag.display_name,
            "category": tag.category, "is_sensitive": tag.is_sensitive,
            # Per-tag threshold is an independent override; global/category
            # defaults have already been applied above.
            "minimum_confidence": 0,
        } for tag, _ in predictions]
        await session.execute(insert(Tag).values(tags).on_conflict_do_nothing(
            index_elements=["canonical_key"],
        ))
        existing = (await session.scalars(select(Tag).where(
            Tag.canonical_key.in_([tag.canonical_key for tag, _ in predictions]),
        ))).all()
        by_key = {tag.canonical_key: tag for tag in existing}
        targets = await resolve_tag_targets(session, list(existing))
        rows_by_id: dict[UUID, dict[str, Any]] = {}
        aliases = []
        for mapped, probability in predictions:
            original = by_key[mapped.canonical_key]
            tag = targets[original.id]
            if mapped.parent_key and tag.parent_id is None:
                parent = await session.scalar(select(Tag.id).where(
                    Tag.canonical_key == mapped.parent_key,
                ))
                if parent and parent != tag.id:
                    tag.parent_id = parent
            if not tag.enabled or probability < tag.minimum_confidence:
                continue
            assertion = {
                "asset_id": asset.id, "tag_id": tag.id, "origin": "joytag",
                "model_version": revision, "confidence": probability,
                "user_status": "unreviewed", "review_status": "pending",
            }
            previous = rows_by_id.get(tag.id)
            if previous is None or probability > previous["confidence"]:
                rows_by_id[tag.id] = assertion
            aliases.extend({
                "tag_id": tag.id,
                "language": "en" if alias == mapped.canonical_key.replace("_", " ")
                else "pt-BR",
                "alias": alias,
                "alias_type": "display",
            } for alias in mapped.aliases)
        if rows_by_id:
            assertion_insert = insert(AssetTag).values(list(rows_by_id.values()))
            await session.execute(assertion_insert.on_conflict_do_update(
                index_elements=["asset_id", "tag_id", "origin", "model_version"],
                # Never overwrite independent user decisions or existing review state.
                set_={
                    "confidence": assertion_insert.excluded.confidence,
                    "updated_at": utcnow(),
                },
            ))
        if aliases:
            await session.execute(
                insert(TagAlias).values(aliases).on_conflict_do_nothing(),
            )


async def infer_assets(
    session: AsyncSession, asset_ids: list[UUID], settings: Settings,
) -> dict[str, Any]:
    validate_spending(settings, len(asset_ids))
    if len(set(asset_ids)) != len(asset_ids):
        raise AppError(ErrorCode.INVALID_REQUEST, "Lote contém ativos repetidos", 422)
    if len(asset_ids) > min(settings.batch_size, 32):
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Divida a execução em lotes menores", 422,
        )
    assets = (await session.scalars(select(Asset).where(Asset.id.in_(asset_ids)))).all()
    if len(assets) != len(asset_ids):
        raise AppError(ErrorCode.NOT_FOUND, "Ativo não encontrado", 404)
    joytag_id, siglip_id = await registry(session, settings)
    existing = (await session.execute(select(
        InferenceRun.asset_id, InferenceRun.model_id, InferenceRun.input_revision,
    ).where(
        InferenceRun.asset_id.in_(asset_ids), InferenceRun.status == "completed",
        InferenceRun.model_id.in_([joytag_id, siglip_id]),
    ))).all()
    done = set(existing)
    pending = [asset for asset in assets if not all(
        (asset.id, model_id, asset.representation_revision) in done
        for model_id in (joytag_id, siglip_id)
    )]
    if not pending:
        return {"completed": 0, "skipped": len(assets), "gpu_runtime_ms": 0}
    resources = (await session.scalars(select(AssetResource).where(
        AssetResource.asset_id.in_([asset.id for asset in pending]),
        AssetResource.resource_type.in_(["inference_input", "preview_large"]),
        AssetResource.status == "available",
    ))).all()
    storage = get_storage()
    inputs = []
    bytes_transferred = 0
    for asset in pending:
        candidates = [resource for resource in resources if (
            resource.asset_id == asset.id
            and resource.revision == asset.representation_revision
        )]
        candidates.sort(key=lambda resource: resource.resource_type != "inference_input")
        if not candidates or not candidates[0].object_key:
            raise AppError(
                ErrorCode.NOT_FOUND, "Representação para inferência indisponível", 409,
            )
        resource = candidates[0]
        if resource.byte_size and resource.byte_size > MAX_IMAGE_BYTES:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Representação de inferência excessiva", 422,
            )
        data = await asyncio.to_thread(storage.get, str(resource.object_key))
        if len(data) > MAX_IMAGE_BYTES:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Representação de inferência excessiva", 422,
            )
        bytes_transferred += len(data)
        inputs.append(ImageInput(
            asset_id=asset.id, input_revision=asset.representation_revision,
            image_base64=base64.b64encode(data).decode("ascii"),
        ))
    response = await image_inference(ImageRequest(
        models=model_spec(settings), images=inputs,
        batch_size=min(settings.batch_size, 32),
    ), settings)
    expected = {asset.id for asset in pending}
    received = [result.asset_id for result in response.results]
    if set(received) != expected or len(received) != len(expected):
        raise AppError(
            ErrorCode.INFERENCE_FAILED, "Resposta GPU contém ativos divergentes", 502,
        )
    taxonomy_settings = {
        row.key: row.value for row in (await session.scalars(select(Setting).where(
            Setting.key.in_([
                "taxonomy_categories", "taxonomy_overrides", "taxonomy_compound_rules",
            ]),
        ))).all()
    }
    by_id = {asset.id: asset for asset in pending}
    for result in response.results:
        await persist_result(
            session, by_id[result.asset_id], result, joytag_id, siglip_id,
            settings, taxonomy_settings,
        )
    from photointel.services.catalog import refresh_search_document
    await refresh_search_document(session, [asset.id for asset in pending])
    return {
        "completed": len(pending), "skipped": len(assets) - len(pending),
        "gpu_runtime_ms": response.total_runtime_ms,
        "bytes_transferred": bytes_transferred,
        "estimated_cost": estimated_cost(settings, len(pending)),
    }


async def rethreshold_assets(
    session: AsyncSession, asset_ids: list[UUID], settings: Settings,
) -> dict[str, int]:
    """Reapply taxonomy to retained predictions, without a GPU call or budget use."""
    if not 1 <= len(asset_ids) <= 1000:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Revisão limitada a 1000 ativos por lote", 422,
        )
    rows = (await session.execute(select(Asset, InferenceRun).join(
        InferenceRun, InferenceRun.asset_id == Asset.id,
    ).join(ModelRegistry, InferenceRun.model_id == ModelRegistry.id).where(
        Asset.id.in_(asset_ids), InferenceRun.status == "completed",
        ModelRegistry.model_name == settings.joytag_model_id,
        ModelRegistry.revision == settings.joytag_model_revision,
        InferenceRun.input_revision == Asset.representation_revision,
    ))).all()
    taxonomy_settings = {
        row.key: row.value for row in (await session.scalars(select(Setting).where(
            Setting.key.in_([
                "taxonomy_categories", "taxonomy_overrides", "taxonomy_compound_rules",
            ]),
        ))).all()
    }
    updated = []
    for asset, run in rows:
        probabilities = run.raw_predictions.get("probabilities")
        if not isinstance(probabilities, dict):
            continue
        await persist_tags(
            session, asset, probabilities, settings.joytag_model_revision,
            settings, taxonomy_settings,
        )
        updated.append(asset.id)
    if updated:
        from photointel.services.catalog import refresh_search_document
        await refresh_search_document(session, updated)
    return {"updated": len(updated), "unavailable": len(set(asset_ids)) - len(updated)}


async def record_inference_failure(
    session: AsyncSession, asset_id: UUID, settings: Settings, error_code: str,
) -> None:
    """Called in worker's failure transaction after its result transaction rolls back."""
    asset = await session.get(Asset, asset_id)
    if asset is None or not settings.gpu_enabled:
        return
    model_ids = await registry(session, settings)
    for model_id in model_ids:
        statement = insert(InferenceRun).values(
            asset_id=asset_id, model_id=model_id,
            input_revision=asset.representation_revision,
            status="failed", error=error_code[:128], raw_predictions={},
        )
        await session.execute(statement.on_conflict_do_update(
            index_elements=["asset_id", "model_id", "input_revision"],
            set_={"status": "failed", "error": error_code[:128]},
            where=InferenceRun.status != "completed",
        ))
    asset.classification_status = "failed"
    asset.last_error = error_code[:128]
