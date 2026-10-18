"""Authenticated Apple Sync control plane and independently enrolled devices."""

import json
import secrets
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Query
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_bridge_access, require_identity
from photointel.config import get_settings
from photointel.database import get_session
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset,
    AuditEvent,
    BridgeDevice,
    DeviceMapping,
    MetadataSnapshot,
    Setting,
    SyncOperation,
    utcnow,
)
from photointel.serializers import decode_cursor, encode_cursor, row_dict
from photointel.services.apple_sync import (
    assert_verified_mapping,
    credential_digest,
    keyword_delta,
    keywords,
    metadata_revision,
    three_way_merge,
    validate_write_receipt,
)

router = APIRouter(tags=["apple-sync"])
DB = Annotated[AsyncSession, Depends(get_session)]
User = Annotated[Identity, Depends(require_identity)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


CapabilityLevel = Literal[
    "unavailable",
    "read_only",
    "write_supported_unverified",
    "write_verified",
    "temporarily_unavailable",
]


class Capabilities(Input):
    level: CapabilityLevel = "read_only"
    photokit_read: bool = False
    keywords_read: bool = False
    keywords_write: bool = False
    authorization: Literal[
        "authorized", "limited", "denied", "not_determined", "unavailable"
    ]
    platform: str = Field(max_length=128)
    adapter: str = Field(default="pyto-readonly-v1", max_length=128)
    reason: str | None = Field(default=None, max_length=1024)


class Enrollment(Input):
    code: str = Field(min_length=32, max_length=256)
    name: str = Field(min_length=1, max_length=255)
    capabilities: Capabilities


class InventoryItem(Input):
    local_identifier: str = Field(min_length=1, max_length=512)
    cloud_identifier: str | None = Field(default=None, max_length=512)
    filename: str | None = Field(default=None, max_length=1024)
    captured_at: AwareDatetime | None = None
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    media_type: Literal["image", "video", "other"] = "image"
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    keywords: list[str] | None = Field(default=None, max_length=200)


class Manifest(Input):
    items: list[InventoryItem] = Field(max_length=100)
    checkpoint: str | None = Field(default=None, max_length=1024)
    complete: bool = False


class MappingConfirmation(Input):
    asset_id: UUID
    snapshot_id: UUID
    confirm: Literal[True]


class SyncProposal(Input):
    asset_id: UUID
    target_device_id: UUID
    add: list[str] = Field(default_factory=list, max_length=200)
    remove: list[str] = Field(default_factory=list, max_length=200)
    approve_removals: bool = False
    single_asset_test: bool = False
    source: Literal["user", "approved_ai"] = "user"


class CreateOperation(SyncProposal):
    idempotency_key: str = Field(min_length=8, max_length=128)
    approve: bool = False


class Acknowledgement(Input):
    status: Literal["applied_on_device", "unsupported", "conflict", "failed"]
    lease_token: str = Field(min_length=32, max_length=128)
    before_keywords: list[str] = Field(default_factory=list, max_length=200)
    after_keywords: list[str] = Field(default_factory=list, max_length=200)
    error_code: str | None = Field(default=None, max_length=64)


def digest(value: str) -> str:
    pepper = get_settings().bridge_token_pepper
    return credential_digest(value, pepper.get_secret_value() if pepper else "")


def audit(
    session: AsyncSession,
    actor: str,
    action: str,
    asset_id: UUID | None = None,
    **details: Any,
) -> None:
    session.add(
        AuditEvent(actor=actor, action=action, asset_id=asset_id, details=details)
    )


def device_out(device: BridgeDevice) -> dict[str, Any]:
    return row_dict(device, {"credential_hash"})


def operation_out(operation: SyncOperation) -> dict[str, Any]:
    result = row_dict(operation)
    result["payload"] = {
        key: value
        for key, value in operation.payload.items()
        if key != "lease_token_hash"
    }
    return result


async def require_device(
    session: DB,
    _: Annotated[None, Depends(require_bridge_access)],
    authorization: Annotated[str | None, Header()] = None,
) -> BridgeDevice:
    if not authorization or not authorization.startswith("Bearer bridge_"):
        raise AppError(
            ErrorCode.DEVICE_NOT_ENROLLED, "Credencial do Bridge necessária", 401
        )
    token = authorization[7:]
    if len(token) > 256:
        raise AppError(ErrorCode.DEVICE_NOT_ENROLLED, "Credencial inválida", 401)
    device = await session.scalar(
        select(BridgeDevice).where(
            BridgeDevice.credential_hash == digest(token),
            BridgeDevice.revoked_at.is_(None),
        )
    )
    if device is None:
        raise AppError(ErrorCode.DEVICE_NOT_ENROLLED, "Dispositivo não autorizado", 401)
    device.last_seen_at = utcnow()
    return device


Device = Annotated[BridgeDevice, Depends(require_device)]


@router.post("/apple-sync/enrollment")
async def issue_enrollment(session: DB, identity: User) -> dict[str, Any]:
    await session.execute(
        delete(Setting).where(
            Setting.key.like("bridge-enroll:%"),
            Setting.value["expires_at"].as_string() < utcnow().isoformat(),
        )
    )
    code = secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(minutes=10)
    session.add(
        Setting(
            key=f"bridge-enroll:{digest(code)}",
            value={
                "expires_at": expires.isoformat(),
                "actor": identity.subject,
            },
        )
    )
    audit(session, identity.subject, "bridge.enrollment_issued")
    await session.commit()
    return {"code": code, "expires_at": expires, "single_use": True}


@router.post(
    "/bridge/enroll", status_code=201, dependencies=[Depends(require_bridge_access)]
)
async def enroll(body: Enrollment, session: DB) -> dict[str, Any]:
    enrollment = await session.scalar(
        select(Setting)
        .where(
            Setting.key == f"bridge-enroll:{digest(body.code)}",
        )
        .with_for_update()
    )
    if (
        enrollment is None
        or datetime.fromisoformat(enrollment.value["expires_at"]) <= utcnow()
    ):
        raise AppError(
            ErrorCode.DEVICE_NOT_ENROLLED, "Código expirado ou já utilizado", 401
        )
    token = "bridge_" + secrets.token_urlsafe(32)
    caps = body.capabilities.model_dump()
    if caps["level"] == "write_verified":
        caps["level"] = "write_supported_unverified"
    device = BridgeDevice(
        name=body.name,
        credential_hash=digest(token),
        key_fingerprint=digest(token)[:16],
        capabilities=caps,
        last_seen_at=utcnow(),
    )
    session.add(device)
    await session.flush()
    await session.delete(enrollment)
    audit(session, "bridge-enrollment", "bridge.enrolled", device_id=str(device.id))
    await session.commit()
    return {
        "device": device_out(device),
        "credential": token,
        "warning": "Credencial exibida apenas uma vez. Armazene no Keychain.",
    }


@router.post("/apple-sync/devices/{device_id}/revoke")
async def revoke(device_id: UUID, session: DB, identity: User) -> dict[str, Any]:
    device = await session.get(BridgeDevice, device_id, with_for_update=True)
    if device is None:
        raise AppError(ErrorCode.NOT_FOUND, "Dispositivo não encontrado", 404)
    device.revoked_at = utcnow()
    audit(session, identity.subject, "bridge.revoked", device_id=str(device_id))
    await session.commit()
    return device_out(device)


@router.post("/bridge/capabilities")
async def capabilities(body: Capabilities, session: DB, device: Device) -> dict[str, Any]:
    caps = body.model_dump()
    # A self-reported capability is never proof of a successful write test.
    if caps["level"] == "write_verified" and not device.write_verified:
        caps["level"] = "write_supported_unverified"
    if not caps["keywords_write"]:
        device.write_verified = False
    device.capabilities = caps
    await session.commit()
    return {"device": device_out(device)}


async def inventory_candidates(
    session: AsyncSession, items: list[InventoryItem]
) -> dict[str, list[str]]:
    """One bounded, parameterized PostgreSQL query for a whole inventory batch.

    LATERAL preserves the per-item limit even if many assets share a timestamp.
    Matching produces review candidates only, never verified identity mappings.
    """
    if not items:
        return {}
    rows = await session.execute(
        text("""
        SELECT incoming.local_identifier, candidate.id
        FROM jsonb_to_recordset(CAST(:items AS jsonb)) AS incoming(
            local_identifier text, sha256 text, captured_at timestamptz,
            width integer, height integer, media_type text
        )
        CROSS JOIN LATERAL (
            SELECT id FROM assets WHERE
                (incoming.sha256 IS NOT NULL AND assets.sha256 = incoming.sha256)
                OR (incoming.sha256 IS NULL AND incoming.captured_at IS NOT NULL
                    AND incoming.width > 0 AND incoming.height > 0
                    AND assets.width = incoming.width AND assets.height = incoming.height
                    AND assets.media_type = incoming.media_type
                    AND assets.captured_at BETWEEN
                        incoming.captured_at - INTERVAL '2 seconds' AND
                        incoming.captured_at + INTERVAL '2 seconds')
            ORDER BY id LIMIT 21
        ) AS candidate
    """),
        {
            "items": json.dumps(
                [
                    item.model_dump(
                        mode="json",
                        include={
                            "local_identifier",
                            "sha256",
                            "captured_at",
                            "width",
                            "height",
                            "media_type",
                        },
                    )
                    for item in items
                ]
            )
        },
    )
    found: dict[str, list[str]] = {}
    for local_identifier, asset_id in rows:
        found.setdefault(local_identifier, []).append(str(asset_id))
    return found


@router.post("/bridge/manifest")
async def manifest(body: Manifest, session: DB, device: Device) -> dict[str, Any]:
    # Serialize repeated batches from a device without automatic merges.
    await session.get(BridgeDevice, device.id, with_for_update=True)
    local_ids = [item.local_identifier for item in body.items]
    if len(set(local_ids)) != len(local_ids):
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Identificadores locais duplicados no mesmo lote",
            422,
        )
    mapped_rows = (
        await session.scalars(
            select(DeviceMapping).where(
                DeviceMapping.device_id == device.id,
                DeviceMapping.local_identifier.in_(local_ids),
                DeviceMapping.verification_status == "verified",
            )
        )
    ).all()
    mapping_by_local: dict[str, list[DeviceMapping]] = {}
    for row in mapped_rows:
        mapping_by_local.setdefault(row.local_identifier, []).append(row)
    local_field = MetadataSnapshot.payload["local_identifier"].as_string()
    snapshot_rows = (
        await session.scalars(
            select(MetadataSnapshot)
            .where(
                MetadataSnapshot.device_id == device.id,
                MetadataSnapshot.source == "photokit",
                local_field.in_(local_ids),
            )
            .distinct(local_field)
            .order_by(local_field, MetadataSnapshot.created_at.desc())
        )
    ).all()
    snapshots_by_local = {row.payload["local_identifier"]: row for row in snapshot_rows}
    candidates_by_local = await inventory_candidates(
        session,
        [
            item
            for item in body.items
            if len(mapping_by_local.get(item.local_identifier, [])) != 1
        ],
    )
    results = []
    for item in body.items:
        data = item.model_dump(mode="json")
        if item.keywords is not None:
            data["keywords"] = keywords(item.keywords)
        maps = mapping_by_local.get(item.local_identifier, [])
        asset_id = maps[0].asset_id if len(maps) == 1 else None
        matches = candidates_by_local.get(item.local_identifier, [])
        data["candidate_asset_ids"] = matches[:20]
        data["candidates_truncated"] = len(matches) > 20
        revision = (
            metadata_revision(item.keywords)
            if item.keywords is not None
            else digest("unreadable:" + item.local_identifier)
        )
        previous = snapshots_by_local.get(item.local_identifier)
        if previous is None or previous.revision_hash != revision:
            previous = MetadataSnapshot(
                id=uuid4(),
                asset_id=asset_id,
                device_id=device.id,
                source="photokit",
                revision_hash=revision,
                payload=data,
            )
            session.add(previous)
        else:
            previous.asset_id, previous.payload = asset_id, data
        results.append(
            {
                "snapshot_id": previous.id,
                "asset_id": asset_id,
                "mapping_status": "verified" if asset_id else "review_required",
                "candidate_asset_ids": data["candidate_asset_ids"][:20],
            }
        )
    audit(
        session,
        str(device.id),
        "bridge.inventory",
        count=len(body.items),
        complete=body.complete,
    )
    await session.commit()
    return {"accepted": len(results), "items": results, "checkpoint": body.checkpoint}


@router.get("/apple-sync/mappings")
async def mappings(
    session: DB,
    identity: User,
    limit: int = Query(50, ge=1, le=100),
    cursor: str | None = None,
) -> dict[str, Any]:
    query = select(MetadataSnapshot).where(MetadataSnapshot.source == "photokit")
    if cursor:
        query = query.where(MetadataSnapshot.id > UUID(decode_cursor(cursor)["id"]))
    rows = list(
        (
            await session.scalars(query.order_by(MetadataSnapshot.id).limit(limit + 1))
        ).all()
    )
    return {
        "items": [row_dict(row) for row in rows[:limit]],
        "next_cursor": encode_cursor({"id": rows[limit - 1].id})
        if len(rows) > limit
        else None,
    }


@router.post("/apple-sync/mappings/confirm")
async def confirm_mapping(
    body: MappingConfirmation, session: DB, identity: User
) -> dict[str, Any]:
    snapshot = await session.get(MetadataSnapshot, body.snapshot_id, with_for_update=True)
    asset = await session.get(Asset, body.asset_id)
    if (
        snapshot is None
        or asset is None
        or snapshot.device_id is None
        or snapshot.source != "photokit"
        or not snapshot.payload.get("local_identifier")
    ):
        raise AppError(ErrorCode.NOT_FOUND, "Snapshot ou fotografia não encontrado", 404)
    # Per-device lock closes races when approving two targets simultaneously.
    await session.get(BridgeDevice, snapshot.device_id, with_for_update=True)
    local_id = snapshot.payload["local_identifier"]
    conflicts = list(
        (
            await session.scalars(
                select(DeviceMapping).where(
                    DeviceMapping.device_id == snapshot.device_id,
                    DeviceMapping.verification_status == "verified",
                    or_(
                        DeviceMapping.local_identifier == local_id,
                        DeviceMapping.asset_id == body.asset_id,
                    ),
                )
            )
        ).all()
    )
    if any(
        row.asset_id != body.asset_id or row.local_identifier != local_id
        for row in conflicts
    ):
        raise AppError(
            ErrorCode.ASSET_MAPPING_AMBIGUOUS,
            "Correspondência já ligada a outro alvo",
            409,
        )
    mapping = (
        conflicts[0]
        if conflicts
        else await session.scalar(
            select(DeviceMapping).where(
                DeviceMapping.device_id == snapshot.device_id,
                DeviceMapping.asset_id == body.asset_id,
                DeviceMapping.local_identifier == local_id,
            )
        )
    )
    if mapping is None:
        mapping = DeviceMapping(
            asset_id=body.asset_id,
            device_id=snapshot.device_id,
            local_identifier=local_id,
        )
    alternatives = (
        await session.scalars(
            select(DeviceMapping).where(
                DeviceMapping.device_id == snapshot.device_id,
                DeviceMapping.verification_status != "verified",
                or_(
                    DeviceMapping.asset_id == body.asset_id,
                    DeviceMapping.local_identifier == local_id,
                ),
            )
        )
    ).all()
    for alternative in alternatives:
        alternative.verification_status = "rejected"
    mapping.cloud_identifier = snapshot.payload.get("cloud_identifier")
    mapping.confidence, mapping.verification_status, mapping.match_method = (
        1,
        "verified",
        "manual",
    )
    mapping.mapping_metadata = {
        "confirmed_by": identity.subject,
        "snapshot_id": str(snapshot.id),
    }
    snapshot.asset_id = body.asset_id
    session.add(mapping)
    audit(
        session,
        identity.subject,
        "bridge.mapping_verified",
        body.asset_id,
        device_id=str(snapshot.device_id),
        snapshot_id=str(snapshot.id),
    )
    await session.commit()
    return row_dict(mapping)


@router.get("/apple-sync/device-mappings")
async def device_mappings(
    session: DB,
    identity: User,
    device_id: UUID,
    limit: int = Query(50, ge=1, le=100),
    cursor: str | None = None,
) -> dict[str, Any]:
    query = select(DeviceMapping).where(DeviceMapping.device_id == device_id)
    if cursor:
        query = query.where(DeviceMapping.id > UUID(decode_cursor(cursor)["id"]))
    rows = list(
        (await session.scalars(query.order_by(DeviceMapping.id).limit(limit + 1))).all()
    )
    return {
        "items": [row_dict(row) for row in rows[:limit]],
        "next_cursor": encode_cursor({"id": rows[limit - 1].id})
        if len(rows) > limit
        else None,
    }


@router.post("/apple-sync/device-mappings/{mapping_id}/revoke")
async def revoke_mapping(mapping_id: UUID, session: DB, identity: User) -> dict[str, Any]:
    mapping = await session.get(DeviceMapping, mapping_id, with_for_update=True)
    if mapping is None:
        raise AppError(ErrorCode.NOT_FOUND, "Correspondência não encontrada", 404)
    await session.get(BridgeDevice, mapping.device_id, with_for_update=True)
    claimed = await session.scalar(
        select(SyncOperation.id)
        .where(
            SyncOperation.asset_id == mapping.asset_id,
            SyncOperation.target_device_id == mapping.device_id,
            SyncOperation.status.in_(["claimed", "processing"]),
        )
        .limit(1)
    )
    if claimed:
        raise AppError(
            ErrorCode.SYNC_CONFLICT,
            "Aguarde concluir a operação adquirida antes de alterar o alvo",
            409,
        )
    mapping.verification_status = "rejected"
    audit(
        session,
        identity.subject,
        "bridge.mapping_revoked",
        mapping.asset_id,
        device_id=str(mapping.device_id),
        mapping_id=str(mapping.id),
    )
    await session.commit()
    return row_dict(mapping)


async def sync_preview(body: SyncProposal, session: AsyncSession) -> dict[str, Any]:
    asset = await session.get(Asset, body.asset_id)
    device = await session.get(BridgeDevice, body.target_device_id)
    if asset is None or device is None or device.revoked_at:
        raise AppError(ErrorCode.NOT_FOUND, "Fotografia ou dispositivo indisponível", 404)
    mappings_found = list(
        (
            await session.scalars(
                select(DeviceMapping)
                .where(
                    DeviceMapping.asset_id == asset.id,
                    DeviceMapping.device_id == device.id,
                    DeviceMapping.verification_status != "rejected",
                )
                .limit(2)
            )
        ).all()
    )
    mapping = assert_verified_mapping(mappings_found)
    target_conflicts = await session.scalar(
        select(func.count())
        .select_from(DeviceMapping)
        .where(
            DeviceMapping.device_id == device.id,
            DeviceMapping.local_identifier == mapping.local_identifier,
            DeviceMapping.verification_status == "verified",
        )
    )
    if target_conflicts != 1:
        raise AppError(ErrorCode.ASSET_MAPPING_AMBIGUOUS, "Alvo local ambíguo", 409)
    snapshot = await session.scalar(
        select(MetadataSnapshot)
        .where(
            MetadataSnapshot.asset_id == asset.id,
            MetadataSnapshot.device_id == device.id,
            MetadataSnapshot.source == "photokit",
            MetadataSnapshot.payload["local_identifier"].as_string()
            == mapping.local_identifier,
        )
        .order_by(MetadataSnapshot.created_at.desc())
        .limit(1)
    )
    if snapshot is None or snapshot.payload.get("keywords") is None:
        raise AppError(
            ErrorCode.PHOTOKIT_WRITE_UNAVAILABLE,
            "Bridge não consegue ler keywords; nenhuma escrita é segura",
            409,
        )
    applied = (
        await session.scalars(
            select(SyncOperation)
            .where(
                SyncOperation.asset_id == asset.id,
                SyncOperation.target_device_id == device.id,
                SyncOperation.status.in_(
                    ["applied_on_device", "awaiting_cloud_confirmation", "completed"]
                ),
            )
            .order_by(SyncOperation.created_at)
        )
    ).all()
    managed: set[str] = set()
    for previous in applied:
        managed.update(previous.payload.get("actual_add", []))
        managed.difference_update(previous.payload.get("actual_remove", []))
    delta = keyword_delta(
        snapshot.payload["keywords"],
        body.add,
        body.remove,
        sorted(managed),
        body.approve_removals,
    )
    can_write = bool(device.capabilities.get("keywords_write")) and (
        device.write_verified or body.single_asset_test
    )
    return {
        **delta,
        "asset_id": asset.id,
        "target_device_id": device.id,
        "filename": asset.filename,
        "local_identifier": mapping.local_identifier,
        "mapping_status": "verified",
        "managed_keywords": sorted(managed),
        "source": body.source,
        "write_available": can_write,
        "capability": device.capabilities.get("level", "unavailable"),
        "cloud_confirmation_available": False,
    }


@router.post("/apple-sync/preview")
async def preview(body: SyncProposal, session: DB, identity: User) -> dict[str, Any]:
    return await sync_preview(body, session)


@router.post("/apple-sync/operations", status_code=201)
async def create_operation(
    body: CreateOperation, session: DB, identity: User
) -> dict[str, Any]:
    # Lock target to serialize creation, first-write trials and idempotency decisions.
    await session.get(BridgeDevice, body.target_device_id, with_for_update=True)
    idempotency = f"apple-sync:{body.target_device_id}:{body.idempotency_key}"
    previous = await session.scalar(
        select(SyncOperation).where(
            SyncOperation.idempotency_key == idempotency,
        )
    )
    if previous:
        if (
            previous.asset_id != body.asset_id
            or previous.payload.get("requested_add") != keywords(body.add)
            or previous.payload.get("requested_remove") != keywords(body.remove)
        ):
            raise AppError(
                ErrorCode.SYNC_CONFLICT, "Chave de idempotência reutilizada", 409
            )
        return operation_out(previous)
    result = await sync_preview(body, session)
    if body.single_asset_test and not (result["add"] or result["remove"]):
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Teste individual exige uma alteração real e explícita",
            422,
        )
    if get_settings().apple_keyword_sync_mode == "disabled":
        raise AppError(
            ErrorCode.PHOTOKIT_WRITE_UNAVAILABLE, "Sincronização desativada", 409
        )
    device = await session.get(BridgeDevice, body.target_device_id)
    assert device is not None
    if not device.write_verified and body.single_asset_test:
        prior_test = await session.scalar(
            select(SyncOperation.id)
            .where(
                SyncOperation.target_device_id == device.id,
                SyncOperation.status.not_in(["cancelled", "failed"]),
                SyncOperation.payload["single_asset_test"].as_boolean().is_(True),
            )
            .limit(1)
        )
        if prior_test:
            raise AppError(
                ErrorCode.SYNC_VERIFICATION_FAILED,
                "Conclua e confirme o teste individual antes de outra escrita",
                409,
            )
    operation = SyncOperation(
        asset_id=body.asset_id,
        target_device_id=body.target_device_id,
        expected_revision=result["expected_revision"],
        desired_revision=result["desired_revision"],
        idempotency_key=idempotency,
        status="pending" if body.approve else "awaiting_approval",
        approved_by=identity.subject if body.approve else None,
        approved_at=utcnow() if body.approve else None,
        payload={
            "base_keywords": result["before"],
            "add": result["add"],
            "remove": result["remove"],
            "requested_add": keywords(body.add),
            "requested_remove": keywords(body.remove),
            "managed_keywords": result["managed_keywords"],
            "approve_removals": body.approve_removals,
            "source": body.source,
            "single_asset_test": body.single_asset_test,
            "local_identifier": result["local_identifier"],
        },
        last_error=None if result["write_available"] else "PHOTOKIT_WRITE_UNAVAILABLE",
    )
    session.add(operation)
    await session.flush()
    audit(
        session,
        identity.subject,
        "apple_sync.created",
        body.asset_id,
        operation_id=str(operation.id),
        approved=body.approve,
    )
    await session.commit()
    return operation_out(operation)


@router.post("/apple-sync/operations/{operation_id}/approve")
async def approve_operation(
    operation_id: UUID, session: DB, identity: User
) -> dict[str, Any]:
    operation = await session.get(SyncOperation, operation_id, with_for_update=True)
    if operation is None:
        raise AppError(ErrorCode.NOT_FOUND, "Operação não encontrada", 404)
    if operation.status != "awaiting_approval":
        raise AppError(
            ErrorCode.SYNC_CONFLICT, "Operação não está aguardando aprovação", 409
        )
    operation.status, operation.approved_by, operation.approved_at = (
        "pending",
        identity.subject,
        utcnow(),
    )
    audit(
        session,
        identity.subject,
        "apple_sync.approved",
        operation.asset_id,
        operation_id=str(operation.id),
    )
    await session.commit()
    return operation_out(operation)


@router.post("/apple-sync/operations/{operation_id}/retry")
async def retry_operation(
    operation_id: UUID, session: DB, identity: User
) -> dict[str, Any]:
    operation = await session.get(SyncOperation, operation_id, with_for_update=True)
    if operation is None:
        raise AppError(ErrorCode.NOT_FOUND, "Operação não encontrada", 404)
    if operation.status not in {"failed", "conflict", "mapping_required"}:
        raise AppError(ErrorCode.SYNC_CONFLICT, "Estado não permite nova tentativa", 409)
    previous = operation.payload
    proposal = SyncProposal(
        asset_id=operation.asset_id,
        target_device_id=operation.target_device_id,
        add=previous["requested_add"],
        remove=previous["requested_remove"],
        approve_removals=previous["approve_removals"],
        single_asset_test=previous["single_asset_test"],
        source=previous["source"],
    )
    result = await sync_preview(proposal, session)
    # A changed revision always receives a fresh preview and explicit approval.
    operation.payload = {
        **previous,
        "base_keywords": result["before"],
        "add": result["add"],
        "remove": result["remove"],
        "managed_keywords": result["managed_keywords"],
    }
    for key in ("lease_token_hash", "receipt_hash", "merge_preview"):
        operation.payload.pop(key, None)
    operation.expected_revision, operation.desired_revision = (
        result["expected_revision"],
        result["desired_revision"],
    )
    operation.status, operation.last_error = "awaiting_approval", None
    operation.approved_by, operation.approved_at, operation.lease_until = None, None, None
    audit(
        session,
        identity.subject,
        "apple_sync.retry_preview",
        operation.asset_id,
        operation_id=str(operation.id),
    )
    await session.commit()
    return operation_out(operation)


@router.get("/apple-sync/operations")
async def operations(
    session: DB,
    identity: User,
    limit: int = Query(50, ge=1, le=100),
    cursor: str | None = None,
) -> dict[str, Any]:
    query = select(SyncOperation)
    if cursor:
        query = query.where(SyncOperation.id > UUID(decode_cursor(cursor)["id"]))
    rows = list(
        (await session.scalars(query.order_by(SyncOperation.id).limit(limit + 1))).all()
    )
    return {
        "items": [operation_out(row) for row in rows[:limit]],
        "next_cursor": encode_cursor({"id": rows[limit - 1].id})
        if len(rows) > limit
        else None,
    }


@router.post("/apple-sync/operations/{operation_id}/cancel")
async def cancel(operation_id: UUID, session: DB, identity: User) -> dict[str, Any]:
    operation = await session.get(SyncOperation, operation_id, with_for_update=True)
    if operation is None:
        raise AppError(ErrorCode.NOT_FOUND, "Operação não encontrada", 404)
    if operation.status in {
        "claimed",
        "processing",
        "applied_on_device",
        "awaiting_cloud_confirmation",
        "completed",
    }:
        raise AppError(
            ErrorCode.SYNC_CONFLICT,
            "Alteração possivelmente iniciada; não é seguro afirmar cancelamento",
            409,
        )
    operation.status, operation.lease_until = "cancelled", None
    audit(
        session,
        identity.subject,
        "apple_sync.cancelled",
        operation.asset_id,
        operation_id=str(operation.id),
    )
    await session.commit()
    return operation_out(operation)


@router.get("/bridge/operations")
async def claim_operations(
    session: DB, device: Device, limit: int = Query(1, ge=1, le=20)
) -> dict[str, Any]:
    await session.get(BridgeDevice, device.id, with_for_update=True)
    if get_settings().apple_keyword_sync_mode == "disabled":
        return {"items": [], "reason": "Sincronização desativada"}
    if not device.capabilities.get("keywords_write") or not device.capabilities.get(
        "keywords_read"
    ):
        await session.commit()
        return {
            "items": [],
            "error_code": "PHOTOKIT_WRITE_UNAVAILABLE",
            "reason": "Dispositivo oferece somente leitura; operações preservadas",
        }
    if limit > 1 and (
        not device.write_verified or not get_settings().apple_bulk_write_enabled
    ):
        raise AppError(
            ErrorCode.PHOTOKIT_WRITE_UNAVAILABLE,
            "Escritas em lote estão desativadas",
            409,
        )
    if not get_settings().apple_bulk_write_enabled:
        in_flight = await session.scalar(
            select(SyncOperation.id)
            .where(
                SyncOperation.target_device_id == device.id,
                SyncOperation.status.in_(["claimed", "processing"]),
                SyncOperation.lease_until > utcnow(),
            )
            .limit(1)
        )
        if in_flight:
            await session.commit()
            return {"items": [], "reason": "Uma operação individual já está adquirida"}
    query = select(SyncOperation).where(
        SyncOperation.target_device_id == device.id,
        SyncOperation.approved_at.is_not(None),
        or_(
            SyncOperation.status == "pending",
            and_(
                SyncOperation.status == "claimed",
                SyncOperation.lease_until < utcnow(),
            ),
        ),
    )
    if not device.write_verified:
        query = query.where(
            SyncOperation.payload["single_asset_test"].as_boolean().is_(True)
        )
    rows = list(
        (
            await session.scalars(
                query.order_by(SyncOperation.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).all()
    )
    items = []
    for operation in rows:
        maps = list(
            (
                await session.scalars(
                    select(DeviceMapping)
                    .where(
                        DeviceMapping.asset_id == operation.asset_id,
                        DeviceMapping.device_id == device.id,
                        DeviceMapping.verification_status != "rejected",
                    )
                    .limit(2)
                )
            ).all()
        )
        try:
            mapping = assert_verified_mapping(maps)
            if mapping.local_identifier != operation.payload["local_identifier"]:
                raise AppError(
                    ErrorCode.ASSET_MAPPING_AMBIGUOUS, "Correspondência mudou", 409
                )
        except AppError:
            operation.status, operation.last_error = (
                "mapping_required",
                "ASSET_MAPPING_AMBIGUOUS",
            )
            continue
        token = secrets.token_urlsafe(32)
        operation.status, operation.attempts = "claimed", operation.attempts + 1
        operation.lease_until = utcnow() + timedelta(minutes=5)
        operation.payload = {**operation.payload, "lease_token_hash": digest(token)}
        items.append({**operation_out(operation), "lease_token": token})
        audit(
            session,
            str(device.id),
            "apple_sync.claimed",
            operation.asset_id,
            operation_id=str(operation.id),
        )
    await session.commit()
    return {"items": items}


@router.get("/bridge/operations/preview")
async def preview_device_operations(
    session: DB,
    device: Device,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
) -> dict[str, Any]:
    query = select(SyncOperation).where(
        SyncOperation.target_device_id == device.id,
        SyncOperation.status.not_in(["cancelled", "completed"]),
    )
    if cursor:
        query = query.where(SyncOperation.id > UUID(decode_cursor(cursor)["id"]))
    rows = list(
        (await session.scalars(query.order_by(SyncOperation.id).limit(limit + 1))).all()
    )
    await session.commit()
    return {
        "items": [operation_out(row) for row in rows[:limit]],
        "next_cursor": encode_cursor({"id": rows[limit - 1].id})
        if len(rows) > limit
        else None,
        "read_only": True,
    }


@router.post("/bridge/operations/{operation_id}/ack")
async def acknowledge(
    operation_id: UUID, body: Acknowledgement, session: DB, device: Device
) -> dict[str, Any]:
    operation = await session.get(SyncOperation, operation_id, with_for_update=True)
    if operation is None or operation.target_device_id != device.id:
        raise AppError(ErrorCode.NOT_FOUND, "Operação não encontrada", 404)
    stored_hash = operation.payload.get("lease_token_hash", "")
    if not secrets.compare_digest(digest(body.lease_token), stored_hash):
        raise AppError(ErrorCode.FORBIDDEN, "Lease não corresponde à operação", 403)
    receipt = digest(body.model_dump_json())
    if operation.payload.get("receipt_hash") == receipt:
        return operation_out(operation)
    if (
        operation.status != "claimed"
        or operation.lease_until is None
        or operation.lease_until <= utcnow()
    ):
        raise AppError(
            ErrorCode.SYNC_CONFLICT, "Lease expirado ou operação cancelada", 409
        )
    data = dict(operation.payload)
    if body.status == "applied_on_device":
        if not device.capabilities.get("keywords_write"):
            raise AppError(
                ErrorCode.PHOTOKIT_WRITE_UNAVAILABLE, "Escrita indisponível", 409
            )
        validate_write_receipt(
            data, operation.expected_revision, body.before_keywords, body.after_keywords
        )
        # Device read-back proves device state only; no claim of iCloud confirmation.
        operation.status = "awaiting_cloud_confirmation"
        data.update(
            actual_add=data["add"],
            actual_remove=data["remove"],
            before_keywords=keywords(body.before_keywords),
            after_keywords=keywords(body.after_keywords),
            device_readback_verified=True,
        )
        session.add(
            MetadataSnapshot(
                asset_id=operation.asset_id,
                device_id=device.id,
                source="photokit",
                revision_hash=metadata_revision(body.after_keywords),
                payload={
                    "local_identifier": data["local_identifier"],
                    "keywords": keywords(body.after_keywords),
                },
            )
        )
    elif body.status == "conflict":
        operation.status, operation.last_error = "conflict", "SYNC_CONFLICT"
        try:
            data["merge_preview"] = three_way_merge(
                data["base_keywords"],
                body.before_keywords,
                data["add"],
                data["remove"],
                data["managed_keywords"],
            )
        except AppError:
            data["merge_preview"] = None
    elif body.status == "unsupported":
        operation.status, operation.last_error = "pending", "PHOTOKIT_WRITE_UNAVAILABLE"
    else:
        operation.status, operation.last_error = "failed", "SYNC_VERIFICATION_FAILED"
    data["receipt_hash"] = receipt
    operation.payload, operation.lease_until = data, None
    audit(
        session,
        str(device.id),
        "apple_sync.acknowledged",
        operation.asset_id,
        operation_id=str(operation.id),
        status=operation.status,
    )
    await session.commit()
    return operation_out(operation)


@router.post("/apple-sync/operations/{operation_id}/verify-single-write")
async def verify_single_write(
    operation_id: UUID, session: DB, identity: User
) -> dict[str, Any]:
    operation = await session.get(SyncOperation, operation_id, with_for_update=True)
    if operation is None:
        raise AppError(ErrorCode.NOT_FOUND, "Operação não encontrada", 404)
    if (
        operation.status != "awaiting_cloud_confirmation"
        or not operation.payload.get("single_asset_test")
        or not operation.payload.get("device_readback_verified")
    ):
        raise AppError(
            ErrorCode.SYNC_VERIFICATION_FAILED,
            "Teste individual ainda não verificado",
            409,
        )
    device = await session.get(
        BridgeDevice, operation.target_device_id, with_for_update=True
    )
    assert device is not None
    if not device.capabilities.get("keywords_write"):
        raise AppError(
            ErrorCode.PHOTOKIT_WRITE_UNAVAILABLE, "Capability de escrita ausente", 409
        )
    device.write_verified, device.verified_asset_id = True, operation.asset_id
    device.capabilities = {**device.capabilities, "level": "write_verified"}
    audit(
        session,
        identity.subject,
        "bridge.single_write_verified",
        operation.asset_id,
        operation_id=str(operation.id),
        device_id=str(device.id),
    )
    await session.commit()
    return device_out(device)


@router.get("/apple-sync/status")
async def status(session: DB, identity: User) -> dict[str, Any]:
    devices = (
        await session.scalars(
            select(BridgeDevice).order_by(BridgeDevice.enrolled_at.desc()).limit(100)
        )
    ).all()
    counts = (
        await session.execute(
            select(SyncOperation.status, func.count()).group_by(SyncOperation.status)
        )
    ).all()
    return {
        "devices": [device_out(device) for device in devices],
        "operations": {status: count for status, count in counts},
        "mode": get_settings().apple_keyword_sync_mode,
        "bulk_write_enabled": get_settings().apple_bulk_write_enabled,
        "cloud_confirmation_available": False,
        "keyword_write_note": (
            "Pyto v1 é somente leitura; API Beta depende de validação no dispositivo."
        ),
    }


@router.get("/bridge/status")
async def device_status(session: DB, device: Device) -> dict[str, Any]:
    counts = (
        await session.execute(
            select(SyncOperation.status, func.count())
            .where(SyncOperation.target_device_id == device.id)
            .group_by(SyncOperation.status)
        )
    ).all()
    await session.commit()
    return {
        "device": device_out(device),
        "operations": {status: count for status, count in counts},
    }
