"""Bounded, resumable and cost-aware preview repair for finite Cloud Run workers.

The catalog audit finds missing metadata; a separate rotating R2 HEAD audit finds
objects that disappeared despite 'available' DB rows. Neither loop touches Apple
originals, and only an existing authorized discovery manifest permits downloads.
"""

import asyncio
from datetime import datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.models import Asset, AssetResource, DiscoveryManifest, Job, Setting, utcnow
from photointel.services.jobs import enqueue_job
from photointel.services.runtime_settings import effective_settings
from photointel.storage import get_storage

logger = structlog.get_logger()
STATE_KEY = "automatic_preview_repair"
VARIANTS = ("thumbnail_small", "thumbnail_medium", "preview_large")
ACTIVE = ("queued", "preparing", "running", "retrying", "paused")
PIPELINE = ("media_download", "metadata_extract", "thumbnail_generate")

RECOVERABLE_MANIFEST_FAILURES = frozenset({
    "remote_asset_unavailable", "transient_network_error", "storage_error",
    "rate_limited",
})


def manifest_recoverable(
    status: str, category: str | None, attempts: int, maximum: int
) -> bool:
    """Resurrect exhausted remote sources only for transient failures."""
    if status in {"quarantined", "failed"} or attempts >= maximum:
        return category in RECOVERABLE_MANIFEST_FAILURES
    # A completed manifest can restore a lost private source from iCloud.
    return True


async def rearm_manifest(session: AsyncSession, manifest: DiscoveryManifest) -> bool:
    """Preserve encrypted source identity while resetting recoverable retry budgets."""
    if not manifest_recoverable(
        manifest.status, manifest.failure_category,
        manifest.attempts, manifest.maximum_attempts,
    ):
        return False
    if manifest.status in {"quarantined", "failed", "completed"} or manifest.attempts >= manifest.maximum_attempts:
        manifest.status = "retrying"
        manifest.attempts = 0
        manifest.last_error = None
        manifest.failure_category = None
    return True



def repair_stage(
    *,
    ingestion_status: str,
    retained: bool,
    manifest: bool,
    icloud_enabled: bool,
    ingestion_paused: bool,
    source_retained: bool = False,
) -> str | None:
    """Resume a historical failed source without changing the original."""
    if ingestion_status == "completed" and retained:
        return "thumbnail_generate"
    if source_retained and ingestion_status in {
        "downloaded", "processing", "queued", "retrying",
        "failed", "quarantined", "pending",
    }:
        return "metadata_extract"
    if manifest and icloud_enabled and not ingestion_paused:
        return "media_download"
    return None


def _cursor(value: object) -> UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


def _due(value: object, now: datetime) -> bool:
    if not isinstance(value, str):
        return True
    try:
        return datetime.fromisoformat(value) <= now
    except ValueError:
        return True


async def automatic_preview_status(session: AsyncSession) -> dict:
    settings = await effective_settings(session)
    stored = await session.get(Setting, STATE_KEY)
    data = stored.value if stored and isinstance(stored.value, dict) else {}
    return {
        "enabled": settings.auto_preview_repair_enabled,
        "interval_minutes": settings.auto_preview_repair_interval_minutes,
        "catalog_batch_size": settings.auto_preview_repair_batch_size,
        "storage_batch_size": settings.auto_preview_verify_batch_size,
        "weekly_attempt_limit": settings.auto_preview_repair_max_attempts_week,
        "last_started_at": data.get("last_started_at"),
        "last_finished_at": data.get("last_finished_at"),
        "next_run_at": data.get("next_run_at"),
        "last_result": data.get("last_result"),
    }


async def _queue_repair(
    session: AsyncSession,
    asset_id: UUID,
    settings: Settings,
    now: datetime,
    *,
    ingestion_paused: bool,
) -> str:
    """Serialize with the manual repair endpoint on the asset row."""
    asset = await session.scalar(
        select(Asset).where(Asset.id == asset_id).with_for_update(skip_locked=True)
    )
    if asset is None:
        return "busy"
    if asset.media_type != "image" or asset.visibility_status == "archived":
        return "blocked"
    busy = await session.scalar(
        select(Job.id).where(
            Job.asset_id == asset_id,
            Job.job_type.in_(PIPELINE),
            Job.status.in_(ACTIVE),
        ).limit(1)
    )
    if busy is not None:
        return "busy"
    latest = await session.scalar(
        select(Job).where(
            Job.asset_id == asset_id,
            Job.job_type.in_(PIPELINE),
        ).order_by(Job.created_at.desc(), Job.id.desc()).limit(1)
    )
    # A cancelled task is an explicit operator stop, not an invitation for
    # the next automatic sweep to resurrect that same content revision.
    if (
        latest is not None
        and latest.status == "cancelled"
        and (latest.payload or {}).get("content_revision") in (
            None, asset.content_revision
        )
    ):
        return "blocked"
    recent = await session.scalar(
        select(func.count(Job.id)).where(
            Job.asset_id == asset_id,
            Job.idempotency_key.like(
                f"auto-preview-repair:{asset_id}:{asset.content_revision}:%"
            ),
            Job.created_at >= now - timedelta(days=7),
        )
    ) or 0
    if recent >= settings.auto_preview_repair_max_attempts_week:
        return "cooldown"

    retained_resources = set((await session.scalars(
        select(AssetResource.resource_type).where(
            AssetResource.asset_id == asset_id,
            AssetResource.status == "available",
            AssetResource.object_key.is_not(None),
            AssetResource.object_key != "",
            (
                (
                    (AssetResource.resource_type == "source_download")
                    & (AssetResource.revision == asset.content_revision)
                )
                | (
                    (AssetResource.resource_type == "preview_large")
                    & (AssetResource.revision == asset.representation_revision)
                )
            ),
        )
    )).all())
    source_retained = "source_download" in retained_resources
    manifest = None
    if settings.icloud_enabled and not ingestion_paused:
        manifest = await session.scalar(
            select(DiscoveryManifest).where(
                DiscoveryManifest.asset_id == asset_id,
                DiscoveryManifest.content_revision == asset.content_revision,
            ).with_for_update()
        )
    has_manifest = bool(
        manifest
        and manifest_recoverable(
            manifest.status, manifest.failure_category,
            manifest.attempts, manifest.maximum_attempts,
        )
    )
    kind = repair_stage(
        ingestion_status=asset.ingestion_status,
        retained=bool(retained_resources),
        source_retained=source_retained,
        manifest=has_manifest,
        icloud_enabled=settings.icloud_enabled,
        ingestion_paused=ingestion_paused,
    )
    if kind is None:
        return "blocked"
    if kind == "media_download" and manifest and not await rearm_manifest(session, manifest):
        return "blocked"
    # At most one automatic attempt per six-hour slot, and a bounded weekly
    # budget. enqueue_job's UNIQUE key also protects concurrent schedulers.
    slot = int(now.timestamp()) // (6 * 3600)
    payload = {
        "automatic_preview_repair": True,
        "force": True,
        "content_revision": asset.content_revision,
    }
    if kind == "thumbnail_generate":
        payload["representation_revision"] = asset.representation_revision
    await enqueue_job(
        session,
        job_type=kind,
        asset_id=asset_id,
        payload=payload,
        idempotency_key=(
            f"auto-preview-repair:{asset_id}:{asset.content_revision}:{slot}"
        ),
        priority=3,
    )
    return "queued"


async def _catalog_pass(
    settings: Settings, cursor: UUID | None, now: datetime, paused: bool
) -> tuple[UUID | None, dict[str, int]]:
    from photointel.routers.preview_audit import _audit_predicates

    limit = settings.auto_preview_repair_batch_size
    async with SessionLocal() as session:
        query = select(Asset.id).where(*_audit_predicates())
        if cursor:
            query = query.where(Asset.id > cursor)
        rows = list((await session.scalars(
            query.order_by(Asset.id).limit(limit + 1)
        )).all())
        await session.commit()
    counts = {"scanned": 0, "queued": 0, "busy": 0, "blocked": 0, "cooldown": 0}
    for asset_id in rows[:limit]:
        counts["scanned"] += 1
        try:
            async with SessionLocal() as session:
                outcome = await _queue_repair(
                    session, asset_id, settings, now, ingestion_paused=paused
                )
                await session.commit()
            counts[outcome] += 1
        except Exception:
            counts["blocked"] += 1
            logger.exception("automatic_preview_catalog_item_failed", asset_id=str(asset_id))
    next_cursor = rows[limit - 1] if len(rows) > limit else None
    return next_cursor, counts


async def _storage_pass(
    settings: Settings, cursor: UUID | None, now: datetime, paused: bool
) -> tuple[UUID | None, dict[str, int]]:
    """Rotate through the completed catalog without unbounded R2 requests."""
    limit = settings.auto_preview_verify_batch_size
    async with SessionLocal() as session:
        query = select(Asset.id).where(
            Asset.media_type == "image",
            Asset.ingestion_status == "completed",
            Asset.visibility_status != "archived",
        )
        if cursor:
            query = query.where(Asset.id > cursor)
        rows = list((await session.scalars(
            query.order_by(Asset.id).limit(limit + 1)
        )).all())
        await session.commit()
    counts = {"checked": 0, "missing_objects": 0, "queued": 0, "errors": 0}
    storage = get_storage()
    for asset_id in rows[:limit]:
        try:
            async with SessionLocal() as session:
                asset = await session.get(Asset, asset_id)
                if asset is None:
                    continue
                revision = asset.representation_revision
                resources = list((await session.scalars(select(AssetResource).where(
                    AssetResource.asset_id == asset_id,
                    AssetResource.revision == revision,
                    AssetResource.resource_type.in_(VARIANTS),
                    AssetResource.status == "available",
                    AssetResource.object_key.is_not(None),
                    AssetResource.byte_size > 0,
                ))).all())
                busy = await session.scalar(select(Job.id).where(
                    Job.asset_id == asset_id,
                    Job.job_type.in_(PIPELINE),
                    Job.status.in_(ACTIVE),
                ).limit(1))
                if busy is not None or len(resources) != len(VARIANTS):
                    continue
                snapshots = [(resource.id, resource.object_key) for resource in resources]
                await session.commit()
            absent = []
            for resource_id, key in snapshots:
                if key and not await asyncio.to_thread(storage.exists, key):
                    absent.append((resource_id, key))
            counts["checked"] += 1
            if not absent:
                continue
            async with SessionLocal() as session:
                asset = await session.scalar(
                    select(Asset).where(Asset.id == asset_id).with_for_update(skip_locked=True)
                )
                if asset is None or asset.representation_revision != revision:
                    continue
                busy = await session.scalar(select(Job.id).where(
                    Job.asset_id == asset_id,
                    Job.job_type.in_(PIPELINE),
                    Job.status.in_(ACTIVE),
                ).limit(1))
                if busy is not None:
                    continue
                changed = 0
                for resource_id, key in absent:
                    resource = await session.get(
                        AssetResource, resource_id, with_for_update=True
                    )
                    if resource and resource.status == "available" and resource.object_key == key:
                        resource.status = "invalid"
                        changed += 1
                await session.commit()
            if changed:
                counts["missing_objects"] += changed
                async with SessionLocal() as session:
                    outcome = await _queue_repair(
                        session, asset_id, settings, now, ingestion_paused=paused
                    )
                    await session.commit()
                if outcome == "queued":
                    counts["queued"] += 1
        except Exception:
            # Provider failures must NOT mark an object absent or stop ordinary jobs.
            counts["errors"] += 1
            logger.exception("automatic_preview_storage_probe_failed", asset_id=str(asset_id))
    next_cursor = rows[limit - 1] if len(rows) > limit else None
    return next_cursor, counts


async def run_automatic_preview_repair() -> dict:
    """At most one bounded sweep per interval, across all finite runners.

    A PostgreSQL transaction advisory lock prevents duplicate scheduling.
    The due marker is persisted *before* network I/O, so crashes never cause
    an unbounded loop of immediate restart attempts.
    """
    now = utcnow()
    async with SessionLocal() as session:
        settings = await effective_settings(session)
        if not settings.auto_preview_repair_enabled:
            return {"status": "disabled"}
        paused_jobs = await session.get(Setting, "jobs_paused")
        if paused_jobs and paused_jobs.value:
            return {"status": "queue_paused"}
        lock = await session.scalar(
            text("SELECT pg_try_advisory_xact_lock(917314, 62)")
        )
        if not lock:
            return {"status": "already_running"}
        row = await session.get(Setting, STATE_KEY, with_for_update=True)
        previous = dict(row.value) if row and isinstance(row.value, dict) else {}
        if not _due(previous.get("next_run_at"), now):
            return {"status": "not_due", "next_run_at": previous["next_run_at"]}
        next_run = now + timedelta(minutes=settings.auto_preview_repair_interval_minutes)
        state = {
            **previous,
            "last_started_at": now.isoformat(),
            "next_run_at": next_run.isoformat(),
        }
        if row:
            row.value = state
        else:
            session.add(Setting(key=STATE_KEY, value=state))
        await session.commit()
        ingestion_pause = await session.get(Setting, "ingestion_paused")
        paused = bool(ingestion_pause and ingestion_pause.value)
    cursor_catalog, catalog = await _catalog_pass(
        settings, _cursor(previous.get("catalog_cursor")), now, paused
    )
    cursor_storage, storage = await _storage_pass(
        settings, _cursor(previous.get("storage_cursor")), now, paused
    )
    finished = utcnow()
    result = {"status": "completed", "catalog": catalog, "storage": storage}
    async with SessionLocal() as session:
        row = await session.get(Setting, STATE_KEY, with_for_update=True)
        if row:
            row.value = {
                **(row.value if isinstance(row.value, dict) else {}),
                "catalog_cursor": str(cursor_catalog) if cursor_catalog else None,
                "storage_cursor": str(cursor_storage) if cursor_storage else None,
                "last_finished_at": finished.isoformat(),
                "last_result": result,
            }
            await session.commit()
    return result
