"""Initial durable catalog schema, frozen independently from application ORM.

Revision ID: 0001_catalog
Revises: None
"""

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision = "0001_catalog"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "libraries",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("source_type", sa.String(32), nullable=False),
        sa.Column("source_identifier", sa.String(512), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("configuration", postgresql.JSONB(), nullable=False),
        sa.Column("last_successful_scan", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_attempted_scan", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("source_type", "source_identifier"),
    )
    op.create_table(
        "assets",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("library_id", sa.Uuid(), sa.ForeignKey("libraries.id"), nullable=False),
        sa.Column("source_asset_key", sa.String(512), nullable=False),
        sa.Column("source_account", sa.String(255), nullable=True),
        sa.Column("source_metadata", postgresql.JSONB(), nullable=False),
        sa.Column("media_type", sa.String(32), nullable=False),
        sa.Column("filename", sa.String(1024), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("width", sa.Integer, nullable=True),
        sa.Column("height", sa.Integer, nullable=True),
        sa.Column("duration", sa.Float, nullable=True),
        sa.Column("filesize", sa.BigInteger, nullable=True),
        sa.Column("content_revision", sa.String(128), nullable=False),
        sa.Column("representation_revision", sa.String(128), nullable=False),
        sa.Column("ingestion_status", sa.String(32), nullable=False),
        sa.Column("classification_status", sa.String(32), nullable=False),
        sa.Column("visibility_status", sa.String(32), nullable=False),
        sa.Column("last_successful_inference", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("missing_scan_count", sa.Integer, nullable=False),
        sa.Column("sha256", sa.String(64), nullable=True),
        sa.Column("phash", sa.String(32), nullable=True),
        sa.Column("quality", postgresql.JSONB(), nullable=False),
        sa.Column(
            "search_document",
            sa.Text().with_variant(postgresql.TSVECTOR(), "postgresql"),
            nullable=True,
        ),
        sa.UniqueConstraint("library_id", "source_asset_key"),
        sa.CheckConstraint(
            "visibility_status IN ('active','unavailable','missing_candidate',"
            "'confirmed_missing','archived')"
        ),
        sa.CheckConstraint("width IS NULL OR width > 0"),
        sa.CheckConstraint("height IS NULL OR height > 0"),
        sa.CheckConstraint("filesize IS NULL OR filesize >= 0"),
    )
    op.create_table(
        "asset_resources",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column("resource_type", sa.String(64), nullable=False),
        sa.Column("object_key", sa.String(1024), nullable=True),
        sa.Column("source_identifier", sa.String(512), nullable=True),
        sa.Column("mime_type", sa.String(128), nullable=True),
        sa.Column("byte_size", sa.BigInteger, nullable=True),
        sa.Column("width", sa.Integer, nullable=True),
        sa.Column("height", sa.Integer, nullable=True),
        sa.Column("sha256", sa.String(64), nullable=True),
        sa.Column("revision", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("asset_id", "resource_type", "revision"),
    )
    op.create_table(
        "asset_metadata",
        sa.Column(
            "asset_id",
            sa.Uuid(),
            sa.ForeignKey("assets.id"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("orientation", sa.Integer, nullable=True),
        sa.Column("camera", sa.String(255), nullable=True),
        sa.Column("lens", sa.String(255), nullable=True),
        sa.Column("exposure", sa.String(64), nullable=True),
        sa.Column("iso", sa.Integer, nullable=True),
        sa.Column("aperture", sa.Float, nullable=True),
        sa.Column("focal_length", sa.Float, nullable=True),
        sa.Column("latitude", sa.Float, nullable=True),
        sa.Column("longitude", sa.Float, nullable=True),
        sa.Column("timezone", sa.String(64), nullable=True),
        sa.Column("original_filename", sa.String(1024), nullable=True),
        sa.Column("additional_metadata", postgresql.JSONB(), nullable=False),
    )
    op.create_table(
        "tags",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("canonical_key", sa.String(255), unique=True, nullable=False),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("category", sa.String(64), nullable=False),
        sa.Column("subcategory", sa.String(64), nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("is_sensitive", sa.Boolean, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("minimum_confidence", sa.Float, nullable=False),
        sa.Column("parent_id", sa.Uuid(), sa.ForeignKey("tags.id"), nullable=True),
        sa.Column("merged_into_id", sa.Uuid(), sa.ForeignKey("tags.id"), nullable=True),
        sa.Column("sync_eligible", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("minimum_confidence >= 0 AND minimum_confidence <= 1"),
    )
    op.create_table(
        "tag_aliases",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("tag_id", sa.Uuid(), sa.ForeignKey("tags.id"), nullable=False),
        sa.Column("language", sa.String(16), nullable=False),
        sa.Column("alias", sa.String(255), nullable=False),
        sa.Column("alias_type", sa.String(32), nullable=False),
        sa.UniqueConstraint("tag_id", "language", "alias"),
    )
    op.create_table(
        "asset_tags",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column("tag_id", sa.Uuid(), sa.ForeignKey("tags.id"), nullable=False),
        sa.Column("origin", sa.String(32), nullable=False),
        sa.Column("confidence", sa.Float, nullable=True),
        sa.Column("model_version", sa.String(128), nullable=False),
        sa.Column("user_status", sa.String(32), nullable=False),
        sa.Column("review_status", sa.String(32), nullable=False),
        sa.UniqueConstraint("asset_id", "tag_id", "origin", "model_version"),
        sa.CheckConstraint("origin IN ('apple','joytag','user','import','external')"),
        sa.CheckConstraint("confidence IS NULL OR (confidence >= 0 AND confidence <= 1)"),
    )
    op.create_table(
        "model_registry",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model_name", sa.String(255), nullable=False),
        sa.Column("revision", sa.String(128), nullable=False),
        sa.Column("architecture", sa.String(128), nullable=False),
        sa.Column("embedding_dimension", sa.Integer, nullable=True),
        sa.Column("parameters", postgresql.JSONB(), nullable=False),
        sa.Column("capabilities", postgresql.JSONB(), nullable=False),
        sa.Column("active", sa.Boolean, nullable=False),
        sa.UniqueConstraint("provider", "model_name", "revision"),
    )
    op.create_table(
        "inference_runs",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column(
            "model_id", sa.Uuid(), sa.ForeignKey("model_registry.id"), nullable=False
        ),
        sa.Column("input_revision", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("runtime_ms", sa.Float, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("raw_predictions", postgresql.JSONB(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("asset_id", "model_id", "input_revision"),
    )
    op.create_table(
        "embeddings",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column(
            "model_id", sa.Uuid(), sa.ForeignKey("model_registry.id"), nullable=False
        ),
        sa.Column("input_revision", sa.String(128), nullable=False),
        sa.Column("vector", Vector(768), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("asset_id", "model_id", "input_revision"),
    )
    op.create_table(
        "job_batches",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("total_assets", sa.Integer, nullable=False),
        sa.Column("completed", sa.Integer, nullable=False),
        sa.Column("failed", sa.Integer, nullable=False),
        sa.Column("skipped", sa.Integer, nullable=False),
        sa.Column("counters", postgresql.JSONB(), nullable=False),
        sa.Column("estimated_cost", sa.Float, nullable=False),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("job_type", sa.String(64), nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column("batch_id", sa.Uuid(), sa.ForeignKey("job_batches.id"), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("priority", sa.Integer, nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("attempts", sa.Integer, nullable=False),
        sa.Column("maximum_attempts", sa.Integer, nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worker_id", sa.String(128), nullable=True),
        sa.Column("progress", postgresql.JSONB(), nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_details", postgresql.JSONB(), nullable=True),
        sa.Column("idempotency_key", sa.String(512), unique=True, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('queued','preparing','running','retrying','paused',"
            "'completed','failed','cancelled')"
        ),
        sa.CheckConstraint("attempts >= 0 AND maximum_attempts > 0"),
    )
    op.create_table(
        "job_events",
        sa.Column(
            "id", sa.BigInteger, primary_key=True, autoincrement=True, nullable=False
        ),
        sa.Column("job_id", sa.Uuid(), sa.ForeignKey("jobs.id"), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "worker_states",
        sa.Column("id", sa.String(128), primary_key=True, nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("current_job_id", sa.Uuid(), sa.ForeignKey("jobs.id"), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("capabilities", postgresql.JSONB(), nullable=False),
    )
    op.create_table(
        "ingestion_runs",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("library_id", sa.Uuid(), sa.ForeignKey("libraries.id"), nullable=True),
        sa.Column("job_id", sa.Uuid(), sa.ForeignKey("jobs.id"), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("discovered", sa.Integer, nullable=False),
        sa.Column("imported", sa.Integer, nullable=False),
        sa.Column("failed", sa.Integer, nullable=False),
        sa.Column("skipped", sa.Integer, nullable=False),
        sa.Column("bytes_transferred", sa.BigInteger, nullable=False),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("full_scan", sa.Boolean, nullable=False),
    )
    op.create_table(
        "bridge_devices",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("credential_hash", sa.String(128), unique=True, nullable=False),
        sa.Column("key_fingerprint", sa.String(128), nullable=False),
        sa.Column("capabilities", postgresql.JSONB(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("enrolled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("write_verified", sa.Boolean, nullable=False),
        sa.Column(
            "verified_asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=True
        ),
    )
    op.create_table(
        "device_mappings",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column(
            "device_id", sa.Uuid(), sa.ForeignKey("bridge_devices.id"), nullable=False
        ),
        sa.Column("local_identifier", sa.String(512), nullable=False),
        sa.Column("cloud_identifier", sa.String(512), nullable=True),
        sa.Column("confidence", sa.Float, nullable=False),
        sa.Column("verification_status", sa.String(32), nullable=False),
        sa.Column("match_method", sa.String(64), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("device_id", "asset_id", "local_identifier"),
        sa.CheckConstraint("confidence >= 0 AND confidence <= 1"),
    )
    op.create_table(
        "metadata_snapshots",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column(
            "device_id", sa.Uuid(), sa.ForeignKey("bridge_devices.id"), nullable=True
        ),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("revision_hash", sa.String(128), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "sync_operations",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column(
            "target_device_id",
            sa.Uuid(),
            sa.ForeignKey("bridge_devices.id"),
            nullable=False,
        ),
        sa.Column("operation_type", sa.String(64), nullable=False),
        sa.Column("desired_revision", sa.String(128), nullable=False),
        sa.Column("expected_revision", sa.String(128), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.String(64), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer, nullable=False),
        sa.Column("idempotency_key", sa.String(512), unique=True, nullable=False),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("approved_by", sa.String(255), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending','claimed','mapping_required','awaiting_approval',"
            "'processing','applied_on_device','awaiting_cloud_confirmation',"
            "'completed','conflict','failed','cancelled')"
        ),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("actor", sa.String(255), nullable=False),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column("details", postgresql.JSONB(), nullable=False),
        sa.Column("correlation_id", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "albums",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("cover_asset_id", sa.Uuid(), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column("sort_order", sa.String(32), nullable=False),
    )
    op.create_table(
        "album_assets",
        sa.Column(
            "album_id",
            sa.Uuid(),
            sa.ForeignKey("albums.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "asset_id",
            sa.Uuid(),
            sa.ForeignKey("assets.id"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
    )
    op.create_table(
        "duplicate_groups",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column("duplicate_type", sa.String(32), nullable=False),
        sa.Column("group_key", sa.String(512), unique=True, nullable=False),
        sa.Column(
            "representative_asset_id",
            sa.Uuid(),
            sa.ForeignKey("assets.id"),
            nullable=True,
        ),
        sa.Column("algorithm", sa.String(64), nullable=False),
        sa.Column("threshold", sa.Float, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "duplicate_members",
        sa.Column(
            "group_id",
            sa.Uuid(),
            sa.ForeignKey("duplicate_groups.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "asset_id",
            sa.Uuid(),
            sa.ForeignKey("assets.id"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("similarity", sa.Float, nullable=False),
        sa.Column("quality_rank", sa.Integer, nullable=True),
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(128), primary_key=True, nullable=False),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "saved_searches",
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("query", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_assets_library_id", "assets", ["library_id"])
    op.create_index("ix_assets_sha256", "assets", ["sha256"])
    op.create_index("ix_assets_phash", "assets", ["phash"])
    op.create_index("ix_assets_capture_cursor", "assets", ["captured_at", "id"])
    op.create_index("ix_assets_created_cursor", "assets", ["created_at", "id"])
    op.create_index(
        "ix_assets_library_status", "assets", ["library_id", "visibility_status"]
    )
    op.create_index(
        "ix_assets_media_dimensions", "assets", ["media_type", "width", "height"]
    )
    op.create_index(
        "ix_assets_search_document", "assets", ["search_document"], postgresql_using="gin"
    )
    op.create_index(
        "ix_assets_filename_trgm",
        "assets",
        ["filename"],
        postgresql_using="gin",
        postgresql_ops={"filename": "gin_trgm_ops"},
    )
    op.create_index("ix_asset_resources_asset_id", "asset_resources", ["asset_id"])
    op.create_index("ix_asset_resources_sha256", "asset_resources", ["sha256"])
    op.create_index("ix_tags_category", "tags", ["category"])
    op.create_index(
        "ix_tags_name_trgm",
        "tags",
        ["display_name"],
        postgresql_using="gin",
        postgresql_ops={"display_name": "gin_trgm_ops"},
    )
    op.create_index("ix_tag_aliases_tag_id", "tag_aliases", ["tag_id"])
    op.create_index("ix_asset_tags_asset_id", "asset_tags", ["asset_id"])
    op.create_index("ix_asset_tags_tag_id", "asset_tags", ["tag_id"])
    op.create_index(
        "ix_asset_tags_filter",
        "asset_tags",
        ["tag_id", "origin", "confidence", "asset_id"],
    )
    op.create_index("ix_inference_runs_asset_id", "inference_runs", ["asset_id"])
    op.create_index("ix_embeddings_asset_id", "embeddings", ["asset_id"])
    op.create_index("ix_embeddings_model_id", "embeddings", ["model_id"])
    op.create_index(
        "ix_embeddings_cosine_hnsw",
        "embeddings",
        ["vector"],
        postgresql_using="hnsw",
        postgresql_ops={"vector": "vector_cosine_ops"},
        postgresql_with={"m": 16, "ef_construction": 64},
    )
    op.create_index("ix_jobs_asset_id", "jobs", ["asset_id"])
    op.create_index("ix_jobs_batch_id", "jobs", ["batch_id"])
    op.create_index(
        "ix_jobs_claim", "jobs", ["status", "scheduled_at", "priority", "created_at"]
    )
    op.create_index("ix_jobs_stale", "jobs", ["status", "lease_until"])
    op.create_index("ix_job_events_job_id", "job_events", ["job_id"])
    op.create_index("ix_ingestion_runs_library_id", "ingestion_runs", ["library_id"])
    op.create_index("ix_device_mappings_asset_id", "device_mappings", ["asset_id"])
    op.create_index("ix_device_mappings_device_id", "device_mappings", ["device_id"])
    op.create_index(
        "ix_device_mappings_target", "device_mappings", ["device_id", "local_identifier"]
    )
    op.create_index("ix_metadata_snapshots_asset_id", "metadata_snapshots", ["asset_id"])
    op.create_index(
        "ix_metadata_snapshot_asset_source",
        "metadata_snapshots",
        ["asset_id", "source", "created_at"],
    )
    op.create_index("ix_sync_operations_asset_id", "sync_operations", ["asset_id"])
    op.create_index(
        "ix_sync_operations_target_device_id", "sync_operations", ["target_device_id"]
    )
    op.create_index(
        "ix_sync_operations_claim",
        "sync_operations",
        ["target_device_id", "status", "lease_until"],
    )
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    op.create_index("ix_audit_events_asset_id", "audit_events", ["asset_id"])
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_album_assets_asset", "album_assets", ["asset_id"])
    op.create_index("ix_duplicate_members_asset", "duplicate_members", ["asset_id"])


def downgrade() -> None:
    op.drop_table("saved_searches")
    op.drop_table("settings")
    op.drop_table("duplicate_members")
    op.drop_table("duplicate_groups")
    op.drop_table("album_assets")
    op.drop_table("albums")
    op.drop_table("audit_events")
    op.drop_table("sync_operations")
    op.drop_table("metadata_snapshots")
    op.drop_table("device_mappings")
    op.drop_table("bridge_devices")
    op.drop_table("ingestion_runs")
    op.drop_table("worker_states")
    op.drop_table("job_events")
    op.drop_table("jobs")
    op.drop_table("job_batches")
    op.drop_table("embeddings")
    op.drop_table("inference_runs")
    op.drop_table("model_registry")
    op.drop_table("asset_tags")
    op.drop_table("tag_aliases")
    op.drop_table("tags")
    op.drop_table("asset_metadata")
    op.drop_table("asset_resources")
    op.drop_table("assets")
    op.drop_table("libraries")
    # Extensions may be shared; deliberately preserve them on downgrade.
