"""PostgreSQL connection policy without application startup or secret side effects."""

import ssl
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import uuid4

from sqlalchemy.engine import URL, make_url
from sqlalchemy.pool import NullPool


class DatabaseOptions(Protocol):
    database_url: str
    migration_database_url: str | None
    database_pool_mode: Literal["direct", "transaction"]
    database_require_tls: bool
    database_tls_ca_file: Path | None
    database_pool_size: int
    database_max_overflow: int
    database_pool_timeout_seconds: int


def database_connection_options(
    settings: DatabaseOptions, *, migration: bool = False
) -> tuple[URL, dict[str, Any]]:
    """Translate libpq-style TLS URLs into asyncpg's verified SSL configuration.

    Neon transaction pooling must use NullPool and a direct migration URL. No
    session state, temporary tables or session advisory locks belong on that URL.
    """
    raw_url = (
        settings.migration_database_url if migration else settings.database_url
    ) or settings.database_url
    url = make_url(raw_url)
    if url.drivername in {"postgres", "postgresql"}:
        url = url.set(drivername="postgresql+asyncpg")
    if url.drivername != "postgresql+asyncpg":
        raise ValueError("DATABASE_URL must use PostgreSQL with asyncpg")
    if migration and settings.database_pool_mode == "transaction":
        if not settings.migration_database_url:
            raise ValueError(
                "Transaction pooling requires a direct MIGRATION_DATABASE_URL"
            )
        if "-pooler." in (url.host or ""):
            raise ValueError("MIGRATION_DATABASE_URL must use Neon's direct endpoint")
    query = dict(url.query)
    sslmode = query.pop("sslmode", None)
    channel_binding = query.pop("channel_binding", None)
    if channel_binding not in {None, "prefer", "disable"}:
        raise ValueError(
            "asyncpg does not support channel_binding=require; use verified TLS "
            "with sslmode=verify-full and remove that libpq-only parameter"
        )
    if sslmode not in {None, "require", "verify-ca", "verify-full", "disable"}:
        raise ValueError("Unsupported PostgreSQL sslmode")
    require_tls = settings.database_require_tls or sslmode in {
        "require",
        "verify-ca",
        "verify-full",
    }
    if require_tls and sslmode == "disable":
        raise ValueError("TLS cannot be disabled for this database profile")
    connect_args: dict[str, Any] = {"timeout": 15, "command_timeout": 60}
    if require_tls:
        # Even sslmode=require validates hostname and CA. Never silently accept
        # an unverified certificate for private photo metadata.
        connect_args["ssl"] = ssl.create_default_context(
            cafile=str(settings.database_tls_ca_file)
            if settings.database_tls_ca_file
            else None
        )
    elif sslmode == "disable":
        connect_args["ssl"] = False
    if settings.database_pool_mode == "transaction" and not migration:
        connect_args.update(
            statement_cache_size=0,
            prepared_statement_cache_size=0,
            prepared_statement_name_func=lambda: f"__photointel_{uuid4().hex}",
        )
    return url.set(query=query), connect_args


def database_engine_options(settings: DatabaseOptions) -> dict[str, Any]:
    if settings.database_pool_mode == "transaction":
        return {"poolclass": NullPool}
    return {
        "pool_pre_ping": True,
        "pool_size": settings.database_pool_size,
        "max_overflow": settings.database_max_overflow,
        "pool_timeout": settings.database_pool_timeout_seconds,
        "pool_recycle": 900,
    }
