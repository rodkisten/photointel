"""Durable catalog schema. UUID identity is independent from Apple identifiers."""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from photointel.database import Base

JSON_TYPE = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    from datetime import UTC

    return datetime.now(UTC)


class Identifier:
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
    )


class Library(Identifier, Timestamps, Base):
    __tablename__ = "libraries"
    source_type: Mapped[str] = mapped_column(String(32), default="icloud")
    source_identifier: Mapped[str] = mapped_column(String(512))
    name: Mapped[str] = mapped_column(String(255))
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    last_successful_scan: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_attempted_scan: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("source_type", "source_identifier"),)


class Asset(Identifier, Timestamps, Base):
    __tablename__ = "assets"
    library_id: Mapped[UUID] = mapped_column(ForeignKey("libraries.id"), index=True)
    source_asset_key: Mapped[str] = mapped_column(String(512))
    source_account: Mapped[str | None] = mapped_column(String(255))
    source_metadata: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    media_type: Mapped[str] = mapped_column(String(32), default="image")
    filename: Mapped[str] = mapped_column(String(1024))
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    added_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    duration: Mapped[float | None] = mapped_column(Float)
    filesize: Mapped[int | None] = mapped_column(BigInteger)
    content_revision: Mapped[str] = mapped_column(String(128), default="1")
    representation_revision: Mapped[str] = mapped_column(String(128), default="1")
    ingestion_status: Mapped[str] = mapped_column(String(32), default="pending")
    classification_status: Mapped[str] = mapped_column(String(32), default="pending")
    visibility_status: Mapped[str] = mapped_column(String(32), default="active")
    last_successful_inference: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    missing_scan_count: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    phash: Mapped[str | None] = mapped_column(String(32), index=True)
    quality: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    search_document: Mapped[str | None] = mapped_column(
        Text().with_variant(TSVECTOR(), "postgresql")
    )
    __table_args__ = (
        UniqueConstraint("library_id", "source_asset_key"),
        CheckConstraint(
            "visibility_status IN ('active','unavailable',"
            "'missing_candidate','confirmed_missing','archived')"
        ),
        CheckConstraint("width IS NULL OR width > 0"),
        CheckConstraint("height IS NULL OR height > 0"),
        CheckConstraint("filesize IS NULL OR filesize >= 0"),
        CheckConstraint("missing_scan_count >= 0", name="ck_asset_missing_scan_count"),
        Index("ix_assets_capture_cursor", "captured_at", "id"),
        Index("ix_assets_created_cursor", "created_at", "id"),
        Index("ix_assets_library_status", "library_id", "visibility_status"),
        Index("ix_assets_media_dimensions", "media_type", "width", "height"),
        Index("ix_assets_search_document", "search_document", postgresql_using="gin"),
        Index(
            "ix_assets_filename_trgm",
            "filename",
            postgresql_using="gin",
            postgresql_ops={"filename": "gin_trgm_ops"},
        ),
        Index(
            "ix_assets_source_metadata_gin",
            "source_metadata",
            postgresql_using="gin",
            postgresql_ops={"source_metadata": "jsonb_path_ops"},
        ),
        Index(
            "ix_assets_gallery_cursor",
            text(
                "(coalesce(captured_at, created_at, '1970-01-01 UTC'::timestamptz)) DESC"
            ),
            "id",
            postgresql_where=text("visibility_status <> 'archived'"),
        ),
        Index(
            "ix_assets_added_cursor",
            text("(coalesce(added_at, created_at, '1970-01-01 UTC'::timestamptz)) DESC"),
            "id",
            postgresql_where=text("visibility_status <> 'archived'"),
        ),
    )


class AssetResource(Identifier, Base):
    __tablename__ = "asset_resources"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    resource_type: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str | None] = mapped_column(String(1024))
    source_identifier: Mapped[str | None] = mapped_column(String(512))
    mime_type: Mapped[str | None] = mapped_column(String(128))
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    revision: Mapped[str] = mapped_column(String(128), default="1")
    status: Mapped[str] = mapped_column(String(32), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("asset_id", "resource_type", "revision"),
        CheckConstraint(
            "byte_size IS NULL OR byte_size >= 0", name="ck_resource_byte_size"
        ),
    )


class AssetMetadata(Base):
    __tablename__ = "asset_metadata"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), primary_key=True)
    orientation: Mapped[int | None] = mapped_column(Integer)
    camera: Mapped[str | None] = mapped_column(String(255))
    lens: Mapped[str | None] = mapped_column(String(255))
    exposure: Mapped[str | None] = mapped_column(String(64))
    iso: Mapped[int | None] = mapped_column(Integer)
    aperture: Mapped[float | None] = mapped_column(Float)
    focal_length: Mapped[float | None] = mapped_column(Float)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    timezone: Mapped[str | None] = mapped_column(String(64))
    original_filename: Mapped[str | None] = mapped_column(String(1024))
    additional_metadata: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)


class Tag(Identifier, Base):
    __tablename__ = "tags"
    canonical_key: Mapped[str] = mapped_column(String(255), unique=True)
    display_name: Mapped[str] = mapped_column(String(255))
    category: Mapped[str] = mapped_column(String(64), default="other", index=True)
    subcategory: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    minimum_confidence: Mapped[float] = mapped_column(Float, default=0.4)
    parent_id: Mapped[UUID | None] = mapped_column(ForeignKey("tags.id"))
    merged_into_id: Mapped[UUID | None] = mapped_column(ForeignKey("tags.id"))
    sync_eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        CheckConstraint("minimum_confidence >= 0 AND minimum_confidence <= 1"),
        Index(
            "ix_tags_name_trgm",
            "display_name",
            postgresql_using="gin",
            postgresql_ops={"display_name": "gin_trgm_ops"},
        ),
    )


class TagAlias(Identifier, Base):
    __tablename__ = "tag_aliases"
    tag_id: Mapped[UUID] = mapped_column(ForeignKey("tags.id"), index=True)
    language: Mapped[str] = mapped_column(String(16), default="pt-BR")
    alias: Mapped[str] = mapped_column(String(255))
    alias_type: Mapped[str] = mapped_column(String(32), default="display")
    __table_args__ = (UniqueConstraint("tag_id", "language", "alias"),)


class AssetTag(Identifier, Timestamps, Base):
    __tablename__ = "asset_tags"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    tag_id: Mapped[UUID] = mapped_column(ForeignKey("tags.id"), index=True)
    origin: Mapped[str] = mapped_column(String(32))
    confidence: Mapped[float | None] = mapped_column(Float)
    model_version: Mapped[str] = mapped_column(String(128), default="")
    user_status: Mapped[str] = mapped_column(String(32), default="unreviewed")
    review_status: Mapped[str] = mapped_column(String(32), default="pending")
    __table_args__ = (
        UniqueConstraint("asset_id", "tag_id", "origin", "model_version"),
        CheckConstraint("origin IN ('apple','joytag','user','import','external')"),
        CheckConstraint("confidence IS NULL OR (confidence >= 0 AND confidence <= 1)"),
        CheckConstraint(
            "user_status IN ('unreviewed', 'approved', 'rejected')",
            name="ck_asset_tag_user_status",
        ),
        Index("ix_asset_tags_filter", "tag_id", "origin", "confidence", "asset_id"),
    )


class ModelRegistry(Identifier, Base):
    __tablename__ = "model_registry"
    provider: Mapped[str] = mapped_column(String(64))
    model_name: Mapped[str] = mapped_column(String(255))
    revision: Mapped[str] = mapped_column(String(128))
    architecture: Mapped[str] = mapped_column(String(128))
    embedding_dimension: Mapped[int | None] = mapped_column(Integer)
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    capabilities: Mapped[list[str]] = mapped_column(JSON_TYPE, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (
        UniqueConstraint("provider", "model_name", "revision"),
        CheckConstraint(
            "embedding_dimension IS NULL OR embedding_dimension = 768",
            name="ck_embedding_dimension_model",
        ),
        Index(
            "uq_active_model_revision",
            "provider",
            "model_name",
            unique=True,
            postgresql_where=text("active"),
        ),
    )


class InferenceRun(Identifier, Base):
    __tablename__ = "inference_runs"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    model_id: Mapped[UUID] = mapped_column(ForeignKey("model_registry.id"))
    input_revision: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    runtime_ms: Mapped[float | None] = mapped_column(Float)
    error: Mapped[str | None] = mapped_column(Text)
    raw_predictions: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("asset_id", "model_id", "input_revision"),)


class Embedding(Identifier, Base):
    __tablename__ = "embeddings"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    model_id: Mapped[UUID] = mapped_column(ForeignKey("model_registry.id"), index=True)
    input_revision: Mapped[str] = mapped_column(String(128))
    vector: Mapped[Any] = mapped_column(Vector(768))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("asset_id", "model_id", "input_revision"),
        Index(
            "ix_embeddings_cosine_hnsw",
            "vector",
            postgresql_using="hnsw",
            postgresql_ops={"vector": "vector_cosine_ops"},
            postgresql_with={"m": 16, "ef_construction": 64},
        ),
    )


class JobBatch(Identifier, Timestamps, Base):
    __tablename__ = "job_batches"
    name: Mapped[str] = mapped_column(String(255), default="Processing")
    status: Mapped[str] = mapped_column(String(32), default="queued")
    total_assets: Mapped[int] = mapped_column(Integer, default=0)
    completed: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    counters: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    estimated_cost: Mapped[float] = mapped_column(Float, default=0)


class Job(Identifier, Base):
    __tablename__ = "jobs"
    job_type: Mapped[str] = mapped_column(String(64))
    asset_id: Mapped[UUID | None] = mapped_column(ForeignKey("assets.id"), index=True)
    batch_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("job_batches.id"), index=True
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    fence_token: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    maximum_attempts: Mapped[int] = mapped_column(Integer, default=3)
    scheduled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_id: Mapped[str | None] = mapped_column(String(128))
    progress: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_details: Mapped[dict[str, Any] | None] = mapped_column(JSON_TYPE)
    idempotency_key: Mapped[str] = mapped_column(String(512), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','preparing','running','retrying','paused',"
            "'completed','failed','cancelled')"
        ),
        CheckConstraint("attempts >= 0 AND maximum_attempts > 0"),
        Index("ix_jobs_claim", "status", "scheduled_at", "priority", "created_at"),
        Index("ix_jobs_stale", "status", "lease_until"),
        Index(
            "ix_jobs_live_claim",
            text("priority DESC"),
            "scheduled_at",
            "created_at",
            postgresql_where=text("status IN ('queued', 'retrying')"),
        ),
    )


class JobEvent(Base):
    __tablename__ = "job_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    job_id: Mapped[UUID] = mapped_column(ForeignKey("jobs.id"), index=True)
    status: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WorkerState(Base):
    __tablename__ = "worker_states"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    current_job_id: Mapped[UUID | None] = mapped_column(ForeignKey("jobs.id"))
    status: Mapped[str] = mapped_column(String(32), default="idle")
    capabilities: Mapped[list[str]] = mapped_column(JSON_TYPE, default=list)


class IngestionRun(Identifier, Base):
    __tablename__ = "ingestion_runs"
    library_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("libraries.id"), index=True
    )
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("jobs.id"))
    status: Mapped[str] = mapped_column(String(32), default="running")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    discovered: Mapped[int] = mapped_column(Integer, default=0)
    imported: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    bytes_transferred: Mapped[int] = mapped_column(BigInteger, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    full_scan: Mapped[bool] = mapped_column(Boolean, default=False)


class BridgeDevice(Identifier, Base):
    __tablename__ = "bridge_devices"
    name: Mapped[str] = mapped_column(String(255))
    credential_hash: Mapped[str] = mapped_column(String(128), unique=True)
    key_fingerprint: Mapped[str] = mapped_column(String(128))
    capabilities: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    enrolled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    write_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_asset_id: Mapped[UUID | None] = mapped_column(ForeignKey("assets.id"))


class DeviceMapping(Identifier, Base):
    __tablename__ = "device_mappings"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    device_id: Mapped[UUID] = mapped_column(ForeignKey("bridge_devices.id"), index=True)
    local_identifier: Mapped[str] = mapped_column(String(512))
    cloud_identifier: Mapped[str | None] = mapped_column(String(512))
    confidence: Mapped[float] = mapped_column(Float, default=0)
    verification_status: Mapped[str] = mapped_column(String(32), default="unverified")
    match_method: Mapped[str] = mapped_column(String(64), default="manual")
    mapping_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSON_TYPE, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("device_id", "asset_id", "local_identifier"),
        CheckConstraint("confidence >= 0 AND confidence <= 1"),
        Index("ix_device_mappings_target", "device_id", "local_identifier"),
        Index(
            "ix_device_mappings_asset_verification",
            "device_id",
            "asset_id",
            "verification_status",
        ),
        Index(
            "uq_verified_device_target",
            "device_id",
            "local_identifier",
            unique=True,
            postgresql_where=text("verification_status = 'verified'"),
        ),
    )


class MetadataSnapshot(Identifier, Base):
    __tablename__ = "metadata_snapshots"
    asset_id: Mapped[UUID | None] = mapped_column(ForeignKey("assets.id"), index=True)
    device_id: Mapped[UUID | None] = mapped_column(ForeignKey("bridge_devices.id"))
    source: Mapped[str] = mapped_column(String(64))
    revision_hash: Mapped[str] = mapped_column(String(128))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        Index("ix_metadata_snapshot_asset_source", "asset_id", "source", "created_at"),
        Index(
            "ix_photokit_snapshot_device_local",
            "device_id",
            text("(payload ->> 'local_identifier')"),
            text("created_at DESC"),
            postgresql_where=text("source = 'photokit'"),
        ),
    )


class SyncOperation(Identifier, Base):
    __tablename__ = "sync_operations"
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    target_device_id: Mapped[UUID] = mapped_column(
        ForeignKey("bridge_devices.id"), index=True
    )
    operation_type: Mapped[str] = mapped_column(String(64), default="keywords_delta")
    desired_revision: Mapped[str] = mapped_column(String(128))
    expected_revision: Mapped[str] = mapped_column(String(128))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    status: Mapped[str] = mapped_column(String(64), default="awaiting_approval")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    idempotency_key: Mapped[str] = mapped_column(String(512), unique=True)
    last_error: Mapped[str | None] = mapped_column(Text)
    approved_by: Mapped[str | None] = mapped_column(String(255))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','claimed','mapping_required',"
            "'awaiting_approval','processing','applied_on_device',"
            "'awaiting_cloud_confirmation','completed','conflict','failed',"
            "'cancelled')"
        ),
        Index("ix_sync_operations_claim", "target_device_id", "status", "lease_until"),
        CheckConstraint("attempts >= 0", name="ck_sync_attempts"),
    )


class AuditEvent(Identifier, Base):
    __tablename__ = "audit_events"
    actor: Mapped[str] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(128), index=True)
    asset_id: Mapped[UUID | None] = mapped_column(ForeignKey("assets.id"), index=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    correlation_id: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )


class Album(Identifier, Timestamps, Base):
    __tablename__ = "albums"
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    cover_asset_id: Mapped[UUID | None] = mapped_column(ForeignKey("assets.id"))
    sort_order: Mapped[str] = mapped_column(String(32), default="captured_desc")


class AlbumAsset(Base):
    __tablename__ = "album_assets"
    album_id: Mapped[UUID] = mapped_column(
        ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True
    )
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    position: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (Index("ix_album_assets_asset", "asset_id"),)


class DuplicateGroup(Identifier, Base):
    __tablename__ = "duplicate_groups"
    duplicate_type: Mapped[str] = mapped_column(String(32), default="exact")
    group_key: Mapped[str] = mapped_column(String(512), unique=True)
    representative_asset_id: Mapped[UUID | None] = mapped_column(ForeignKey("assets.id"))
    algorithm: Mapped[str] = mapped_column(String(64), default="sha256")
    threshold: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DuplicateMember(Base):
    __tablename__ = "duplicate_members"
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("duplicate_groups.id", ondelete="CASCADE"), primary_key=True
    )
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), primary_key=True)
    similarity: Mapped[float] = mapped_column(Float, default=1)
    quality_rank: Mapped[int | None] = mapped_column(Integer)
    __table_args__ = (Index("ix_duplicate_members_asset", "asset_id"),)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON_TYPE)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class SavedSearch(Identifier, Timestamps, Base):
    __tablename__ = "saved_searches"
    name: Mapped[str] = mapped_column(String(255))
    query: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE)


class DurableLease(Base):
    __tablename__ = "durable_leases"
    key: Mapped[str] = mapped_column(String(512), primary_key=True)
    owner: Mapped[str | None] = mapped_column(String(128))
    fence_token: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ObjectIntent(Identifier, Timestamps, Base):
    __tablename__ = "object_intents"
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("jobs.id"))
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    content_revision: Mapped[str] = mapped_column(String(128))
    representation_revision: Mapped[str] = mapped_column(String(128))
    object_key: Mapped[str] = mapped_column(String(1024), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    mime_type: Mapped[str] = mapped_column(String(128))
    byte_size: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    owner: Mapped[str] = mapped_column(String(128))
    fence_token: Mapped[int] = mapped_column(Integer)
    __table_args__ = (Index("ix_object_intents_recovery", "status", "updated_at"),)


class SessionState(Base):
    __tablename__ = "icloud_session_states"
    scope_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    generation: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    object_key: Mapped[str | None] = mapped_column(String(1024))
    ciphertext_sha256: Mapped[str | None] = mapped_column(String(64))
    key_id: Mapped[str | None] = mapped_column(String(64))
    lease_owner: Mapped[UUID | None] = mapped_column()
    lease_token: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )
    last_error: Mapped[str | None] = mapped_column(String(64))


class QueryEmbeddingCache(Base):
    __tablename__ = "query_embedding_cache"
    cache_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    model_id: Mapped[UUID] = mapped_column(ForeignKey("model_registry.id"))
    model_revision: Mapped[str] = mapped_column(String(128))
    preprocessing_revision: Mapped[str] = mapped_column(String(128))
    vector: Mapped[list[float] | None] = mapped_column(Vector(768))
    status: Mapped[str] = mapped_column(String(16), default="generating")
    owner_token: Mapped[UUID | None] = mapped_column()
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    hit_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("status IN ('generating','ready')", name="ck_query_cache_status"),
    )


class DiscoveryScan(Identifier, Timestamps, Base):
    __tablename__ = "discovery_scans"
    library_id: Mapped[UUID] = mapped_column(ForeignKey("libraries.id"), index=True)
    mode: Mapped[str] = mapped_column(String(32), default="incremental")
    status: Mapped[str] = mapped_column(String(32), default="discovering")
    source_cursor: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    seen_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(64))


class DiscoveryManifest(Identifier, Timestamps, Base):
    __tablename__ = "discovery_manifests"
    scan_id: Mapped[UUID] = mapped_column(ForeignKey("discovery_scans.id"), index=True)
    library_id: Mapped[UUID] = mapped_column(ForeignKey("libraries.id"))
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("assets.id"), index=True)
    source_key: Mapped[str] = mapped_column(String(512))
    content_revision: Mapped[str] = mapped_column(String(128))
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON_TYPE, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="discovered")
    failure_category: Mapped[str | None] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    maximum_attempts: Mapped[int] = mapped_column(Integer, default=5)
    last_error: Mapped[str | None] = mapped_column(String(64))
    __table_args__ = (
        UniqueConstraint("library_id", "source_key", "content_revision"),
        Index("ix_discovery_manifest_status", "status", "updated_at", "id"),
    )


class VerificationGate(Base):
    __tablename__ = "verification_gates"
    id: Mapped[str] = mapped_column(String(1), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), default="not_verified")
    release_sha: Mapped[str | None] = mapped_column(String(64))
    evidence: Mapped[list[str]] = mapped_column(JSON_TYPE, default=list)
    notes: Mapped[str | None] = mapped_column(String(2000))
    verified_by: Mapped[str | None] = mapped_column(String(255))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DispatchOutbox(Identifier, Timestamps, Base):
    __tablename__ = "dispatch_outbox"
    job_name: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(512), unique=True)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    owner: Mapped[str | None] = mapped_column(String(128))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(64))
