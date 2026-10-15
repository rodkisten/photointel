"""Database-maintained search documents and production safety invariants.

Revision ID: 0002_search_integrity
Revises: 0001_catalog
"""

from alembic import op

revision = "0002_search_integrity"
down_revision = "0001_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Full-text documents deliberately exclude AI tags. A sensitive tag must never
    # become visible through an unfiltered text-search side channel.
    op.execute("""
        CREATE FUNCTION photointel_asset_search_document() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            NEW.search_document := to_tsvector('simple', coalesce(NEW.filename, ''));
            RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER asset_search_document_update
        BEFORE INSERT OR UPDATE OF filename ON assets
        FOR EACH ROW EXECUTE FUNCTION photointel_asset_search_document()
    """)
    op.execute("""
        UPDATE assets SET search_document = to_tsvector('simple', coalesce(filename, ''))
    """)
    op.execute("""
        CREATE INDEX ix_assets_source_metadata_gin ON assets
        USING gin (source_metadata jsonb_path_ops)
    """)
    op.execute("""
        CREATE INDEX ix_assets_gallery_cursor ON assets
        ((coalesce(captured_at, created_at, '1970-01-01 UTC'::timestamptz)) DESC, id)
        WHERE visibility_status <> 'archived'
    """)
    op.execute("""
        CREATE INDEX ix_assets_added_cursor ON assets
        ((coalesce(added_at, created_at, '1970-01-01 UTC'::timestamptz)) DESC, id)
        WHERE visibility_status <> 'archived'
    """)
    op.execute("""
        CREATE INDEX ix_jobs_live_claim ON jobs
        (priority DESC, scheduled_at, created_at)
        WHERE status IN ('queued', 'retrying')
    """)
    op.create_check_constraint(
        "ck_embedding_dimension_model", "model_registry",
        "embedding_dimension IS NULL OR embedding_dimension = 768",
    )
    op.create_check_constraint(
        "ck_asset_tag_user_status", "asset_tags",
        "user_status IN ('unreviewed', 'approved', 'rejected')",
    )
    op.create_check_constraint(
        "ck_asset_missing_scan_count", "assets", "missing_scan_count >= 0",
    )
    op.create_check_constraint(
        "ck_resource_byte_size", "asset_resources",
        "byte_size IS NULL OR byte_size >= 0",
    )
    op.create_check_constraint(
        "ck_sync_attempts", "sync_operations", "attempts >= 0",
    )
    # A device identifier cannot target two verified assets; ambiguous inventory
    # candidates remain representable until the operator resolves their mapping.
    op.execute("""
        CREATE UNIQUE INDEX uq_verified_device_target ON device_mappings
        (device_id, local_identifier) WHERE verification_status = 'verified'
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_active_model_revision ON model_registry
        (provider, model_name) WHERE active
    """)


def downgrade() -> None:
    op.drop_index("uq_active_model_revision", "model_registry")
    op.drop_index("uq_verified_device_target", "device_mappings")
    op.drop_constraint("ck_sync_attempts", "sync_operations", type_="check")
    op.drop_constraint("ck_resource_byte_size", "asset_resources", type_="check")
    op.drop_constraint("ck_asset_missing_scan_count", "assets", type_="check")
    op.drop_constraint("ck_asset_tag_user_status", "asset_tags", type_="check")
    op.drop_constraint("ck_embedding_dimension_model", "model_registry", type_="check")
    op.drop_index("ix_jobs_live_claim", "jobs")
    op.drop_index("ix_assets_added_cursor", "assets")
    op.drop_index("ix_assets_gallery_cursor", "assets")
    op.drop_index("ix_assets_source_metadata_gin", "assets")
    op.execute("DROP TRIGGER asset_search_document_update ON assets")
    op.execute("DROP FUNCTION photointel_asset_search_document()")
