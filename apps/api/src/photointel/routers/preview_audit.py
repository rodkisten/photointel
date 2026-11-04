"""Read-only catalog audit of missing or failed image previews.

This checks persisted resource metadata across the entire catalog, not only recent
jobs. It deliberately does not read private objects or enqueue processing.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import require_identity
from photointel.database import get_session
from photointel.models import Asset, AssetResource, DiscoveryManifest, Job, Setting
from photointel.serializers import decode_uuid_cursor, encode_cursor
from photointel.services.runtime_settings import effective_settings
from photointel.services.preview_repair import manifest_recoverable, repair_stage

router = APIRouter(dependencies=[Depends(require_identity)])
Session = Annotated[AsyncSession, Depends(get_session)]

VARIANTS = ("thumbnail_small", "thumbnail_medium", "preview_large")
PREVIEW_JOB_TYPES = ("media_download", "metadata_extract", "thumbnail_generate")
ACTIVE_STATES = ("queued", "preparing", "running", "retrying")


def _audit_predicates():
    """Correlate variants with the asset's *current* representation revision."""
    valid = (
        select(func.count(AssetResource.id))
        .where(
            AssetResource.asset_id == Asset.id,
            AssetResource.revision == Asset.representation_revision,
            AssetResource.resource_type.in_(VARIANTS),
            AssetResource.status == "available",
            AssetResource.object_key.is_not(None),
            AssetResource.object_key != "",
            AssetResource.byte_size > 0,
        )
        .correlate(Asset)
        .scalar_subquery()
    )
    failed_job = (
        select(Job.id)
        .where(
            Job.asset_id == Asset.id,
            Job.job_type.in_(PREVIEW_JOB_TYPES),
            Job.status == "failed",
        )
        .correlate(Asset)
        .exists()
    )
    return (
        Asset.media_type != "video",
        Asset.visibility_status != "archived",
        valid < len(VARIANTS),
        or_(
            Asset.ingestion_status.in_(
                (
                    "completed", "failed", "quarantined", "pending",
                    "queued", "retrying", "downloading", "downloaded", "processing",
                )
            ),
            failed_job,
        ),
    )


@router.get("/jobs/previews/audit", tags=["jobs"])
async def audit_previews(
    session: Session,
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=4096),
) -> dict:
    """Find all catalogued images lacking valid preview metadata, without side effects.

    This does not claim to detect an R2 object missing behind an 'available' row.
    Results are UUID-keyset paginated and include totals for the entire catalog.
    """
    conditions = _audit_predicates()
    all_images = (
        Asset.media_type != "video",
        Asset.visibility_status != "archived",
    )
    total_assets = await session.scalar(
        select(func.count(Asset.id)).where(*all_images)
    ) or 0
    total_issues = await session.scalar(
        select(func.count(Asset.id)).where(*conditions)
    ) or 0
    query = select(Asset).where(*conditions)
    if cursor:
        query = query.where(Asset.id > decode_uuid_cursor(cursor))
    rows = list(
        (await session.scalars(query.order_by(Asset.id).limit(limit + 1))).all()
    )
    assets = rows[:limit]
    asset_ids: list[UUID] = [asset.id for asset in assets]
    resources_by_asset: dict[UUID, dict[str, AssetResource]] = {}
    latest_by_asset: dict[UUID, dict] = {}
    source_by_asset: set[UUID] = set()
    manifests_by_asset: dict[UUID, DiscoveryManifest] = {}
    if asset_ids:
        resources = (
            await session.execute(
                select(AssetResource, Asset)
                .join(Asset, AssetResource.asset_id == Asset.id)
                .where(
                    Asset.id.in_(asset_ids),
                    AssetResource.revision == Asset.representation_revision,
                    AssetResource.resource_type.in_(VARIANTS),
                )
            )
        ).all()
        for resource, asset in resources:
            resources_by_asset.setdefault(asset.id, {})[resource.resource_type] = resource

        persisted = (await session.scalars(
            select(AssetResource.asset_id)
            .join(Asset, AssetResource.asset_id == Asset.id)
            .where(
                Asset.id.in_(asset_ids),
                AssetResource.resource_type == "source_download",
                AssetResource.revision == Asset.content_revision,
                AssetResource.status == "available",
                AssetResource.object_key.is_not(None),
                AssetResource.object_key != "",
            )
        )).all()
        source_by_asset.update(persisted)
        manifests = (await session.scalars(
            select(DiscoveryManifest)
            .join(Asset, DiscoveryManifest.asset_id == Asset.id)
            .where(
                Asset.id.in_(asset_ids),
                DiscoveryManifest.content_revision == Asset.content_revision,
            )
        )).all()
        manifests_by_asset = {manifest.asset_id: manifest for manifest in manifests}

        ranked = (
            select(
                Job.asset_id.label("asset_id"),
                Job.id.label("id"),
                Job.job_type.label("job_type"),
                Job.status.label("status"),
                Job.error_code.label("error_code"),
                func.row_number()
                .over(
                    partition_by=Job.asset_id,
                    order_by=(Job.created_at.desc(), Job.id.desc()),
                )
                .label("position"),
            )
            .where(
                Job.asset_id.in_(asset_ids),
                Job.job_type.in_(PREVIEW_JOB_TYPES),
            )
            .subquery()
        )
        jobs = (
            await session.execute(
                select(
                    ranked.c.asset_id,
                    ranked.c.id,
                    ranked.c.job_type,
                    ranked.c.status,
                    ranked.c.error_code,
                ).where(ranked.c.position == 1)
            )
        ).all()
        for asset_id, job_id, job_type, status, error_code in jobs:
            latest_by_asset[asset_id] = {
                "id": str(job_id),
                "job_type": job_type,
                "status": status,
                "error_code": error_code,
            }

    settings = await effective_settings(session)
    pause = await session.get(Setting, "ingestion_paused")
    ingestion_paused = bool(pause and pause.value)
    findings = []
    for asset in assets:
        variants = resources_by_asset.get(asset.id, {})
        available = [
            name
            for name in VARIANTS
            if name in variants
            and variants[name].status == "available"
            and bool(variants[name].object_key)
            and (variants[name].byte_size or 0) > 0
        ]
        missing = [name for name in VARIANTS if name not in available]
        latest = latest_by_asset.get(asset.id)
        manifest = manifests_by_asset.get(asset.id)
        can_fetch = bool(manifest and manifest_recoverable(
            manifest.status, manifest.failure_category,
            manifest.attempts, manifest.maximum_attempts,
        ))
        stage = repair_stage(
            ingestion_status=asset.ingestion_status,
            retained=("preview_large" in available or asset.id in source_by_asset),
            source_retained=asset.id in source_by_asset,
            manifest=can_fetch,
            icloud_enabled=settings.icloud_enabled,
            ingestion_paused=ingestion_paused,
        )
        blocked = stage is None
        pending = bool(latest and latest["status"] in ACTIVE_STATES)
        repair_reason = (
            "AUTH_REQUIRED" if blocked and manifest and manifest.failure_category == "authentication_required"
            else "ICLOUD_PAUSED" if blocked and ingestion_paused
            else "SOURCE_NOT_FOUND" if blocked and not manifest and asset.id not in source_by_asset
            else "SOURCE_NOT_RECOVERABLE" if blocked
            else None
        )
        findings.append(
            {
                "asset_id": str(asset.id),
                "filename": asset.filename,
                "ingestion_status": asset.ingestion_status,
                "missing_variants": missing,
                "available_variants": available,
                "invalid_variants": [
                    name for name in missing if name in variants
                ],
                "status": (
                    "blocked" if blocked else
                    "processing" if pending else
                    "failed" if latest and latest["status"] == "failed" else
                    "missing"
                ),
                "repairable": not blocked and not pending,
                "repair_stage": stage,
                "repair_reason": repair_reason,
                "job": latest,
            }
        )
    return {
        "total_assets": total_assets,
        "total_issues": total_issues,
        "items": findings,
        "next_cursor": (
            encode_cursor({"id": assets[-1].id}) if len(rows) > limit and assets else None
        ),
        "verification": "catalog_metadata",
    }


@router.get("/jobs/previews/automation", tags=["jobs"])
async def preview_automation_status(session: Session) -> dict:
    """Public-to-authorized-operator status only; no private object keys."""
    from photointel.services.preview_repair import automatic_preview_status

    return await automatic_preview_status(session)
