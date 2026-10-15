"""Bounded PhotoKit inventory and mapping lookups at library scale.

Revision ID: 0003_bridge_inventory_indexes
Revises: 0002_search_integrity
"""

from alembic import op

revision = "0003_bridge_inventory_indexes"
down_revision = "0002_search_integrity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE INDEX ix_photokit_snapshot_device_local ON metadata_snapshots
        (device_id, (payload ->> 'local_identifier'), created_at DESC)
        WHERE source = 'photokit'
    """)
    op.create_index(
        "ix_device_mappings_asset_verification", "device_mappings",
        ["device_id", "asset_id", "verification_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_device_mappings_asset_verification", "device_mappings")
    op.drop_index("ix_photokit_snapshot_device_local", "metadata_snapshots")
