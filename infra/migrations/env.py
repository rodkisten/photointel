"""Run PostgreSQL migrations online or emit reviewable SQL without a database."""

import asyncio
from logging.config import fileConfig

from alembic import context
from photointel import models  # noqa: F401  Registers the complete metadata.
from photointel.config import get_settings
from photointel.database import Base
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name, disable_existing_loggers=False)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=get_settings().migration_database_url or get_settings().database_url,
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
    settings = get_settings()
    engine = create_async_engine(
        settings.migration_database_url or settings.database_url,
        poolclass=pool.NullPool,
    )
    try:
        async with engine.connect() as connection:
            # One migration runner at a time, across independent deployments.
            await connection.exec_driver_sql("SELECT pg_advisory_lock(719281049)")
            await connection.commit()
            try:
                await connection.run_sync(do_run_migrations)
            finally:
                # A failed migration may leave a transaction aborted. Roll it back
                # before releasing the session-level advisory lock.
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
