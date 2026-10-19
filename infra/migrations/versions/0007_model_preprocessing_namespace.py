"""Separate embedding namespaces when preprocessing/runtime versions change.

Revision ID: 0007_model_preprocessing
Revises: 0006_query_embedding_cache
"""

import sqlalchemy as sa
from alembic import op

revision = "0007_model_preprocessing"
down_revision = "0006_query_embedding_cache"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_registry",
        sa.Column(
            "preprocessing_revision", sa.String(128), nullable=False,
            server_default="legacy-v1",
        ),
    )
    op.drop_constraint(
        "model_registry_provider_model_name_revision_key",
        "model_registry",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_model_registry_pipeline", "model_registry",
        ["provider", "model_name", "revision", "preprocessing_revision"],
    )
    op.drop_index("uq_active_model_revision", table_name="model_registry")
    op.create_index(
        "uq_active_model_revision", "model_registry",
        ["provider", "model_name", "preprocessing_revision"], unique=True,
        postgresql_where=sa.text("active"),
    )


def downgrade() -> None:
    # Never merge/delete embedding owners to satisfy the old unique constraint.
    connection = op.get_bind()
    duplicate = connection.scalar(
        sa.text(
            "SELECT 1 FROM model_registry GROUP BY provider, model_name, revision "
            "HAVING count(*) > 1 LIMIT 1"
        )
    )
    active_duplicate = connection.scalar(
        sa.text(
            "SELECT 1 FROM model_registry WHERE active GROUP BY provider, model_name "
            "HAVING count(*) > 1 LIMIT 1"
        )
    )
    if duplicate or active_duplicate:
        raise RuntimeError(
            "Downgrade requires an operator-reviewed metadata migration; "
            "multiple preprocessing namespaces must not be silently merged"
        )
    op.drop_index("uq_active_model_revision", table_name="model_registry")
    op.drop_constraint("uq_model_registry_pipeline", "model_registry", type_="unique")
    op.create_unique_constraint(
        "model_registry_provider_model_name_revision_key", "model_registry",
        ["provider", "model_name", "revision"],
    )
    op.create_index(
        "uq_active_model_revision", "model_registry", ["provider", "model_name"],
        unique=True, postgresql_where=sa.text("active"),
    )
    op.drop_column("model_registry", "preprocessing_revision")
