"""Real PostgreSQL and private storage integration; isolated outer transactions."""

from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.database import engine, get_session
from photointel.main import create_app
from photointel.models import (
    Asset, AssetResource, AssetTag, Library, Tag,
)
from photointel.storage import LocalStorage, object_key

pytestmark = pytest.mark.integration


@pytest.fixture
async def database() -> AsyncIterator[AsyncSession]:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(
            bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint",
        ) as session:
            yield session
        await transaction.rollback()


@pytest.fixture
async def client(database: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app()

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield database

    app.dependency_overrides[get_session] = override_session
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost",
    ) as client:
        yield client


@pytest.fixture
async def asset(database: AsyncSession) -> Asset:
    library = Library(
        source_type="fixture", source_identifier=f"integration-{uuid4()}", name="Test fixtures",
    )
    database.add(library)
    await database.flush()
    asset = Asset(
        library_id=library.id, source_asset_key="asset-1", filename="test.jpg",
        media_type="image", width=640, height=480, filesize=1234,
        ingestion_status="completed", quality={"sharpness": 100.0},
    )
    database.add(asset)
    await database.flush()
    return asset


async def test_catalog_tags_rejection_and_album_persistence(
    client: httpx.AsyncClient, asset: Asset, database: AsyncSession,
) -> None:
    response = await client.get(f"/v1/assets/{asset.id}")
    assert response.status_code == 200
    assert response.json()["width"] == 640
    assert "source_metadata" not in response.json()
    response = await client.patch(f"/v1/assets/{asset.id}/tags", json={"add": ["private_test"]})
    assert response.status_code == 200
    manual = next(tag for tag in response.json() if tag["canonical_key"] == "private_test")
    assert manual["origin"] == "user"
    tag_id = manual["tag_id"]
    database.add(AssetTag(
        asset_id=asset.id, tag_id=tag_id, origin="joytag", model_version="test-revision",
        confidence=.9,
    ))
    await database.flush()
    response = await client.patch(
        f"/v1/assets/{asset.id}/tags", json={"reject": [tag_id]},
    )
    assert response.status_code == 200
    search = await client.post("/v1/search", json={
        "filter": {"op": "tag", "value": "private_test"},
    })
    assert search.status_code == 200
    assert str(asset.id) not in [row["id"] for row in search.json()["items"]]
    # AI source assertion remains intact, while rejection is independently persisted.
    assertions = (await database.scalars(select(AssetTag).where(
        AssetTag.asset_id == asset.id, AssetTag.tag_id == tag_id,
    ))).all()
    assert any(row.origin == "joytag" for row in assertions)
    assert any(row.origin == "user" and row.user_status == "rejected" for row in assertions)
    created = await client.post("/v1/albums", json={"name": "Integration album"})
    assert created.status_code == 201
    album_id = created.json()["id"]
    added = await client.post(
        f"/v1/albums/{album_id}/assets", json={"asset_ids": [str(asset.id), str(asset.id)]},
    )
    assert added.status_code == 200
    result = await client.get(f"/v1/albums/{album_id}")
    assert result.json()["asset_count"] == 1
    removed = await client.delete(f"/v1/albums/{album_id}/assets/{asset.id}")
    assert removed.status_code == 204
    assert (await client.get(f"/v1/albums/{album_id}")).json()["asset_count"] == 0


async def test_private_media_selects_only_database_resource(
    client: httpx.AsyncClient, asset: Asset, database: AsyncSession,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = LocalStorage(tmp_path)
    key = object_key(str(asset.id), asset.representation_revision, "thumbnail_medium")
    storage.put(key, b"fixture-webp-bytes", "image/webp")
    database.add(AssetResource(
        asset_id=asset.id, resource_type="thumbnail_medium", object_key=key,
        revision=asset.representation_revision, status="available",
        mime_type="image/webp", byte_size=18,
    ))
    await database.flush()
    monkeypatch.setattr("photointel.routers.catalog.get_storage", lambda: storage)
    response = await client.get(f"/v1/assets/{asset.id}/media/thumbnail_medium")
    assert response.status_code == 200
    assert response.content == b"fixture-webp-bytes"
    assert response.headers["cache-control"] == "private, no-store"
    resources = await client.get(f"/v1/assets/{asset.id}/resources")
    assert "object_key" not in resources.text
    assert (await client.get(f"/v1/assets/{uuid4()}/media/thumbnail_medium")).status_code == 404
    assert (await client.get(f"/v1/assets/{asset.id}/media/inference_input")).status_code == 422


async def test_cursor_gallery_has_no_repeats(
    client: httpx.AsyncClient, asset: Asset, database: AsyncSession,
) -> None:
    for index in range(5):
        database.add(Asset(
            library_id=asset.library_id, source_asset_key=f"page-{index}",
            filename=f"page-{index}.jpg", quality={},
        ))
    await database.flush()
    first = await client.get("/v1/assets", params={
        "library_id": str(asset.library_id), "limit": 3,
    })
    assert first.status_code == 200
    second = await client.get("/v1/assets", params={
        "library_id": str(asset.library_id), "limit": 3,
        "cursor": first.json()["next_cursor"],
    })
    ids = [row["id"] for row in first.json()["items"] + second.json()["items"]]
    assert len(ids) == len(set(ids)) == 6


async def test_request_limits_and_forbidden_browser_origin(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/v1/albums", json={"name": "bad origin"}, headers={"Origin": "https://evil.invalid"},
    )
    assert response.status_code == 403
    response = await client.post("/v1/search", content=b"x" * (1024 * 1024 + 1))
    assert response.status_code == 413


async def test_sensitive_tag_opt_in(
    client: httpx.AsyncClient, asset: Asset, database: AsyncSession,
) -> None:
    tag = Tag(
        canonical_key=f"sensitive-{uuid4()}", display_name="Sensitive fixture",
        category="genitals", is_sensitive=True,
    )
    database.add(tag)
    await database.flush()
    database.add(AssetTag(
        asset_id=asset.id, tag_id=tag.id, origin="joytag", model_version="test",
        confidence=.9,
    ))
    await database.flush()
    response = await client.get(f"/v1/assets/{asset.id}/tags")
    assert all(row["tag_id"] != str(tag.id) for row in response.json())
    patch = await client.patch("/v1/settings", json={"sensitive_tags_visible": True})
    assert patch.status_code == 200
    response = await client.get(f"/v1/assets/{asset.id}/tags")
    assert any(row["tag_id"] == str(tag.id) for row in response.json())
