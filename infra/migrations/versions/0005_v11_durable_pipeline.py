"""Expand durable discovery, fenced processing, encrypted sessions and verification.

No existing catalog rows are removed or rewritten. Runtime model imports are not
used: this schema snapshot is frozen for upgrade and isolated rollback.
"""

from alembic import op

revision = "0005_v11_durable_pipeline"
down_revision = "0004_filename_search_tokens"
branch_labels = None
depends_on = None


TABLES = {
    "durable_leases": """
        key varchar(512) PRIMARY KEY, owner varchar(128),
        fence_token integer NOT NULL DEFAULT 0, lease_until timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
    """,
    "object_intents": """
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid REFERENCES jobs(id), asset_id uuid NOT NULL REFERENCES assets(id),
        content_revision varchar(128) NOT NULL,
        representation_revision varchar(128) NOT NULL,
        object_key varchar(1024) NOT NULL UNIQUE, sha256 varchar(64) NOT NULL,
        mime_type varchar(128) NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>=0),
        status varchar(32) NOT NULL DEFAULT 'pending', owner varchar(128) NOT NULL,
        fence_token integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    """,
    "icloud_session_states": """
        scope_key varchar(64) PRIMARY KEY, generation integer NOT NULL DEFAULT 0,
        object_key varchar(1024), ciphertext_sha256 varchar(64), key_id varchar(64),
        lease_owner uuid, lease_token integer NOT NULL DEFAULT 0,
        lease_until timestamptz, revoked_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(), last_error varchar(64)
    """,
    "discovery_scans": """
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        library_id uuid NOT NULL REFERENCES libraries(id),
        mode varchar(32) NOT NULL DEFAULT 'incremental',
        status varchar(32) NOT NULL DEFAULT 'discovering',
        source_cursor jsonb NOT NULL DEFAULT '{}', seen_count integer NOT NULL DEFAULT 0,
        last_error varchar(64), created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    """,
    "discovery_manifests": """
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scan_id uuid NOT NULL REFERENCES discovery_scans(id),
        library_id uuid NOT NULL REFERENCES libraries(id),
        asset_id uuid NOT NULL REFERENCES assets(id), source_key varchar(512) NOT NULL,
        content_revision varchar(128) NOT NULL, snapshot jsonb NOT NULL DEFAULT '{}',
        status varchar(32) NOT NULL DEFAULT 'discovered', failure_category varchar(64),
        attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
        maximum_attempts integer NOT NULL DEFAULT 5 CHECK(maximum_attempts>0),
        last_error varchar(64), created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(library_id,source_key,content_revision)
    """,
    "verification_gates": """
        id varchar(1) PRIMARY KEY CHECK(id IN ('A','B','C','D','E','F')),
        status varchar(32) NOT NULL DEFAULT 'not_verified', release_sha varchar(64),
        evidence jsonb NOT NULL DEFAULT '[]', notes varchar(2000),
        verified_by varchar(255), verified_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
    """,
    "dispatch_outbox": """
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_name varchar(64) NOT NULL,
        idempotency_key varchar(512) NOT NULL UNIQUE,
        status varchar(32) NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        owner varchar(128), lease_until timestamptz, last_error varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    """,
}


def upgrade() -> None:
    op.execute("ALTER TABLE jobs ADD COLUMN fence_token integer NOT NULL DEFAULT 0")
    for name, columns in TABLES.items():
        op.execute(f"CREATE TABLE {name} ({columns})")
    op.execute("CREATE INDEX ix_object_intents_asset_id ON object_intents(asset_id)")
    op.execute(
        "CREATE INDEX ix_object_intents_recovery ON object_intents(status,updated_at)"
    )
    op.execute(
        "CREATE INDEX ix_discovery_scans_library_id ON discovery_scans(library_id)"
    )
    op.execute(
        "CREATE INDEX ix_discovery_manifests_scan_id ON discovery_manifests(scan_id)"
    )
    op.execute(
        "CREATE INDEX ix_discovery_manifests_asset_id ON discovery_manifests(asset_id)"
    )
    op.execute(
        "CREATE INDEX ix_discovery_manifest_status "
        "ON discovery_manifests(status,updated_at,id)"
    )
    op.execute(
        "CREATE INDEX ix_dispatch_outbox_claim "
        "ON dispatch_outbox(status,lease_until,created_at)"
    )


def downgrade() -> None:
    # Downgrade is only for an explicitly selected, backed-up maintenance window.
    for name in reversed(TABLES):
        op.execute(f"DROP TABLE {name}")
    op.execute("ALTER TABLE jobs DROP COLUMN fence_token")
