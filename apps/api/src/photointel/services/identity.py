"""Identity reconciliation never conflates visual similarity with asset identity."""

from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.models import Asset, DeviceMapping


def revision_hash(value: dict[str, Any]) -> str:
    import json
    return sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


@dataclass(frozen=True)
class MappingDecision:
    status: str
    candidates: tuple[UUID, ...]
    confidence: float
    reason: str


async def reconcile_asset(
    session: AsyncSession, *, device_id: UUID, local_identifier: str,
    content_hash: str | None = None, filename: str | None = None,
    captured_at: datetime | None = None, width: int | None = None,
    height: int | None = None,
) -> MappingDecision:
    """Only a previously verified mapping is automatically write eligible.

    Even identical downloaded bytes can belong to distinct photographs. Content
    equality supplies review candidates, never authorization for PhotoKit writes.
    """
    mappings = (await session.scalars(select(DeviceMapping).where(
        DeviceMapping.device_id == device_id,
        DeviceMapping.local_identifier == local_identifier,
        DeviceMapping.verification_status == "verified",
    ).limit(3))).all()
    if len(mappings) == 1:
        return MappingDecision(
            "verified", (mappings[0].asset_id,), 1, "confirmed_mapping",
        )
    if len(mappings) > 1:
        return MappingDecision("ambiguous", tuple(m.asset_id for m in mappings), 0,
                               "conflicting_mappings")
    query = select(Asset.id)
    if content_hash:
        query = query.where(Asset.sha256 == content_hash)
        reason = "exact_content_requires_confirmation"
        confidence = 0.95
    elif all(v is not None for v in (filename, captured_at, width, height)):
        query = query.where(
            Asset.filename == filename, Asset.captured_at == captured_at,
            Asset.width == width, Asset.height == height,
        )
        reason = "composite_metadata_requires_confirmation"
        confidence = 0.6
    else:
        return MappingDecision("unmapped", (), 0, "insufficient_evidence")
    ids = tuple((await session.scalars(query.order_by(Asset.id).limit(51))).all())
    return MappingDecision(
        "candidate" if len(ids) == 1 else "ambiguous" if ids else "unmapped",
        ids, confidence if len(ids) == 1 else 0, reason,
    )
