"""Persisted operations, SSE, bounded administrative actions and diagnostics."""

import asyncio
import csv
import io
import json
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_identity
from photointel.config import get_settings
from photointel.database import SessionLocal, get_session
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset, AssetResource, AssetTag, AuditEvent, BridgeDevice, Embedding,
    InferenceRun, IngestionRun, Job, JobBatch, JobEvent, Library, Setting,
    SyncOperation, Tag, WorkerState,
)
from photointel.schemas import (
    IngestionInput, JobOut, Page, ReindexInput, SettingsPatch,
)
from photointel.serializers import decode_cursor, encode_cursor, row_dict
from photointel.services.catalog import audit
from photointel.services.runtime_settings import effective_settings
from photointel.storage import get_storage

router = APIRouter(dependencies=[Depends(require_identity)])
Session = Annotated[AsyncSession, Depends(get_session)]
Actor = Annotated[Identity, Depends(require_identity)]


def emit_job_event(session: AsyncSession, job: Job) -> None:
    session.add(JobEvent(
        job_id=job.id, status=job.status,
        payload={"job_id": str(job.id), "status": job.status,
                 "batch_id": str(job.batch_id) if job.batch_id else None},
    ))


@router.get("/jobs", response_model=Page[JobOut], tags=["jobs"])
async def jobs(
    session: Session, status: str | None = Query(None, max_length=32),
    job_type: str | None = Query(None, max_length=64),
    limit: int = Query(60, ge=1, le=200), cursor: str | None = None,
) -> Page[JobOut]:
    query = select(Job)
    if status:
        query = query.where(Job.status == status)
    if job_type:
        query = query.where(Job.job_type == job_type)
    if cursor:
        query = query.where(Job.id < UUID(decode_cursor(cursor)["id"]))
    rows = list((await session.scalars(query.order_by(Job.id.desc()).limit(limit + 1))).all())
    return Page(
        items=[JobOut.model_validate(job) for job in rows[:limit]],
        next_cursor=encode_cursor({"id": rows[limit - 1].id}) if len(rows) > limit else None,
    )


@router.get("/jobs/events", tags=["jobs"])
async def job_events(
    request: Request,
    last_event_id: str | None = Header(None),
    after: int = Query(0, ge=0),
) -> StreamingResponse:
    try:
        position = int(last_event_id) if last_event_id else after
        if position < 0:
            raise ValueError("Negative event id")
    except ValueError as exc:
        raise AppError(ErrorCode.INVALID_REQUEST, "ID de evento inválido", 422) from exc

    async def stream() -> Any:
        nonlocal position
        last_ping = time.monotonic()
        # Close and reconnect periodically, so JWT expiration/rotation is revalidated.
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline and not await request.is_disconnected():
            async with SessionLocal() as session:
                events = (await session.scalars(select(JobEvent).where(
                    JobEvent.id > position
                ).order_by(JobEvent.id).limit(200))).all()
            for event in events:
                position = event.id
                payload = {"id": event.id, "job_id": str(event.job_id),
                           "status": event.status, **event.payload}
                yield f"id: {event.id}\nevent: job\ndata: {json.dumps(payload)}\n\n"
            if time.monotonic() - last_ping > 15:
                yield ": heartbeat\n\n"
                last_ping = time.monotonic()
            await asyncio.sleep(1)
        yield "event: reconnect\ndata: {}\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"},
    )


@router.post("/jobs/reindex", tags=["jobs"])
async def reindex(body: ReindexInput, session: Session, identity: Actor) -> dict[str, Any]:
    from photointel.services.jobs import enqueue_job
    settings = await effective_settings(session)
    limit = len(body.asset_ids) if body.asset_ids else body.limit
    if limit > 100 and not body.confirm_large_batch:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Confirme explicitamente reprocessamento acima de 100 fotos", 409,
        )
    has_gpu = any(kind.endswith("_inference") for kind in body.job_types)
    if has_gpu and not settings.gpu_enabled:
        raise AppError(ErrorCode.GPU_UNAVAILABLE, "Ative e configure GPU antes de reindexar IA", 409)
    if has_gpu and limit > settings.gpu_max_assets_per_run:
        raise AppError(ErrorCode.INVALID_REQUEST, "Lote excede limite GPU por execução", 422)
    estimate = (
        limit * settings.gpu_estimated_seconds_per_asset
        * settings.gpu_hourly_cost_estimate / 3600
    ) if has_gpu else 0
    if estimate > settings.gpu_max_cost_per_run:
        raise AppError(ErrorCode.INVALID_REQUEST, "Lote excede orçamento estimado", 409)
    query = select(Asset).where(Asset.media_type != "video")
    if body.asset_ids:
        query = query.where(Asset.id.in_(body.asset_ids))
    assets = (await session.scalars(query.order_by(Asset.id).limit(limit))).all()
    batch = JobBatch(
        name="Reprocessamento", total_assets=len(assets), estimated_cost=estimate,
    )
    session.add(batch)
    await session.flush()
    for asset in assets:
        for job_type in set(body.job_types):
            await enqueue_job(
                session, job_type=job_type, asset_id=asset.id,
                payload={"force": True}, batch_id=batch.id,
                idempotency_key=f"reindex:{batch.id}:{asset.id}:{job_type}",
            )
    audit(session, identity, "jobs.reindex", batch_id=str(batch.id),
          assets=len(assets), estimated_cost=estimate)
    await session.commit()
    return row_dict(batch)


@router.get("/jobs/{job_id}", response_model=JobOut, tags=["jobs"])
async def job_detail(job_id: UUID, session: Session) -> JobOut:
    job = await session.get(Job, job_id)
    if not job:
        raise AppError(ErrorCode.NOT_FOUND, "Job não encontrado", 404)
    return JobOut.model_validate(job)


@router.post("/jobs/{job_id}/retry", response_model=JobOut, tags=["jobs"])
async def retry_job(job_id: UUID, session: Session, identity: Actor) -> JobOut:
    job = await session.scalar(select(Job).where(Job.id == job_id).with_for_update())
    if not job:
        raise AppError(ErrorCode.NOT_FOUND, "Job não encontrado", 404)
    if job.status not in {"failed", "cancelled"}:
        raise AppError(ErrorCode.INVALID_REQUEST, "Apenas jobs finais podem ser reenfileirados", 409)
    job.status = "queued"
    job.attempts = 0
    job.scheduled_at = datetime.now(UTC)
    job.finished_at = None
    job.lease_until = None
    job.worker_id = None
    job.error_code = None
    job.error_details = None
    emit_job_event(session, job)
    audit(session, identity, "job.retry", job.asset_id, job_id=str(job.id))
    await session.commit()
    return JobOut.model_validate(job)


@router.post("/jobs/{job_id}/cancel", response_model=JobOut, tags=["jobs"])
async def cancel_job(job_id: UUID, session: Session, identity: Actor) -> JobOut:
    job = await session.scalar(select(Job).where(Job.id == job_id).with_for_update())
    if not job:
        raise AppError(ErrorCode.NOT_FOUND, "Job não encontrado", 404)
    if job.status == "completed":
        raise AppError(ErrorCode.INVALID_REQUEST, "Job já foi concluído", 409)
    job.status = "cancelled"
    job.finished_at = datetime.now(UTC)
    job.lease_until = None
    job.worker_id = None
    emit_job_event(session, job)
    audit(session, identity, "job.cancel", job.asset_id, job_id=str(job.id))
    await session.commit()
    return JobOut.model_validate(job)


@router.get("/job-batches", tags=["jobs"])
async def batches(session: Session, limit: int = Query(30, ge=1, le=100)) -> dict[str, Any]:
    return {"items": [row_dict(row) for row in (await session.scalars(
        select(JobBatch).order_by(JobBatch.created_at.desc()).limit(limit)
    )).all()], "next_cursor": None}


@router.get("/job-batches/{batch_id}", tags=["jobs"])
async def batch_detail(batch_id: UUID, session: Session) -> dict[str, Any]:
    batch = await session.get(JobBatch, batch_id)
    if not batch:
        raise AppError(ErrorCode.NOT_FOUND, "Lote não encontrado", 404)
    counts = {status: count for status, count in (await session.execute(select(
        Job.status, func.count(Job.id)
    ).where(
        Job.batch_id == batch_id
    ).group_by(Job.status))).all()}
    return {**row_dict(batch), "job_counts": counts}


async def change_batch(
    batch_id: UUID, session: AsyncSession, identity: Identity, pause: bool,
) -> dict[str, Any]:
    batch = await session.scalar(select(JobBatch).where(
        JobBatch.id == batch_id
    ).with_for_update())
    if not batch:
        raise AppError(ErrorCode.NOT_FOUND, "Lote não encontrado", 404)
    batch.status = "paused" if pause else "queued"
    eligible = ["queued", "retrying"] if pause else ["paused"]
    affected = (await session.scalars(select(Job).where(
        Job.batch_id == batch_id, Job.status.in_(eligible)
    ).with_for_update())).all()
    for job in affected:
        job.status = "paused" if pause else "queued"
        emit_job_event(session, job)
    audit(session, identity, "batch.pause" if pause else "batch.resume",
          batch_id=str(batch_id))
    await session.commit()
    return row_dict(batch)


@router.post("/job-batches/{batch_id}/pause", tags=["jobs"])
async def pause_batch(batch_id: UUID, session: Session, identity: Actor) -> dict[str, Any]:
    return await change_batch(batch_id, session, identity, True)


@router.post("/job-batches/{batch_id}/resume", tags=["jobs"])
async def resume_batch(batch_id: UUID, session: Session, identity: Actor) -> dict[str, Any]:
    return await change_batch(batch_id, session, identity, False)


async def ingestion_state(session: AsyncSession) -> dict[str, Any]:
    settings = await effective_settings(session)
    paused = await session.get(Setting, "ingestion_paused")
    last = await session.scalar(select(IngestionRun).order_by(
        IngestionRun.started_at.desc()
    ).limit(1))
    last_success = await session.scalar(select(IngestionRun).where(
        IngestionRun.status == "completed"
    ).order_by(IngestionRun.finished_at.desc()).limit(1))
    from photointel.services.ingestion import authentication_state
    auth = await asyncio.to_thread(authentication_state, settings)
    return {
        "enabled": settings.icloud_enabled, "paused": bool(paused and paused.value),
        "authentication": auth, "selected_library": settings.icloud_library,
        "interval_minutes": settings.ingestion_interval_minutes,
        "import_limit": settings.ingestion_import_limit,
        "last_run": row_dict(last) if last else None,
        "last_successful_sync": last_success.finished_at if last_success else None,
        "next_scheduled_sync": (
            last.started_at + timedelta(minutes=settings.ingestion_interval_minutes)
            if last and settings.icloud_enabled and not (paused and paused.value) else None
        ),
    }


@router.get("/ingestion/status", tags=["ingestion"])
async def ingestion_status(session: Session) -> dict[str, Any]:
    return await ingestion_state(session)


@router.get("/ingestion/health", tags=["ingestion"])
async def ingestion_health(session: Session) -> dict[str, Any]:
    state = await ingestion_state(session)
    return {
        "authentication": state["authentication"], "enabled": state["enabled"],
        "recovery": "Execute make icloud-auth por SSH se a sessão expirou.",
    }


@router.get("/ingestion/runs", tags=["ingestion"])
async def ingestion_runs(
    session: Session, limit: int = Query(30, ge=1, le=100), cursor: str | None = None,
) -> dict[str, Any]:
    query = select(IngestionRun)
    if cursor:
        query = query.where(IngestionRun.id < UUID(decode_cursor(cursor)["id"]))
    rows = list((await session.scalars(query.order_by(
        IngestionRun.id.desc()
    ).limit(limit + 1))).all())
    return {
        "items": [row_dict(row) for row in rows[:limit]],
        "next_cursor": encode_cursor({"id": rows[limit - 1].id}) if len(rows) > limit else None,
    }


@router.post("/ingestion/start", status_code=202, tags=["ingestion"])
async def start_ingestion(
    body: IngestionInput, session: Session, identity: Actor,
) -> dict[str, Any]:
    from photointel.services.jobs import enqueue_job
    settings = await effective_settings(session)
    if body.source == "fixture" and settings.app_env not in {"test", "development"}:
        raise AppError(ErrorCode.FORBIDDEN, "Ingestão de fixture é exclusiva do ambiente local", 403)
    if body.source == "icloud" and not settings.icloud_enabled:
        raise AppError(ErrorCode.ICLOUD_ACCESS_DENIED, "Configure e habilite o iCloud no host", 409)
    if body.limit > settings.ingestion_import_limit and not body.confirm_expansion:
        raise AppError(ErrorCode.INVALID_REQUEST, "Confirme expansão do limite inicial", 409)
    existing = await session.scalar(select(Job.id).where(
        Job.job_type == "icloud_discovery",
        Job.status.in_(["queued", "preparing", "running", "retrying"]),
    ).limit(1))
    if existing:
        return {"job_id": existing, "already_running": True}
    batch = JobBatch(name="Importação iCloud" if body.source == "icloud" else "Importação sintética")
    session.add(batch)
    await session.flush()
    job = await enqueue_job(
        session, job_type="icloud_discovery", asset_id=None,
        payload=body.model_dump(mode="json"), batch_id=batch.id,
        idempotency_key=f"ingestion:{uuid4()}",
    )
    audit(session, identity, "ingestion.start", limit=body.limit, source=body.source)
    await session.commit()
    return {"job_id": job.id, "batch_id": batch.id, "status": job.status}


async def set_ingestion_pause(
    session: AsyncSession, identity: Identity, paused: bool,
) -> dict[str, bool]:
    setting = await session.get(Setting, "ingestion_paused")
    if setting:
        setting.value = paused
    else:
        session.add(Setting(key="ingestion_paused", value=paused))
    audit(session, identity, "ingestion.pause" if paused else "ingestion.resume")
    await session.commit()
    return {"paused": paused}


@router.post("/ingestion/pause", tags=["ingestion"])
async def pause_ingestion(session: Session, identity: Actor) -> dict[str, bool]:
    return await set_ingestion_pause(session, identity, True)


@router.post("/ingestion/resume", tags=["ingestion"])
async def resume_ingestion(session: Session, identity: Actor) -> dict[str, bool]:
    return await set_ingestion_pause(session, identity, False)


@router.get("/settings", tags=["system"])
async def settings_get(session: Session) -> dict[str, Any]:
    settings = await effective_settings(session)
    allowed = set(SettingsPatch.model_fields) | {
        "icloud_enabled", "inference_backend", "app_env", "storage_backend",
        "joytag_model_id", "joytag_model_revision", "siglip_model_id",
        "siglip_model_revision", "siglip_embedding_dimension", "download_representation",
        "allow_original_fallback",
    }
    result = {key: value for key, value in settings.model_dump().items() if key in allowed}
    for key, default in (
        ("taxonomy_categories", {}), ("taxonomy_overrides", {}),
        ("taxonomy_compound_rules", []),
    ):
        row = await session.get(Setting, key)
        result[key] = row.value if row else default
    return result


@router.patch("/settings", tags=["system"])
async def settings_patch(
    body: SettingsPatch, session: Session, identity: Actor,
) -> dict[str, Any]:
    updates = body.model_dump(exclude_none=True)
    current = await effective_settings(session)
    from photointel.config import Settings
    try:
        Settings.model_validate({**current.model_dump(), **updates})
    except ValueError as exc:
        # Pydantic validation may contain SecretStr deployment values: expose no raw text.
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Configuração incompleta ou incompatível; consulte setup",
            422,
        ) from exc
    for key, value in updates.items():
        existing = await session.get(Setting, key)
        if existing:
            existing.value = value
        else:
            session.add(Setting(key=key, value=value))
    audit(session, identity, "settings.update", fields=list(updates))
    await session.commit()
    return await settings_get(session)


@router.get("/system/statistics", tags=["system"])
async def statistics(session: Session) -> dict[str, Any]:
    assets = (await session.execute(select(
        func.count(Asset.id),
        func.count(Asset.id).filter(Asset.classification_status == "completed"),
        func.count(Asset.id).filter(Asset.ingestion_status == "completed"),
    ))).one()
    job_counts = {status: count for status, count in (await session.execute(select(
        Job.status, func.count(Job.id)
    ).group_by(Job.status))).all()}
    timing = (await session.execute(select(
        func.avg(func.extract("epoch", Job.finished_at - Job.started_at)),
        func.count(Job.id),
    ).where(
        Job.status == "completed", Job.finished_at > datetime.now(UTC) - timedelta(hours=1),
    ))).one()
    last_sync = await session.scalar(select(func.max(IngestionRun.finished_at)).where(
        IngestionRun.status == "completed"
    ))
    avg_duration = float(timing[0]) if timing[0] else None
    pending = sum(job_counts.get(status, 0) for status in ["queued", "retrying", "preparing"])
    return {
        "total_assets": assets[0], "indexed_photos": assets[1],
        "processed_assets": assets[2], "job_counts": job_counts,
        "pending_processing": pending, "failed_jobs": job_counts.get("failed", 0),
        "last_icloud_sync": last_sync,
        "jobs_per_second_last_hour": timing[1] / 3600,
        "average_job_duration_seconds": avg_duration,
        "estimated_remaining_seconds": pending * avg_duration if avg_duration else None,
        "estimate_notice": "Estimativa baseada nos jobs concluídos; não é garantia.",
    }


@router.get("/system/storage", tags=["system"])
async def storage_statistics(session: Session) -> dict[str, Any]:
    groups = (await session.execute(select(
        AssetResource.resource_type, func.count(), func.sum(AssetResource.byte_size)
    ).where(AssetResource.status.in_(["available", "completed"])).group_by(
        AssetResource.resource_type
    ))).all()
    return {
        "total_bytes": sum(int(row[2] or 0) for row in groups),
        "variants": [{"variant": row[0], "count": row[1], "bytes": row[2] or 0}
                     for row in groups],
        "source": "catalog_resource_accounting",
        "notice": "Não inclui versões órfãs ou billing do provedor.",
    }


@router.get("/system/costs", tags=["system"])
async def cost_statistics(session: Session) -> dict[str, Any]:
    settings = await effective_settings(session)
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)
    totals = (await session.execute(select(
        func.sum(InferenceRun.runtime_ms).filter(InferenceRun.completed_at >= day_start),
        func.sum(InferenceRun.runtime_ms).filter(InferenceRun.completed_at >= month_start),
        func.sum(InferenceRun.runtime_ms),
    ).where(InferenceRun.status == "completed"))).one()
    costs = [
        float(milliseconds or 0) / 3600000 * settings.gpu_hourly_cost_estimate
        for milliseconds in totals
    ]
    bytes_transferred = await session.scalar(select(func.sum(IngestionRun.bytes_transferred)))
    return {
        "estimated_daily_cost": costs[0], "estimated_monthly_cost": costs[1],
        "estimated_total_cost": costs[2], "gpu_runtime_ms": float(totals[2] or 0),
        "bytes_transferred": bytes_transferred or 0, "currency": "USD",
        "daily_budget": settings.gpu_daily_budget, "monthly_budget": settings.gpu_monthly_budget,
        "notice": "Estimador da aplicação; não é um limite garantido de faturamento.",
    }


@router.get("/system/capabilities", tags=["system"])
async def capabilities(session: Session) -> dict[str, Any]:
    settings = await effective_settings(session)
    embedding_count = await session.scalar(select(func.count()).select_from(Embedding))
    device = await session.scalar(select(BridgeDevice).where(
        BridgeDevice.revoked_at.is_(None)
    ).order_by(BridgeDevice.last_seen_at.desc().nullslast()).limit(1))

    def capability(state: str, reason: str) -> dict[str, str]:
        return {"state": state, "reason": reason}

    gpu_state = "not_configured" if not settings.gpu_enabled else "unavailable"
    gpu_reason = "GPU desabilitada por padrão" if not settings.gpu_enabled else (
        "Adapter configurado; disponibilidade real confirmada por smoke test/jobs"
    )
    inference_ok = await session.scalar(select(InferenceRun.id).where(
        InferenceRun.status == "completed"
    ).limit(1))
    if settings.gpu_enabled and inference_ok:
        gpu_state = "operational"
        gpu_reason = "Inferência concluída registrada; falhas futuras são reportadas por job"
    connected = bool(
        device and device.last_seen_at
        and device.last_seen_at > datetime.now(UTC) - timedelta(hours=24)
    )
    result = {
        "icloud_ingestion": capability(
            "unavailable" if settings.icloud_enabled else "not_configured",
            "Verifique sessão e execute importação controlada no terminal",
        ),
        "apple_session_valid": capability("unavailable", "Requer verificação atual no Apple"),
        "gpu_inference": capability(gpu_state, gpu_reason),
        "joytag": capability(gpu_state, gpu_reason),
        "semantic_search": capability(
            "operational" if embedding_count and settings.gpu_enabled else "not_configured",
            "Requer embeddings e adapter de texto do mesmo checkpoint",
        ),
        "duplicate_detection": capability("operational", "SHA-256 e pHash; sem exclusão"),
        "quality_analysis": capability("operational", "Métricas técnicas heurísticas"),
        "apple_bridge_connected": capability(
            "operational" if connected else "not_configured", "Execução manual via Pyto",
        ),
        "apple_keywords_read": capability(
            "unavailable" if not device else "experimental",
            "Disponibilidade depende de PhotoKit e do runtime Pyto no dispositivo",
        ),
        "apple_keywords_write": capability(
            "experimental" if device and device.write_verified else "unavailable",
            "Sem bulk write; exige teste individual aprovado e capability verificada",
        ),
    }
    for name in ["video_ai", "face_recognition", "ocr", "advanced_visual_reasoning"]:
        result[name] = capability("not_implemented", "Fora do escopo v1")
    if settings.app_env == "test" and settings.inference_backend == "test":
        for name in ["gpu_inference", "joytag", "semantic_search"]:
            result[name] = capability(
                "test_only", "Resultados determinísticos exclusivamente neste ambiente de teste",
            )
    return result


@router.get("/system/status", tags=["system"])
async def system_status(session: Session) -> dict[str, Any]:
    workers = (await session.scalars(select(WorkerState).order_by(
        WorkerState.last_seen.desc()
    ).limit(100))).all()
    now = datetime.now(UTC)
    return {
        "api": "operational", "database": "operational",
        "environment": get_settings().app_env, "version": "1.0.0",
        "workers": [{**row_dict(worker),
                     "healthy": worker.last_seen > now - timedelta(minutes=2)}
                    for worker in workers],
        "ingestion": await ingestion_state(session),
        "capabilities": await capabilities(session),
    }


@router.get("/system/diagnostics", tags=["system"])
async def diagnostics(session: Session) -> dict[str, Any]:
    settings = get_settings()
    return {
        "generated_at": datetime.now(UTC), "version": "1.0.0",
        "environment": settings.app_env,
        "storage_backend": settings.storage_backend,
        "auth_mode": settings.auth_mode,
        "models": {
            "joytag": {"model": settings.joytag_model_id, "revision": settings.joytag_model_revision},
            "siglip": {"model": settings.siglip_model_id, "revision": settings.siglip_model_revision,
                       "dimension": settings.siglip_embedding_dimension},
        },
        "statistics": await statistics(session),
        "capabilities": await capabilities(session),
        "privacy": "Sem segredos, e-mails, queries, identificadores Apple ou fotos.",
    }


EXPORTS: dict[str, type[Any]] = {
    "manifest": Asset, "taxonomy": Tag, "tags": AssetTag,
    "inference": InferenceRun, "apple_sync": SyncOperation, "audit": AuditEvent,
}
EXPORT_EXCLUDE: dict[str, set[str]] = {
    "manifest": {"source_account", "source_metadata", "search_document"},
    "apple_sync": {"approved_by"}, "audit": {"actor", "correlation_id"},
}


async def iter_export(kind: str) -> Any:
    model = EXPORTS[kind]
    async with SessionLocal() as session:
        stream = await session.stream_scalars(select(model).execution_options(yield_per=500))
        async for row in stream:
            yield jsonable_encoder(row_dict(row, EXPORT_EXCLUDE.get(kind)))


@router.get("/system/export", tags=["system"])
async def export_metadata(
    identity: Actor, session: Session,
    kind: Literal["manifest", "taxonomy", "tags", "inference", "apple_sync", "audit"] = "manifest",
    format: Literal["json", "csv"] = "json",
) -> StreamingResponse:
    audit(session, identity, "metadata.export", kind=kind, format=format)
    await session.commit()

    async def stream_json() -> Any:
        yield '{"kind":' + json.dumps(kind) + ',"items":['
        first = True
        async for record in iter_export(kind):
            yield ("" if first else ",") + json.dumps(record, ensure_ascii=False)
            first = False
        yield "]}"

    async def stream_csv() -> Any:
        writer: Any = None
        buffer = io.StringIO()
        async for record in iter_export(kind):
            if writer is None:
                writer = csv.DictWriter(buffer, fieldnames=list(record))
                writer.writeheader()
            safe_record = {}
            for key, value in record.items():
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False)
                # Prevent CSV formula injection in spreadsheet applications.
                if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
                    value = "'" + value
                safe_record[key] = value
            writer.writerow(safe_record)
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    return StreamingResponse(
        stream_json() if format == "json" else stream_csv(),
        media_type="application/json" if format == "json" else "text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="photointel-{kind}.{format}"',
            "Cache-Control": "private, no-store",
        },
    )
