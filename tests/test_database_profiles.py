"""Neon-compatible TLS and connection limits without contacting external services."""

import ssl

import pytest
from photointel.config import Settings
from photointel.database import database_connection_options, database_engine_options
from photointel.errors import AppError
from photointel.services.query_cache import normalize_query, query_cache_key
from sqlalchemy.pool import NullPool


def test_direct_profile_limits_connections_and_requires_verified_tls() -> None:
    settings = Settings(
        _env_file=None,
        database_url="postgresql://example:private@db.invalid/photos?sslmode=require",
    )
    url, args = database_connection_options(settings)
    assert url.drivername == "postgresql+asyncpg"
    assert "sslmode" not in url.query
    assert args["ssl"].check_hostname is True
    assert args["ssl"].verify_mode == ssl.CERT_REQUIRED
    options = database_engine_options(settings)
    assert options["pool_size"] == 2
    assert options["max_overflow"] == 0


def test_transaction_pooler_disables_client_pool_and_statement_caches() -> None:
    settings = Settings(_env_file=None, database_pool_mode="transaction")
    _, args = database_connection_options(settings)
    assert database_engine_options(settings) == {"poolclass": NullPool}
    assert args["prepared_statement_cache_size"] == args["statement_cache_size"] == 0
    generate = args["prepared_statement_name_func"]
    assert generate() != generate()
    with pytest.raises(ValueError, match="direct MIGRATION_DATABASE_URL"):
        database_connection_options(settings, migration=True)
    pooled = settings.model_copy(
        update={"migration_database_url": "postgresql://u:p@ep-test-pooler.neon.tech/db"}
    )
    with pytest.raises(ValueError, match="direct endpoint"):
        database_connection_options(pooled, migration=True)


def test_required_tls_and_unsupported_libpq_options_fail_closed() -> None:
    settings = Settings(_env_file=None, database_require_tls=True)
    with pytest.raises(ValueError, match="TLS cannot be disabled"):
        database_connection_options(
            settings.model_copy(
                update={"database_url": "postgresql://u:p@db.invalid/db?sslmode=disable"}
            )
        )
    with pytest.raises(ValueError, match="TLS cannot be disabled"):
        database_connection_options(
            settings.model_copy(
                update={
                    "database_url": (
                        "postgresql://u:p@db.invalid/db?"
                        "sslmode=disable&channel_binding=require"
                    )
                }
            )
        )
    with pytest.raises(ValueError, match="Unsupported PostgreSQL channel_binding"):
        database_connection_options(
            settings.model_copy(
                update={
                    "database_url": "postgresql://u:p@db.invalid/db?channel_binding=unknown"
                }
            )
        )


def test_neon_default_url_selects_async_psycopg_and_preserves_channel_binding() -> None:
    """Neon's default require policy must never degrade to TLS without SCRAM-PLUS."""
    for driver in ("postgresql", "postgresql+asyncpg", "postgresql+psycopg"):
        settings = Settings(
            _env_file=None,
            database_require_tls=True,
            database_url=(
                f"{driver}://example:secret@ep-test.us-east-1.aws.neon.tech/photos"
                "?sslmode=require&channel_binding=require"
            ),
        )
        url, args = database_connection_options(settings)
        assert url.drivername == "postgresql+psycopg"
        assert url.query["channel_binding"] == "require"
        assert url.query["sslmode"] == "verify-full"
        assert url.query["sslrootcert"] == "system"
        assert args["connect_timeout"] == 15
        assert "ssl" not in args
        assert "command_timeout" not in args

        # Creating an async engine exercises actual SQLAlchemy dialect loading
        # without contacting Neon or using a production credential.
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(url, connect_args=args)
        assert engine.dialect.driver == "psycopg"


def test_neon_pooler_disables_prepares_and_migrations_keep_direct_binding() -> None:
    settings = Settings(
        _env_file=None,
        database_pool_mode="transaction",
        database_require_tls=True,
        database_url=(
            "postgresql://u:p@ep-test-pooler.us-east-1.aws.neon.tech/db"
            "?sslmode=require&channel_binding=require"
        ),
        migration_database_url=(
            "postgresql://u:p@ep-test.us-east-1.aws.neon.tech/db"
            "?sslmode=require&channel_binding=require"
        ),
    )
    url, args = database_connection_options(settings)
    assert url.drivername == "postgresql+psycopg"
    assert args["prepare_threshold"] is None
    assert database_engine_options(settings) == {"poolclass": NullPool}

    migration_url, migration_args = database_connection_options(settings, migration=True)
    assert migration_url.drivername == "postgresql+psycopg"
    assert migration_url.query["channel_binding"] == "require"
    assert migration_url.query["sslmode"] == "verify-full"
    assert "prepare_threshold" not in migration_args


def test_psycopg_with_custom_ca_uses_libpq_hostname_verification(tmp_path) -> None:
    ca = tmp_path / "my-ca.pem"
    settings = Settings(
        _env_file=None,
        database_url="postgresql://u:p@db.invalid/db?channel_binding=require",
        database_tls_ca_file=ca,
        database_require_tls=True,
    )
    url, _ = database_connection_options(settings)
    assert url.query["sslrootcert"] == str(ca)
    assert url.query["sslmode"] == "verify-full"
    assert url.query["channel_binding"] == "require"


def test_explicit_libpq_sslrootcert_is_preserved() -> None:
    settings = Settings(
        _env_file=None,
        database_require_tls=True,
        database_url=(
            "postgresql://u:p@db.invalid/db?"
            "sslmode=require&channel_binding=require&sslrootcert=/custom/ca.pem"
        ),
    )
    url, _ = database_connection_options(settings)
    assert url.query["sslrootcert"] == "/custom/ca.pem"
    assert url.query["sslmode"] == "verify-full"


def test_query_cache_normalizes_without_persisting_plaintext_and_versions_keys() -> None:
    settings = Settings(_env_file=None)
    query = "  Retrato\tCOM  fundo\nverde  "
    assert normalize_query(query) == "retrato com fundo verde"
    assert normalize_query("ＰＬＡＮＴＡ") == "planta"
    key = query_cache_key(query, settings)
    assert len(key) == 64
    assert key == query_cache_key("retrato com fundo verde", settings)
    assert key != query_cache_key(
        query, settings.model_copy(update={"siglip_model_revision": "f" * 40})
    )
    assert key != query_cache_key(
        query,
        settings.model_copy(update={"query_preprocessing_revision": "next-version"}),
    )
    with pytest.raises(AppError, match="inválida"):
        normalize_query(" \n ")
