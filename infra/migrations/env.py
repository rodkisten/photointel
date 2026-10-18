"""Frozen migrations with database-only identity, serialized on a direct connection.

A migration task needs DATABASE_URL/TLS configuration only. It must not initialize
application auth/storage/GPU configuration or obtain their Secret Manager values.
"""

import asyncio
import os
from dataclasses import dataclass
from logging.config import fileConfig
from pathlib import Path
from typing import Literal, cast

from alembic import context
from dotenv import dotenv_values
from photointel.db_connection import database_connection_options
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name, disable_existing_loggers=False)
# These migrations explicitly create every column/index. Autogenerate is not a
# production operation; importing Base would initialize the API engine/settings.
target_metadata = None


@dataclass
class MigrationOptions:
    database_url: str
    migration_database_url: str | None = None
    database_pool_mode: Literal["direct", "transaction"] = "direct"
    database_require_tls: bool = False
    database_tls_ca_file: Path | None = None
    database_pool_size: int = 1
    database_max_overflow: int = 0
    database_pool_timeout_seconds: int = 15


def migration_options() -> MigrationOptions:
    values = {**dotenv_values(".env"), **os.environ}
    url = values.get("MIGRATION_DATABASE_URL") or values.get("DATABASE_URL")
    if not url:
        raise ValueError("Migrations require DATABASE_URL or MIGRATION_DATABASE_URL")
    require_tls = values.get("DATABASE_REQUIRE_TLS", "").casefold()
    if require_tls not in {"", "true", "false", "1", "0"}:
        raise ValueError("DATABASE_REQUIRE_TLS must be true or false")
    production = values.get("APP_ENV") == "production"
    if production and require_tls in {"false", "0"}:
        raise ValueError("Production migrations require verified TLS")
    ca = values.get("DATABASE_TLS_CA_FILE")
    return MigrationOptions(
        database_url=values.get("DATABASE_URL") or url,
        migration_database_url=values.get("MIGRATION_DATABASE_URL") or None,
        database_pool_mode=cast(
            Literal["direct", "transaction"], values.get("DATABASE_POOL_MODE") or "direct"
        ),
        database_require_tls=production or require_tls in {"true", "1"},
        database_tls_ca_file=Path(ca) if ca else None,
    )


def run_migrations_offline() -> None:
    database_url, _ = database_connection_options(migration_options(), migration=True)
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    database_url, connect_args = database_connection_options(
        migration_options(), migration=True
    )
    engine = create_async_engine(
        database_url, connect_args=connect_args, poolclass=pool.NullPool
    )
    try:
        async with engine.connect() as connection:
            # Migrations use a DIRECT connection: session advisory serialization
            # is intentional here and prohibited on the transaction pool endpoint.
            await connection.exec_driver_sql("SELECT pg_advisory_lock(719281049)")
            await connection.commit()
            try:
                await connection.run_sync(do_run_migrations)
            finally:
                if connection.in_transaction():
                    await connection.rollback()
                await connection.exec_driver_sql("SELECT pg_advisory_unlock(719281049)")
                await connection.commit()
    finally:
        await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
