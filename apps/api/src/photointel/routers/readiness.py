"""Authenticated setup, release evidence and non-destructive ingestion recovery."""

import asyncio
from datetime import timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_identity
from photointel.database import get_session
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset,
    DiscoveryManifest,
    DispatchOutbox,
    IngestionRun,
    Job,
    JobEvent,
    Library,
    SessionState,
    VerificationGate,
    utcnow,
)
from photointel.schemas import IngestionInput
from photointel.schemas_operations import (
    IngestionFailures,
    ReleaseInfo,
    SetupStatus,
    VerificationGates,
)
from photointel.serializers import decode_uuid_cursor, encode_cursor
from photointel.services.catalog import audit
from photointel.services.import_policy import authorize_import
from photointel.services.release import get_release_manifest
from photointel.services.runtime_settings import effective_settings
from photointel.services.session_store import session_scope
from photointel.services.verification import gate_status, require_import_gates
from photointel.storage import LocalStorage, S3Storage, get_storage

router = APIRouter(dependencies=[Depends(require_identity)])
Session = Annotated[AsyncSession, Depends(get_session)]
Actor = Annotated[Identity, Depends(require_identity)]


class GateInput(BaseModel):
    gate_id: Literal["F"]
    status: Literal["passed", "failed", "not_verified"]
    evidence: list[str] = Field(default_factory=list, max_length=20)
    notes: str | None = Field(default=None, max_length=2000)
    release_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    operator_attestation: Literal[True]


class RecoveryInput(BaseModel):
    reason: str = Field(
        default="Revisão manual do operador", min_length=1, max_length=500
    )


@router.get("/release", response_model=ReleaseInfo, tags=["system"])
async def release() -> dict[str, Any]:
    return get_release_manifest()


@router.get("/verification/gates", response_model=VerificationGates, tags=["system"])
async def gates(session: Session) -> dict[str, Any]:
    return await gate_status(session)


@router.patch("/verification/gates", response_model=VerificationGates, tags=["system"])
async def attest_gate(
    body: GateInput, session: Session, identity: Actor
) -> dict[str, Any]:
    release = get_release_manifest()
    if (
        release["provenance_status"] != "identified"
        or body.release_sha != release["git_sha"]
    ):
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Evidência deve identificar este release", 409
        )
    if any(len(value) > 500 or not value.strip() for value in body.evidence):
        raise AppError(ErrorCode.INVALID_REQUEST, "Referência de evidência inválida", 422)
    if body.status == "passed":
        if not body.evidence:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Informe referências dos testes reais", 422
            )
    row = await session.get(VerificationGate, body.gate_id, with_for_update=True)
    if row is None:
        row = VerificationGate(id=body.gate_id)
        session.add(row)
    row.status = body.status
    row.release_sha = body.release_sha
    row.evidence = body.evidence
    row.notes = body.notes
    row.verified_by = identity.subject
    row.verified_at = utcnow() if body.status != "not_verified" else None
    row.updated_at = utcnow()
    audit(session, identity, "verification.attest", gate=body.gate_id, status=body.status)
    await session.commit()
    return await gate_status(session)


@router.get("/setup/status", response_model=SetupStatus, tags=["system"])
async def setup_status(session: Session) -> dict[str, Any]:
    settings = await effective_settings(session)
    checks: list[dict[str, str]] = []

    def check(
        key: str, label: str, state: str, reason: str, href: str = "/setup"
    ) -> None:
        checks.append(
            {
                "id": key,
                "label": label,
                "state": state,
                "reason": reason,
                "href": href,
                "action": "Verificar configuração",
            }
        )

    await session.execute(text("SELECT 1"))
    check("database", "PostgreSQL", "operational", "Conexão verificada nesta requisição")
    last_run = await session.scalar(
        select(IngestionRun)
        .join(Library, IngestionRun.library_id == Library.id)
        .where(IngestionRun.status == "completed", Library.source_type == "icloud")
        .order_by(IngestionRun.started_at.desc())
        .limit(1)
    )
    session_state = (
        await session.get(SessionState, session_scope(settings))
        if settings.icloud_account and settings.icloud_library
        else None
    )
    # Release connections before storage I/O; configuration is not access proof.
    await session.commit()
    try:
        storage = get_storage()
        if isinstance(storage, S3Storage):
            await asyncio.wait_for(
                asyncio.to_thread(storage.client.head_bucket, Bucket=storage.bucket), 8
            )
        elif isinstance(storage, LocalStorage) and not storage.directory.is_dir():
            raise OSError("Missing local storage")
        check("storage", "Armazenamento privado", "operational", "Backend acessível")
    except Exception:
        check(
            "storage",
            "Armazenamento privado",
            "unavailable",
            "Verifique bucket privado, endpoint e credenciais no servidor",
        )
    if not settings.icloud_enabled:
        check("icloud", "iCloud", "not_configured", "Ingestão desativada", "/icloud")
    else:
        proven = bool(
            last_run
            and last_run.finished_at
            and last_run.finished_at > utcnow() - timedelta(hours=24)
        )
        configured = (
            bool(
                session_state
                and session_state.object_key
                and not session_state.revoked_at
            )
            if settings.icloud_session_backend == "encrypted_object"
            else (
                settings.icloud_session_directory / "photointel-auth-state.json"
            ).exists()
        )
        check(
            "icloud",
            "iCloud",
            "operational" if proven else "unverified",
            "Importação concluída recentemente; a sessão ainda pode expirar"
            if proven
            else "Sessão presente, acesso Apple ainda não confirmado"
            if configured
            else "Autentique por terminal e publique a sessão protegida",
            "/icloud",
        )
    check(
        "gpu",
        "Modal / IA",
        "unverified" if settings.gpu_enabled else "not_configured",
        "GPU habilitada; confirme o resultado nos jobs de inferência e nos logs."
        if settings.gpu_enabled
        else "GPU desativada; nenhum gasto de inferência autorizado",
        "/settings",
    )
    check(
        "authentication",
        "Autenticação",
        "operational" if settings.app_env == "production" else "local",
        "JWT validado nesta requisição"
        if settings.app_env == "production"
        else "Modo local; não comprova Cloudflare Access em produção",
    )
    pending = next(
        (item for item in checks if item["state"] not in {"operational", "local"}), None
    )
    return {
        "checks": checks,
        "next_action": {
            "label": pending["action"],
            "href": pending["href"],
            "description": pending["reason"],
        }
        if pending
        else None,
        "spending": {
            "enabled": settings.gpu_enabled,
            "gpu_enabled": settings.gpu_enabled,
        },
        "checked_at": utcnow(),
    }


@router.post("/ingestion/preview", tags=["ingestion"])
async def import_preview(body: IngestionInput, session: Session) -> dict[str, Any]:
    settings = await effective_settings(session)
    authorization = authorize_import(settings, body.limit, body.confirm_expansion)
    gate_error = None
    if body.source == "icloud" and settings.verification_gates_enforced:
        try:
            await require_import_gates(session, max(body.limit, body.target_assets or 0))
        except AppError as exc:
            gate_error = exc.message
    return {
        "authorization": authorization,
        "gate_error": gate_error,
        "can_start": gate_error is None
        and (body.source == "fixture" or settings.icloud_enabled),
        "gpu_enabled": settings.gpu_enabled,
        "catalog_profile": settings.database_profile,
        "catalog_asset_limit": settings.catalog_asset_limit,
        "notice": "Prévia sem downloads ou cobrança; não constitui limite do provedor",
    }


@router.get("/ingestion/failures", response_model=IngestionFailures, tags=["ingestion"])
async def ingestion_failures(
    session: Session,
    status: Literal["failed", "retrying", "quarantined"] | None = None,
    cursor: str | None = None,
    limit: int = Query(30, ge=1, le=100),
) -> dict[str, Any]:
    query = (
        select(DiscoveryManifest, Asset.filename)
        .join(Asset)
        .where(
            DiscoveryManifest.status == status
            if status
            else DiscoveryManifest.status.in_(["failed", "retrying", "quarantined"])
        )
    )
    if cursor:
        query = query.where(DiscoveryManifest.id < decode_uuid_cursor(cursor))
    rows = (
        await session.execute(
            query.order_by(DiscoveryManifest.id.desc()).limit(limit + 1)
        )
    ).all()
    return {
        "items": [
            {
                "asset_id": manifest.asset_id,
                "filename": filename,
                "status": manifest.status,
                "failure_category": manifest.failure_category,
                "error_code": manifest.last_error,
                "error_details": None,
                "attempts": manifest.attempts,
                "maximum_attempts": manifest.maximum_attempts,
                "updated_at": manifest.updated_at,
            }
            for manifest, filename in rows[:limit]
        ],
        "next_cursor": encode_cursor({"id": rows[limit - 1][0].id})
        if len(rows) > limit
        else None,
    }


async def recover_asset(
    asset_id: UUID,
    body: RecoveryInput,
    session: AsyncSession,
    identity: Identity,
    quarantine: bool,
) -> dict[str, Any]:
    asset = await session.get(Asset, asset_id)
    if asset is None:
        raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
    manifest = await session.scalar(
        select(DiscoveryManifest)
        .where(
            DiscoveryManifest.asset_id == asset_id,
            DiscoveryManifest.content_revision == asset.content_revision,
        )
        .with_for_update()
    )
    if manifest is None or manifest.status == "completed":
        raise AppError(ErrorCode.INVALID_REQUEST, "Revisão sem falha recuperável", 409)
    jobs = (
        await session.scalars(
            select(Job)
            .where(
                Job.asset_id == asset_id,
                Job.status.in_(
                    [
                        "failed",
                        "retrying",
                        "queued",
                        "paused",
                        "running",
                        "preparing",
                        "cancelled",
                    ]
                ),
            )
            .with_for_update()
        )
    ).all()
    if quarantine:
        manifest.status = "quarantined"
        asset.ingestion_status = "quarantined"
        for job in jobs:
            job.status = "cancelled"
            job.fence_token += 1
            job.error_code = "QUARANTINED"
            job.worker_id = None
            job.lease_until = None
            job.finished_at = utcnow()
    else:
        if manifest.status not in {"failed", "retrying", "quarantined"}:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Foto ainda está em processamento", 409
            )
        manifest.status = "queued"
        manifest.attempts = 0
        asset.ingestion_status = "queued"
        for job in jobs:
            if job.status in {"running", "preparing"}:
                raise AppError(
                    ErrorCode.INVALID_REQUEST, "Worker ainda possui esta foto", 409
                )
            job.status = "queued"
            job.fence_token += 1
            job.attempts = 0
            job.error_code = None
            job.error_details = None
            job.scheduled_at = utcnow()
            job.finished_at = None
            job.worker_id = None
            job.lease_until = None
        if not jobs:
            from photointel.services.jobs import enqueue_job

            await enqueue_job(
                session,
                job_type="media_download",
                asset_id=asset_id,
                payload={},
                idempotency_key=(
                    f"download:{asset_id}:{asset.content_revision}:manual:{utcnow().isoformat()}"
                ),
            )
        settings = await effective_settings(session)
        if settings.execution_platform == "cloud_run":
            session.add(
                DispatchOutbox(
                    job_name="worker",
                    idempotency_key=(f"retry:{asset_id}:{utcnow().isoformat()}"),
                )
            )
    for job in jobs:
        session.add(
            JobEvent(
                job_id=job.id,
                status=job.status,
                payload={
                    "job_id": str(job.id),
                    "status": job.status,
                },
            )
        )
    audit(
        session,
        identity,
        "ingestion.quarantine" if quarantine else "ingestion.retry",
        asset_id=asset_id,
        reason=body.reason,
    )
    await session.commit()
    return {"asset_id": asset_id, "status": manifest.status}


@router.post("/ingestion/assets/{asset_id}/retry", tags=["ingestion"])
async def retry_asset(
    asset_id: UUID, body: RecoveryInput, session: Session, identity: Actor
) -> dict[str, Any]:
    return await recover_asset(asset_id, body, session, identity, False)


@router.post("/ingestion/assets/{asset_id}/quarantine", tags=["ingestion"])
async def quarantine_asset(
    asset_id: UUID, body: RecoveryInput, session: Session, identity: Actor
) -> dict[str, Any]:
    return await recover_asset(asset_id, body, session, identity, True)
