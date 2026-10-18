"""Persist revision-scoped semantic query embeddings without query plaintext.

Revision ID: 0006_query_embedding_cache
Revises: 0005_v11_durable_pipeline
"""

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision = "0006_query_embedding_cache"
down_revision = "0005_v11_durable_pipeline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "query_embedding_cache",
        sa.Column("cache_key", sa.String(64), primary_key=True),
        sa.Column(
            "model_id", sa.Uuid(), sa.ForeignKey("model_registry.id"), nullable=False
        ),
        sa.Column("model_revision", sa.String(128), nullable=False),
        sa.Column("preprocessing_revision", sa.String(128), nullable=False),
        sa.Column("vector", Vector(768)),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("owner_token", postgresql.UUID(as_uuid=True)),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("hit_count", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint(
            "status IN ('generating','ready')", name="ck_query_cache_status"
        ),
    )
    op.create_index(
        "ix_query_embedding_cache_expires_at", "query_embedding_cache", ["expires_at"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_query_embedding_cache_expires_at", table_name="query_embedding_cache"
    )
    op.drop_table("query_embedding_cache")
