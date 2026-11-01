"""Resumable discovery manifests and independent, fenced asset downloads.

The pinned unofficial SDK has rank offsets, not stable CloudKit cursors. Offsets
are only a resume optimization: verified anchor IDs detect source shifts, while
unique manifest identities and revision keys remain the durable ground truth.
"""

import asyncio
import base64
import json
import os
from collections import deque
from contextlib import suppress
from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset,
    AssetResource,
    DiscoveryManifest,
    DiscoveryScan,
    IngestionRun,
    Job,
    JobBatch,
    Library,
    MetadataSnapshot,
    ObjectIntent,
    Setting,
    utcnow,
)
from photointel.services.identity import revision_hash
from photointel.services.ingestion import (
    ICloudAdapter,
    RemoteAsset,
    _library,
    _next_photo,
    _upsert_asset,
    classify_icloud_failure,
    fixture_content_hash,
    reconcile_catalog_admission,
    record_batch_skip,
)
from photointel.services.jobs import enqueue_job
from photointel.services.leases import (
    LeaseLost,
    acquire_lease,
    assert_job_fences,
    assert_lease,
    release_lease,
    renew_lease,
)
from photointel.services.session_store import encryption_key, session_directory
from photointel.storage import get_storage

ANCHOR_COUNT = 32
MANIFEST_VERSION = 1
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024


def _aad(library_id: UUID, source_key: str, revision: str) -> bytes:
    return json.dumps(
        ["photointel-discovery", MANIFEST_VERSION, str(library_id), source_key, revision],
        separators=(",", ":"),
    ).encode()


def encrypt_remote_snapshot(
    photo: Any, settings: Settings, library_id: UUID, source_key: str, revision: str
) -> dict[str, Any]:
    """Signed download URLs never enter plaintext PostgreSQL JSON or logs."""
    payload = json.dumps(
        {"master": photo._master_record, "asset": photo._asset_record},
        separators=(",", ":"),
    ).encode()
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise AppError(ErrorCode.MEDIA_DOWNLOAD_FAILED, "Manifesto remoto excede limite")
    nonce = os.urandom(12)
    ciphertext = AESGCM(encryption_key(settings)).encrypt(
        nonce, payload, _aad(library_id, source_key, revision)
    )
    return {
        "version": MANIFEST_VERSION,
        "key_id": settings.icloud_session_key_id,
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }


def decrypt_remote_snapshot(
    snapshot: dict[str, Any],
    settings: Settings,
    library_id: UUID,
    source_key: str,
    revision: str,
) -> Any:
    from pyicloud_ipd.services.photos import PhotoAsset

    try:
        if (
            snapshot.get("version") != MANIFEST_VERSION
            or snapshot.get("key_id") != settings.icloud_session_key_id
            or len(snapshot.get("ciphertext", "")) > 3 * MAX_SNAPSHOT_BYTES
        ):
            raise ValueError("Unsupported manifest")
        nonce = base64.b64decode(snapshot["nonce"], validate=True)
        ciphertext = base64.b64decode(snapshot["ciphertext"], validate=True)
        data = AESGCM(encryption_key(settings)).decrypt(
            nonce, ciphertext, _aad(library_id, source_key, revision)
        )
        records = json.loads(data)
        return PhotoAsset(records["master"], records["asset"])
    except (InvalidTag, ValueError, TypeError, KeyError):
        raise AppError(
            ErrorCode.MEDIA_DOWNLOAD_FAILED,
            "Manifesto remoto inválido; refaça a descoberta sem apagar o catálogo",
            503,
        ) from None


def failure_category(code: str) -> str:
    return {
        "ICLOUD_AUTH_EXPIRED": "authentication_required",
        "ICLOUD_ACCESS_DENIED": "authentication_required",
        "ICLOUD_RATE_LIMITED": "rate_limited",
        "ICLOUD_ASSET_UNAVAILABLE": "remote_asset_unavailable",
        "MEDIA_DECODE_FAILED": "corrupt_media",
        "R2_UPLOAD_FAILED": "storage_error",
        "STORAGE_UNAVAILABLE": "storage_error",
        "INVALID_REPRESENTATION": "invalid_representation",
        "PERMANENT_FAILURE": "permanent_failure",
    }.get(str(code), "transient_network_error")


async def record_asset_failure(
    asset_id: UUID,
    code: str,
    job_status: str,
    *,
    expected_revision: str | None = None,
    job_fences: list | None = None,
) -> None:
    """A bounded failure affects one revision only; completed rows are untouched."""
    async with SessionLocal() as session:
        await assert_job_fences(session, job_fences or [])
        asset = await session.get(Asset, asset_id, with_for_update=True)
        if asset is None or (
            expected_revision is not None and asset.content_revision != expected_revision
        ):
            return
        manifest = await session.scalar(
            select(DiscoveryManifest)
            .where(
                DiscoveryManifest.asset_id == asset_id,
                DiscoveryManifest.content_revision == asset.content_revision,
            )
            .with_for_update()
        )
        if manifest is None or manifest.status == "completed":
            return
        category = failure_category(code)
        permanent = category in {
            "corrupt_media",
            "invalid_representation",
            "permanent_failure",
        }
        exhausted = (
            manifest.attempts >= manifest.maximum_attempts or job_status == "failed"
        )
        state = "quarantined" if permanent or exhausted else "retrying"
        manifest.status, manifest.failure_category = state, category
        manifest.last_error = str(code)[:64]
        asset.ingestion_status, asset.last_error = state, str(code)[:64]
        await session.commit()


async def mark_asset_processing(asset_id: UUID, status: str = "processing") -> None:
    if status not in {"processing", "completed"}:
        raise ValueError("Invalid processing status")
    async with SessionLocal() as session:
        asset = await session.get(Asset, asset_id)
        if asset:
            await session.execute(
                update(DiscoveryManifest)
                .where(
                    DiscoveryManifest.asset_id == asset_id,
                    DiscoveryManifest.content_revision == asset.content_revision,
                    DiscoveryManifest.status.not_in(("quarantined", "failed")),
                )
                .values(status=status)
            )
            await session.commit()


def _fences(job_id: UUID | None, owner: str | None, token: int | None):
    return [(job_id, owner, token)] if job_id and owner and token is not None else []


async def _execution_limit(
    settings: Settings, requested: int, job_id: UUID | None
) -> int:
    from photointel.services.import_policy import authorize_import, validate_execution

    if job_id:
        async with SessionLocal() as session:
            job = await session.get(Job, job_id)
            authorization = (job.payload.get("authorization") or {}) if job else {}
        if not authorization:
            # Legacy scheduled jobs have no expansion authorization. Their finite
            # limit must still meet the initial, non-expanded safety policy.
            authorization = authorize_import(settings, requested, False)
    else:
        authorization = authorize_import(settings, requested, False)
    permitted = validate_execution(settings, authorization)
    if requested != permitted:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Limite diverge da autorização persistida"
        )
    return permitted


def _remote_source(remote: RemoteAsset, settings: Settings, scan_id: UUID):
    content_revision = revision_hash(
        {
            "id": remote.source_key,
            "original_bytes": remote.original_size,
            "representation_checksum": remote.representation_checksum,
            "representation_bytes": remote.representation_size,
            "representation": settings.download_representation,
        }
    )
    public_snapshot = {
        "filename": remote.filename,
        "original_bytes": remote.original_size,
        "captured_at": remote.captured_at.isoformat() if remote.captured_at else None,
        "added_at": remote.added_at.isoformat() if remote.added_at else None,
        "dimensions": remote.dimensions,
        "content_revision": content_revision,
    }
    source = {
        "downloader_id": remote.source_key,
        "icloud_library": settings.icloud_library,
        "source_account": sha256(settings.icloud_account.encode()).hexdigest(),
        "scan_token": str(scan_id),
        "source_identity_kind": "icloudpd_not_phcloud",
        "representation": settings.download_representation,
        "live_photo": bool(remote.live_resources),
        "metadata_revision": revision_hash(public_snapshot),
        "cache_relative_path": (
            f"{sha256(remote.source_key.encode()).hexdigest()}/{content_revision}.image"
        ),
    }
    return content_revision, public_snapshot, source


async def _reserve_download(
    session: Any,
    settings: Settings,
    manifest: DiscoveryManifest,
    byte_size: int,
    batch_id: UUID | None,
    job_id: UUID | None,
    run_id: UUID,
) -> bool:
    """Reserve once per representation under a short, durable budget row lock."""
    snapshot = dict(manifest.snapshot or {})
    if snapshot.get("download_reservation"):
        return True
    holder: Any = None
    field = "counters"
    if batch_id:
        holder = await session.get(JobBatch, batch_id, with_for_update=True)
    if holder is None and job_id:
        holder = await session.get(Job, job_id, with_for_update=True)
        field = "payload"
    if holder is None:
        key = f"download_budget:{run_id}"
        await session.execute(
            insert(Setting)
            .values(key=key, value={})
            .on_conflict_do_nothing(index_elements=[Setting.key])
        )
        holder = await session.get(Setting, key, with_for_update=True)
        field = "value"
    assert holder is not None
    values = dict(getattr(holder, field) or {})
    budget = dict(values.get("download_budget") or {})
    scope = str(job_id or run_id)
    executions = dict(budget.get("executions") or {})
    execution_budget = dict(executions.get(scope) or {})
    reserved = int(execution_budget.get("reserved_bytes", 0))
    if reserved + byte_size > settings.max_run_download_bytes:
        manifest.snapshot = {
            **snapshot,
            "budget_refusal": {
                "code": "DOWNLOAD_BUDGET_EXCEEDED",
                "representation_bytes": byte_size,
                "reserved_bytes": reserved,
                "limit_bytes": settings.max_run_download_bytes,
            },
        }
        return False
    executions[scope] = {
        "reserved_bytes": reserved + byte_size,
        "limit_bytes": settings.max_run_download_bytes,
    }
    budget.update(
        reserved_bytes=int(budget.get("reserved_bytes", 0)) + byte_size,
        limit_bytes_per_execution=settings.max_run_download_bytes,
        executions=executions,
        updated_at=utcnow().isoformat(),
    )
    setattr(holder, field, {**values, "download_budget": budget})
    manifest.snapshot = {
        **snapshot,
        "download_reservation": {
            "bytes": byte_size,
            "scope": scope,
        },
    }
    return True


async def _backfill_target(
    session: Any, settings: Settings, payload: dict[str, Any]
) -> int | None:
    """Continue previously approved finite batches, including after API redeploys.

    High-scale permission is checked before the initial job is created. Persisted
    authorization is never promoted to a larger target, and current runtime
    capacity/byte/batch limits remain in force for every execution.
    """
    from re import fullmatch
    from photointel.services.import_policy import validate_execution

    approval = payload.get("backfill_authorization")
    if approval is None:
        return None
    if not isinstance(approval, dict):
        raise AppError(ErrorCode.INVALID_REQUEST, "Autorização de backfill inválida", 409)
    target = approval.get("target_assets")
    source_sha = approval.get("release_sha")
    if (
        type(target) is not int
        or not 1 <= target <= settings.catalog_asset_limit
        or settings.database_profile != "full"
        or (source_sha is not None and (
            not isinstance(source_sha, str)
            or fullmatch(r"[0-9a-f]{40}", source_sha) is None
        ))
        or not isinstance(approval.get("authorized_by"), str)
        or not approval["authorized_by"].strip()
        or not isinstance(approval.get("approved_at"), str)
        or not approval["approved_at"].strip()
    ):
        raise AppError(ErrorCode.INVALID_REQUEST, "Autorização de backfill inválida", 409)
    validate_execution(settings, approval.get("authorization") or {})
    return target


async def _chain_backfill(
    session: Any,
    settings: Settings,
    payload: dict[str, Any],
    scan: DiscoveryScan,
    batch_id: UUID | None,
    exhausted: bool,
) -> UUID | None:
    if scan.mode != "backfill" or exhausted:
        return None
    target = await _backfill_target(session, settings, payload)
    if target is None or scan.seen_count >= target:
        return None
    from photointel.services.import_policy import validate_execution
    from photointel.services.outbox import enqueue_dispatch

    original = dict(payload["backfill_authorization"]["authorization"])
    limit = min(validate_execution(settings, original), target - scan.seen_count)
    authorization = {**original, "requested_batch_limit": limit}
    # Scope-local counters cannot be copied to the next finite execution.
    next_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"discovery_progress", "download_budget"}
    }
    next_payload.update(authorization=authorization, limit=limit, mode="backfill")
    offset = int(scan.source_cursor.get("offset", 0))
    child = await enqueue_job(
        session,
        "icloud_discovery",
        payload=next_payload,
        idempotency_key=f"backfill:{scan.id}:{offset}:{scan.seen_count}",
        batch_id=batch_id,
    )
    if settings.execution_platform == "cloud_run":
        await enqueue_dispatch(session, "backfill", f"backfill-dispatch:{child.id}")
    return child.id


async def discover_icloud(
    settings: Settings,
    execution_limit: int,
    job_id: UUID | None = None,
    batch_id: UUID | None = None,
    full_scan: bool = False,
    mode: str = "incremental",
    owner: str | None = None,
    fence_token: int | None = None,
) -> dict[str, Any]:
    """Persist one bounded source page; media failures cannot roll back discovery."""
    if not settings.icloud_enabled or not settings.icloud_account:
        raise AppError(ErrorCode.ICLOUD_ACCESS_DENIED, "Configure integração iCloud", 503)
    if mode not in {"incremental", "backfill", "reconciliation"}:
        raise AppError(ErrorCode.INVALID_REQUEST, "Modo de descoberta inválido")
    if full_scan:
        mode = "reconciliation"
    execution_limit = await _execution_limit(settings, execution_limit, job_id)
    encryption_key(settings)  # Fail closed before persisting any signed URL.
    identifier = sha256(
        f"{settings.icloud_account}:{settings.icloud_library}".encode()
    ).hexdigest()
    lock_key, lock_owner = f"discovery:{identifier}", str(uuid4())
    lease_seconds = max(180, settings.icloud_session_lease_seconds)
    fences = _fences(job_id, owner, fence_token)
    async with SessionLocal() as session:
        token = await acquire_lease(session, lock_key, lock_owner, lease_seconds)
        if token is None:
            raise AppError(
                ErrorCode.ICLOUD_RATE_LIMITED, "Descoberta já em execução", 409
            )
        await assert_job_fences(session, fences)
        parent_job = await session.get(Job, job_id) if job_id else None
        parent_payload = dict(parent_job.payload) if parent_job else {}
        previous_count = int(
            (parent_payload.get("discovery_progress") or {}).get("discovered", 0)
        )
        if not 0 <= previous_count <= execution_limit:
            raise AppError(ErrorCode.INVALID_REQUEST, "Checkpoint excede autorização")
        remaining_limit = execution_limit - previous_count
        library = await _library(session, "icloud", identifier, settings.icloud_library)
        library.last_attempted_scan = utcnow()
        scan = await session.scalar(
            select(DiscoveryScan)
            .where(
                DiscoveryScan.library_id == library.id,
                DiscoveryScan.mode == mode,
                DiscoveryScan.status.in_(("discovering", "interrupted")),
            )
            .order_by(DiscoveryScan.created_at.desc())
            .limit(1)
            .with_for_update()
        )
        if scan is None:
            scan = DiscoveryScan(library_id=library.id, mode=mode, source_cursor={})
            session.add(scan)
        run = IngestionRun(library_id=library.id, job_id=job_id, full_scan=full_scan)
        session.add(run)
        await session.flush()
        scan_id, library_id, run_id = scan.id, library.id, run.id
        cursor = dict(scan.source_cursor)
        target = await _backfill_target(session, settings, parent_payload)
        if target is not None:
            remaining_limit = min(remaining_limit, max(0, target - scan.seen_count))
        await reconcile_catalog_admission(session)
        await session.commit()
    discovered = imported = skipped = failed = 0
    exhausted = False
    try:
        if remaining_limit > 0:
            async with session_directory(settings) as directory:
                current_settings = settings.model_copy(
                    update={"icloud_session_directory": directory}
                )
                adapter = ICloudAdapter(current_settings)
                try:
                    await asyncio.to_thread(adapter.connect)
                except AppError:
                    raise
                except Exception as exc:
                    code, reason = classify_icloud_failure(type(exc).__name__)
                    raise AppError(code, reason, 503) from None
                offset = int(cursor.get("offset", 0))
                anchors = list(cursor.get("anchors", []))[-ANCHOR_COUNT:]
                if offset and anchors:
                    anchor_iterator = await asyncio.to_thread(
                        adapter.assets, max(0, offset - len(anchors))
                    )
                    actual = []
                    for _ in anchors:
                        photo = await asyncio.to_thread(_next_photo, anchor_iterator)
                        if photo is None:
                            break
                        actual.append(str(photo.id))
                    if actual != anchors:
                        # Insertion/deletion shifted ranks. Rescan only discovery;
                        # manifest uniqueness prevents duplicate processing/downloads.
                        offset, anchors = 0, []
                        cursor["source_shift_detected"] = True
                iterator = await asyncio.to_thread(adapter.assets, offset)
                anchor_ids = deque(anchors, maxlen=ANCHOR_COUNT)
                consecutive_known = 0
                while discovered < remaining_limit:
                    photo = await asyncio.to_thread(_next_photo, iterator)
                    if photo is None:
                        exhausted = True
                        break
                    try:
                        remote = await asyncio.to_thread(adapter.describe, photo)
                    except Exception:
                        # A malformed single record has a durable identity and remains
                        # inspectable in quarantine; it cannot roll back earlier rows.
                        # If identity itself is unavailable, stop and retain checkpoint
                        # rather than guessing a filename/PhotoKit mapping.
                        source_key = str(photo.id)
                        remote = RemoteAsset(
                            source_key=source_key,
                            filename=f"unavailable-{sha256(source_key.encode()).hexdigest()[:16]}",
                            media_type="image",
                            original_size=None,
                            captured_at=None,
                            added_at=None,
                            dimensions=None,
                            version=None,
                            representation_size=None,
                            representation_checksum=None,
                            live_resources=(),
                        )
                    revision, public_snapshot, source = _remote_source(
                        remote, settings, scan_id
                    )
                    encrypted = await asyncio.to_thread(
                        encrypt_remote_snapshot,
                        photo,
                        settings,
                        library_id,
                        remote.source_key,
                        revision,
                    )
                    async with SessionLocal() as session:
                        await assert_lease(session, lock_key, lock_owner, token)
                        await assert_job_fences(session, fences)
                        current_library = await session.get(Library, library_id)
                        assert current_library is not None
                        previous_asset = await session.scalar(
                            select(Asset).where(
                                Asset.library_id == library_id,
                                Asset.source_asset_key == remote.source_key,
                            )
                        )
                        existing = previous_asset.id if previous_asset else None
                        already_seen = bool(
                            previous_asset
                            and previous_asset.source_metadata.get("scan_token")
                            == str(scan_id)
                        )
                        asset, created = await _upsert_asset(
                            session,
                            current_library,
                            source_key=remote.source_key,
                            filename=remote.filename,
                            revision=revision,
                            metadata=source,
                            size=remote.original_size,
                            media_type=remote.media_type,
                            captured_at=remote.captured_at,
                            added_at=remote.added_at,
                            batch_id=batch_id,
                            enqueue=False,
                            catalog_limit=settings.catalog_asset_limit,
                        )
                        if remote.dimensions:
                            asset.width, asset.height = remote.dimensions
                        manifest = await session.scalar(
                            select(DiscoveryManifest)
                            .where(
                                DiscoveryManifest.library_id == library_id,
                                DiscoveryManifest.source_key == remote.source_key,
                                DiscoveryManifest.content_revision == revision,
                            )
                            .with_for_update()
                        )
                        if manifest is None:
                            manifest = DiscoveryManifest(
                                id=uuid4(),
                                scan_id=scan_id,
                                library_id=library_id,
                                asset_id=asset.id,
                                source_key=remote.source_key,
                                content_revision=revision,
                                maximum_attempts=settings.ingestion_maximum_attempts,
                            )
                            session.add(manifest)
                        manifest.scan_id = scan_id
                        manifest.snapshot = {
                            **(manifest.snapshot or {}),
                            "metadata": public_snapshot,
                            "encrypted": encrypted,
                        }
                        already_completed = asset.ingestion_status == "completed"
                        if already_completed:
                            manifest.status = "completed"
                            skipped += 1
                            await record_batch_skip(
                                session, asset.id, revision, batch_id
                            )
                        elif remote.media_type == "video":
                            asset.ingestion_status = "completed"
                            manifest.status = "completed"
                        elif remote.version is None or (
                            remote.representation_size is not None
                            and remote.representation_size > settings.max_download_bytes
                        ):
                            manifest.status = asset.ingestion_status = "quarantined"
                            manifest.failure_category = "invalid_representation"
                            manifest.last_error = "INVALID_REPRESENTATION"
                            asset.last_error = "INVALID_REPRESENTATION"
                            failed += 1
                        elif manifest.status not in {
                            "quarantined",
                            "failed",
                            "downloading",
                            "downloaded",
                            "processing",
                        }:
                            allowed = await _reserve_download(
                                session,
                                settings,
                                manifest,
                                remote.representation_size or 0,
                                batch_id,
                                job_id,
                                run_id,
                            )
                            if not allowed:
                                manifest.status = asset.ingestion_status = "quarantined"
                                manifest.failure_category = "invalid_representation"
                                manifest.last_error = asset.last_error = (
                                    "DOWNLOAD_BUDGET_EXCEEDED"
                                )
                                failed += 1
                            else:
                                manifest.status = asset.ingestion_status = "queued"
                            if allowed:
                                work = await enqueue_job(
                                    session,
                                    "media_download",
                                    asset.id,
                                    {
                                        "content_revision": revision,
                                        "manifest_id": str(manifest.id),
                                    },
                                    f"media_download:{asset.id}:{revision}",
                                    batch_id,
                                )
                                work.maximum_attempts = (
                                    settings.ingestion_maximum_attempts
                                )
                        # Snapshot metadata is non-secret and independently revisioned.
                        known_snapshot = await session.scalar(
                            select(MetadataSnapshot.asset_id)
                            .where(
                                MetadataSnapshot.asset_id == asset.id,
                                MetadataSnapshot.source == "icloud",
                                MetadataSnapshot.revision_hash
                                == source["metadata_revision"],
                            )
                            .limit(1)
                        )
                        if known_snapshot is None:
                            session.add(
                                MetadataSnapshot(
                                    asset_id=asset.id,
                                    source="icloud",
                                    revision_hash=source["metadata_revision"],
                                    payload=public_snapshot,
                                )
                            )
                        for size_name, byte_size in remote.live_resources:
                            await session.execute(
                                insert(AssetResource)
                                .values(
                                    id=uuid4(),
                                    asset_id=asset.id,
                                    resource_type=f"source_live_video_{size_name}",
                                    revision=revision,
                                    source_identifier=f"{remote.source_key}:{size_name}",
                                    byte_size=byte_size,
                                    mime_type="video/quicktime",
                                    status="catalog_only",
                                )
                                .on_conflict_do_nothing(
                                    index_elements=[
                                        AssetResource.asset_id,
                                        AssetResource.resource_type,
                                        AssetResource.revision,
                                    ]
                                )
                            )
                        offset += 1
                        discovered += 1
                        imported += int(created)
                        anchor_ids.append(remote.source_key)
                        cursor = {
                            **cursor,
                            "offset": offset,
                            "anchors": list(anchor_ids),
                            "cursor_kind": "rank_with_verified_anchors",
                            "manifest_version": MANIFEST_VERSION,
                        }
                        current_scan = await session.get(DiscoveryScan, scan_id)
                        assert current_scan is not None
                        current_scan.source_cursor = cursor
                        current_scan.seen_count += int(not already_seen)
                        current_scan.status = "discovering"
                        current_run = await session.get(IngestionRun, run_id)
                        assert current_run is not None
                        current_run.discovered = discovered
                        current_run.imported = imported
                        current_run.skipped = skipped
                        current_run.failed = failed
                        if job_id:
                            current_job = await session.get(Job, job_id)
                            assert current_job is not None
                            current_job.payload = {
                                **current_job.payload,
                                "discovery_progress": {
                                    "discovered": previous_count + discovered,
                                    "scan_id": str(scan_id),
                                    "offset": offset,
                                },
                            }
                        if not await renew_lease(
                            session, lock_key, lock_owner, token, lease_seconds
                        ):
                            raise LeaseLost("Discovery lease expired")
                        await session.commit()
                        consecutive_known = consecutive_known + 1 if existing else 0
                        if (
                            mode == "incremental"
                            and consecutive_known >= settings.incremental_overlap_assets
                        ):
                            break
        async with SessionLocal() as session:
            await assert_lease(session, lock_key, lock_owner, token)
            await assert_job_fences(session, fences)
            current_scan = await session.get(DiscoveryScan, scan_id)
            current_run = await session.get(IngestionRun, run_id)
            final_library = await session.get(Library, library_id)
            assert current_scan and current_run and final_library
            current_scan.status = (
                "completed" if exhausted or mode == "incremental" else "discovering"
            )
            current_run.status, current_run.finished_at = "completed", utcnow()
            current_run.full_scan = exhausted
            final_library.last_successful_scan = utcnow()
            final_library.configuration = {
                **final_library.configuration,
                "scan_offset": cursor.get("offset", 0),
                "scan_token": str(scan_id),
            }
            if exhausted and mode in {"backfill", "reconciliation"}:
                # A whole manifest pass, never one failed scan, may mark candidates.
                # No object or source asset is deleted, including confirmed missing.
                await session.execute(
                    update(Asset)
                    .where(
                        Asset.library_id == library_id,
                        Asset.source_metadata["scan_token"].as_string() != str(scan_id),
                        Asset.visibility_status.not_in(("archived", "unavailable")),
                    )
                    .values(
                        missing_scan_count=Asset.missing_scan_count + 1,
                        visibility_status="missing_candidate",
                    )
                )
                await session.execute(
                    update(Asset)
                    .where(
                        Asset.library_id == library_id,
                        Asset.visibility_status == "missing_candidate",
                        Asset.missing_scan_count >= settings.reconcile_missing_scans,
                    )
                    .values(visibility_status="confirmed_missing")
                )
            next_job = await _chain_backfill(
                session, settings, parent_payload, current_scan, batch_id, exhausted
            )
            await session.commit()
    except BaseException as exc:
        # This scan can already belong to a newer execution after lease expiry.
        # The failure path needs the same ownership check as a successful commit.
        with suppress(LeaseLost):
            async with SessionLocal() as session:
                await assert_lease(session, lock_key, lock_owner, token)
                await assert_job_fences(session, fences)
                await session.execute(
                    update(DiscoveryScan)
                    .where(DiscoveryScan.id == scan_id)
                    .values(
                        status="interrupted",
                        last_error=str(exc.code)[:64]
                        if isinstance(exc, AppError)
                        else type(exc).__name__[:64],
                    )
                )
                await session.execute(
                    update(IngestionRun)
                    .where(IngestionRun.id == run_id)
                    .values(status="failed", finished_at=utcnow())
                )
                await session.commit()
        raise
    finally:
        async with SessionLocal() as session:
            await release_lease(session, lock_key, lock_owner, token)
            await session.commit()
    return {
        "run_id": str(run_id),
        "scan_id": str(scan_id),
        "discovered": discovered,
        "imported": imported,
        "skipped": skipped,
        "failed": failed,
        "bytes_transferred": 0,
        "full_rotation_completed": exhausted,
        "next_offset": cursor.get("offset", 0),
        "execution_limit": execution_limit,
        "downloads_queued_independently": True,
        "next_backfill_job_id": str(next_job) if next_job else None,
        "authorized_job_discovered": previous_count + discovered,
    }


async def download_discovered_asset(
    asset_id: UUID,
    settings: Settings,
    job_id: UUID | None = None,
    owner: str | None = None,
    fence_token: int | None = None,
) -> dict[str, Any]:
    """One media failure never aborts other discoveries or completed assets."""
    fences = _fences(job_id, owner, fence_token)
    async with SessionLocal() as session:
        await assert_job_fences(session, fences)
        asset = await session.get(Asset, asset_id)
        if asset is None:
            raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
        revision, library_id, source_key = (
            asset.content_revision,
            asset.library_id,
            asset.source_asset_key,
        )
        manifest = await session.scalar(
            select(DiscoveryManifest)
            .where(
                DiscoveryManifest.asset_id == asset_id,
                DiscoveryManifest.content_revision == revision,
            )
            .with_for_update()
        )
        if manifest is None:
            raise AppError(
                ErrorCode.MEDIA_DOWNLOAD_FAILED, "Manifesto ausente; refaça descoberta"
            )
        resource = await session.scalar(
            select(AssetResource).where(
                AssetResource.asset_id == asset_id,
                AssetResource.resource_type == "source_download",
                AssetResource.revision == revision,
                AssetResource.status == "available",
            )
        )
        stored_source = (
            {
                "id": resource.id,
                "object_key": resource.object_key,
                "sha256": resource.sha256,
                "byte_size": resource.byte_size,
            }
            if resource
            else None
        )
        await session.commit()
    if stored_source:
        # A database row cannot establish that an object still exists or retains
        # its bytes. Verify the immutable representation without holding SQL.
        integrity = await asyncio.to_thread(
            _source_integrity,
            stored_source,
            settings.max_download_bytes,
        )
        async with SessionLocal() as session:
            await assert_job_fences(session, fences)
            current = await session.get(Asset, asset_id, with_for_update=True)
            current_source = await session.get(
                AssetResource, stored_source["id"], with_for_update=True
            )
            if (
                current is None
                or current.content_revision != revision
                or current_source is None
                or current_source.status != "available"
                or current_source.object_key != stored_source["object_key"]
                or current_source.sha256 != stored_source["sha256"]
            ):
                raise LeaseLost("Source changed during integrity verification")
            if integrity["valid"]:
                return {"downloaded": True, "reused_durable_source": True}
            current_source.status = "invalid"
            current.source_metadata = {
                **current.source_metadata,
                "last_source_incident": {
                    "code": "PERSISTED_SOURCE_INTEGRITY_FAILED",
                    "detected_at": utcnow().isoformat(),
                    "expected_sha256": stored_source["sha256"],
                    "actual_sha256": integrity.get("sha256"),
                    "actual_bytes": integrity.get("byte_size"),
                },
            }
            await session.execute(
                update(ObjectIntent)
                .where(ObjectIntent.object_key == stored_source["object_key"])
                .values(status="pending", updated_at=utcnow())
            )
            await session.commit()
    async with SessionLocal() as session:
        await assert_job_fences(session, fences)
        asset = await session.get(Asset, asset_id, with_for_update=True)
        if asset is None or asset.content_revision != revision:
            raise LeaseLost("Asset changed before download")
        manifest = await session.scalar(
            select(DiscoveryManifest)
            .where(
                DiscoveryManifest.asset_id == asset_id,
                DiscoveryManifest.content_revision == revision,
            )
            .with_for_update()
        )
        if manifest is None:
            raise LeaseLost("Manifest changed before download")
        if (
            manifest.status in {"quarantined", "failed"}
            or manifest.attempts >= manifest.maximum_attempts
        ):
            raise AppError(
                "INVALID_REPRESENTATION", "Mídia em quarentena; revise antes de tentar"
            )
        manifest.attempts += 1
        manifest.status = asset.ingestion_status = "downloading"
        encrypted = dict(manifest.snapshot.get("encrypted", {}))
        relative = asset.source_metadata.get("cache_relative_path")
        await session.commit()
    root = settings.icloud_download_directory.resolve()
    if not isinstance(relative, str) or not (root / relative).resolve().is_relative_to(
        root
    ):
        raise AppError(ErrorCode.MEDIA_DOWNLOAD_FAILED, "Caminho de cache inválido")
    target = (root / relative).resolve()
    try:
        photo = await asyncio.to_thread(
            decrypt_remote_snapshot, encrypted, settings, library_id, source_key, revision
        )
        async with session_directory(settings) as directory:
            adapter = ICloudAdapter(
                settings.model_copy(update={"icloud_session_directory": directory})
            )
            await asyncio.to_thread(adapter.connect)
            version = await asyncio.to_thread(adapter.representation, photo)
            if version is None:
                raise AppError(
                    "INVALID_REPRESENTATION", "Representação solicitada indisponível"
                )
            transferred = await asyncio.to_thread(
                adapter.download, photo, version, target
            )
        digest = await asyncio.to_thread(fixture_content_hash, target)
        data = await asyncio.to_thread(target.read_bytes)
        if len(data) > settings.max_download_bytes or sha256(data).hexdigest() != digest:
            raise AppError(
                ErrorCode.MEDIA_DOWNLOAD_FAILED, "Cache alterado durante leitura"
            )
        object_key = (
            f"sources/{asset_id}/{sha256(revision.encode()).hexdigest()}/{digest}.image"
        )
        intent_id = uuid4()
        async with SessionLocal() as session:
            await assert_job_fences(session, fences)
            current = await session.get(Asset, asset_id, with_for_update=True)
            if current is None or current.content_revision != revision:
                raise LeaseLost("Asset changed during download")
            await session.execute(
                insert(ObjectIntent)
                .values(
                    id=intent_id,
                    job_id=job_id,
                    asset_id=asset_id,
                    content_revision=revision,
                    representation_revision=revision,
                    object_key=object_key,
                    sha256=digest,
                    mime_type="application/octet-stream",
                    byte_size=len(data),
                    owner=owner or "standalone-download",
                    fence_token=fence_token or 0,
                    status="pending",
                )
                .on_conflict_do_nothing(index_elements=[ObjectIntent.object_key])
            )
            await session.commit()
        # Immutable source survives a Cloud Run cold start. An interrupted upload
        # remains a durable intent for maintenance reconciliation.
        try:
            await asyncio.to_thread(
                get_storage().put, object_key, data, "application/octet-stream"
            )
        except Exception:
            raise AppError(
                ErrorCode.R2_UPLOAD_FAILED,
                "Falha ao preservar representação privada",
                503,
            ) from None
        async with SessionLocal() as session:
            await assert_job_fences(session, fences)
            current = await session.get(Asset, asset_id, with_for_update=True)
            if current is None or current.content_revision != revision:
                raise LeaseLost("Asset changed after upload")
            await session.execute(
                insert(AssetResource)
                .values(
                    id=uuid4(),
                    asset_id=asset_id,
                    resource_type="source_download",
                    revision=revision,
                    object_key=object_key,
                    sha256=digest,
                    byte_size=len(data),
                    mime_type="application/octet-stream",
                    status="available",
                )
                .on_conflict_do_update(
                    index_elements=[
                        AssetResource.asset_id,
                        AssetResource.resource_type,
                        AssetResource.revision,
                    ],
                    set_={
                        "object_key": object_key,
                        "sha256": digest,
                        "byte_size": len(data),
                        "status": "available",
                    },
                )
            )
            await session.execute(
                update(ObjectIntent)
                .where(ObjectIntent.object_key == object_key)
                .values(status="committed", updated_at=utcnow())
            )
            await session.execute(
                update(DiscoveryManifest)
                .where(
                    DiscoveryManifest.asset_id == asset_id,
                    DiscoveryManifest.content_revision == revision,
                )
                .values(status="downloaded", failure_category=None, last_error=None)
            )
            current.ingestion_status, current.last_error = "downloaded", None
            cache_incident = getattr(adapter, "last_cache_incident", None)
            if cache_incident:
                current.source_metadata = {
                    **current.source_metadata,
                    "last_cache_incident": cache_incident,
                }
            await session.commit()
        return {"downloaded": True, "bytes_transferred": transferred, "sha256": digest}
    except BaseException as exc:
        if not isinstance(exc, (asyncio.CancelledError, LeaseLost)):
            code = (
                exc.code if isinstance(exc, AppError) else ErrorCode.MEDIA_DOWNLOAD_FAILED
            )
            with suppress(Exception):
                await record_asset_failure(
                    asset_id,
                    str(code),
                    "retrying",
                    expected_revision=revision,
                    job_fences=fences,
                )
        raise


def _source_integrity(source: dict[str, Any], maximum_bytes: int) -> dict[str, Any]:
    """Hash a bounded private stream; provider outages do not invalidate content."""
    key = source.get("object_key")
    if not isinstance(key, str):
        return {"valid": False}
    try:
        stream = get_storage().open_stream(key)
    except AppError as exc:
        if exc.code == ErrorCode.NOT_FOUND or exc.status_code == 416:
            return {"valid": False}
        raise
    digest, size = sha256(), 0
    try:
        for chunk in stream.chunks():
            size += len(chunk)
            if size > maximum_bytes:
                return {"valid": False, "byte_size": size}
            digest.update(chunk)
    finally:
        stream.close()
    actual = digest.hexdigest()
    return {
        "valid": size == source.get("byte_size") and actual == source.get("sha256"),
        "sha256": actual,
        "byte_size": size,
    }
