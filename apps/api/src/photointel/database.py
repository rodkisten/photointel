"""Short-lived PostgreSQL access, with explicit transaction-pooler support."""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from photointel.config import get_settings
from photointel.db_connection import (
    database_connection_options,
    database_engine_options,
)


class Base(DeclarativeBase):
    pass


_settings = get_settings()
_database_url, _connect_args = database_connection_options(_settings)
engine = create_async_engine(
    _database_url,
    connect_args=_connect_args,
    **database_engine_options(_settings),
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
