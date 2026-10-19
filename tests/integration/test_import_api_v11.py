"""HTTP authorization is persisted before any finite execution is dispatched."""

import os
from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
import pytest
from photointel.config import Settings
from photointel.database import Base, get_session
from photointel.main import create_app
from photointel.models import Job
from photointel.routers import operations
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

pytestmark = pytest.mark.integration


@pytest.fixture
async def import_api(
    monkeypatch,
) -> AsyncIterator[tuple[httpx.AsyncClient, AsyncSession]]:
    url = os.getenv("DATABASE_URL", "")
    if not url.startswith("postgresql+asyncpg://"):
        pytest.skip("Requires explicit disposable PostgreSQL")
    schema = "test_import_api_" + uuid4().hex
    administration = create_async_engine(url)
    async with administration.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        url,
        connect_args={"server_settings": {"search_path": f"{schema},public"}},
        execution_options={"schema_translate_map": {None: schema}},
    )
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with AsyncSession(engine, expire_on_commit=False) as session:

            async def settings(_session):
                return Settings(
                    _env_file=None,
                    app_env="test",
                    icloud_enabled=True,
                    icloud_account="fixture@example.invalid",
                    icloud_library="PrimarySync",
                )

            async def dependency():
                yield session

            monkeypatch.setattr(operations, "effective_settings", settings)
            app = create_app()
            app.dependency_overrides[get_session] = dependency
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://localhost"
            ) as client:
                yield client, session
    finally:
        await engine.dispose()
        async with administration.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await administration.dispose()


@pytest.mark.parametrize("limit,confirmed", [(100, False), (500, True), (1000, True)])
async def test_http_import_preserves_authorized_execution_limit(
    import_api, limit, confirmed
):
    client, session = import_api
    response = await client.post(
        "/v1/ingestion/start",
        json={
            "source": "icloud",
            "mode": "backfill",
            "limit": limit,
            "confirm_expansion": confirmed,
        },
    )
    assert response.status_code == 202
    from uuid import UUID

    job = await session.get(Job, UUID(response.json()["job_id"]))
    assert job.payload["authorization"]["requested_batch_limit"] == limit
    assert job.payload["authorization"]["confirmed_expansion"] == confirmed
    assert job.payload["backfill_authorization"] is None


@pytest.mark.parametrize(
    "limit,confirmed,status", [(500, False, 409), (10001, True, 422)]
)
async def test_http_import_rejects_unauthorized_expansion(
    import_api, limit, confirmed, status
):
    client, _ = import_api
    response = await client.post(
        "/v1/ingestion/start",
        json={
            "source": "icloud",
            "limit": limit,
            "confirm_expansion": confirmed,
        },
    )
    assert response.status_code == status


async def test_full_backfill_does_not_unlock_from_confirmation_alone(import_api):
    client, _ = import_api
    response = await client.post(
        "/v1/ingestion/start",
        json={
            "source": "icloud",
            "mode": "backfill",
            "limit": 100,
            "target_assets": 176000,
            "confirm_full_backfill": True,
        },
    )
    assert response.status_code == 409
