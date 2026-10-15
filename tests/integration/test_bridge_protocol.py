"""PostgreSQL protocol tests use simulated receipts; no actual PhotoKit writes."""

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from photointel.database import engine, get_session
from photointel.main import create_app
from photointel.models import Asset, Library
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


@pytest.fixture
async def bridge_database() -> AsyncIterator[AsyncSession]:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ) as session:
            yield session
        await transaction.rollback()


@pytest.fixture
async def bridge_client(
    bridge_database: AsyncSession,
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app()

    async def override() -> AsyncIterator[AsyncSession]:
        yield bridge_database

    app.dependency_overrides[get_session] = override
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        yield client


def fixture_capabilities(write: bool = False) -> dict[str, object]:
    """A protocol fixture, explicitly not proof of an operational iOS integration."""
    return {
        "level": "write_supported_unverified" if write else "read_only",
        "photokit_read": True,
        "keywords_read": write,
        "keywords_write": write,
        "authorization": "authorized",
        "platform": "integration-test",
        "adapter": "test",
    }


async def test_device_enrollment_inventory_mapping_and_safe_sync(
    bridge_client: httpx.AsyncClient,
    bridge_database: AsyncSession,
) -> None:
    client = bridge_client
    assert (await client.get("/v1/bridge/status")).status_code == 401
    issued = await client.post("/v1/apple-sync/enrollment")
    assert issued.status_code == 200
    enrollment = {
        "code": issued.json()["code"],
        "name": "Protocol fixture",
        "capabilities": fixture_capabilities(),
    }
    registered = await client.post("/v1/bridge/enroll", json=enrollment)
    assert registered.status_code == 201
    assert (await client.post("/v1/bridge/enroll", json=enrollment)).status_code == 401
    device_id = registered.json()["device"]["id"]
    headers = {"Authorization": "Bearer " + registered.json()["credential"]}
    assert "credential_hash" not in registered.text
    library = Library(
        source_type="fixture", source_identifier=f"bridge-{uuid4()}", name="Fixture"
    )
    bridge_database.add(library)
    await bridge_database.flush()
    captured = datetime.now(UTC)
    asset = Asset(
        library_id=library.id,
        source_asset_key="icloud-not-a-cloud-id",
        filename="same-name.jpg",
        width=640,
        height=480,
        captured_at=captured,
    )
    other = Asset(
        library_id=library.id,
        source_asset_key="distinct-but-similar",
        filename="same-name.jpg",
        width=640,
        height=480,
        captured_at=captured,
    )
    bridge_database.add_all([asset, other])
    await bridge_database.flush()
    item = {
        "local_identifier": "device-only/local-id",
        "filename": "same-name.jpg",
        "width": 640,
        "height": 480,
        "keywords": None,
        "captured_at": captured.isoformat(),
    }
    first = await client.post(
        "/v1/bridge/manifest", json={"items": [item]}, headers=headers
    )
    assert first.status_code == 200
    snapshot_id = first.json()["items"][0]["snapshot_id"]
    repeated = await client.post(
        "/v1/bridge/manifest", json={"items": [item]}, headers=headers
    )
    assert repeated.json()["items"][0]["snapshot_id"] == snapshot_id
    assert first.json()["items"][0]["asset_id"] is None  # Filename is not identity.
    assert set(first.json()["items"][0]["candidate_asset_ids"]) == {
        str(asset.id),
        str(other.id),
    }
    proposal = {
        "asset_id": str(asset.id),
        "target_device_id": device_id,
        "add": ["praia"],
        "single_asset_test": True,
    }
    ambiguous = await client.post("/v1/apple-sync/preview", json=proposal)
    assert ambiguous.status_code == 409
    assert ambiguous.json()["error"]["code"] == "ASSET_MAPPING_AMBIGUOUS"
    mapped = await client.post(
        "/v1/apple-sync/mappings/confirm",
        json={
            "asset_id": str(asset.id),
            "snapshot_id": snapshot_id,
            "confirm": True,
        },
    )
    assert mapped.status_code == 200
    unsupported = await client.post("/v1/apple-sync/preview", json=proposal)
    assert unsupported.status_code == 409
    assert unsupported.json()["error"]["code"] == "PHOTOKIT_WRITE_UNAVAILABLE"
    assert (await client.get("/v1/bridge/operations", headers=headers)).json()[
        "items"
    ] == []
    # Simulate a future verified-capability runtime to validate the server protocol only.
    assert (
        await client.post(
            "/v1/bridge/capabilities", json=fixture_capabilities(True), headers=headers
        )
    ).status_code == 200
    item["keywords"] = ["Família"]
    assert (
        await client.post("/v1/bridge/manifest", json={"items": [item]}, headers=headers)
    ).status_code == 200
    preview = await client.post("/v1/apple-sync/preview", json=proposal)
    assert preview.status_code == 200
    assert preview.json()["after"] == ["Família", "praia"]
    request = {**proposal, "idempotency_key": "individual-test"}
    created = await client.post("/v1/apple-sync/operations", json=request)
    assert created.status_code == 201
    operation_id = created.json()["id"]
    assert created.json()["status"] == "awaiting_approval"
    assert (await client.post("/v1/apple-sync/operations", json=request)).json()[
        "id"
    ] == operation_id
    assert (await client.get("/v1/bridge/operations", headers=headers)).json()[
        "items"
    ] == []
    assert (
        await client.post(f"/v1/apple-sync/operations/{operation_id}/approve")
    ).status_code == 200
    claimed = await client.get("/v1/bridge/operations", headers=headers)
    assert len(claimed.json()["items"]) == 1
    lease = claimed.json()["items"][0]["lease_token"]
    assert "lease_token_hash" not in claimed.text
    # Cancellation may no longer claim success after a device acquired the operation.
    assert (
        await client.post(f"/v1/apple-sync/operations/{operation_id}/cancel")
    ).status_code == 409
    bad_receipt = {
        "status": "applied_on_device",
        "lease_token": lease,
        "before_keywords": ["Família"],
        "after_keywords": ["praia"],
    }
    assert (
        await client.post(
            f"/v1/bridge/operations/{operation_id}/ack", json=bad_receipt, headers=headers
        )
    ).status_code == 409
    receipt = {**bad_receipt, "after_keywords": ["Família", "praia"]}
    acknowledged = await client.post(
        f"/v1/bridge/operations/{operation_id}/ack", json=receipt, headers=headers
    )
    assert acknowledged.status_code == 200
    assert acknowledged.json()["status"] == "awaiting_cloud_confirmation"
    repeated_ack = await client.post(
        f"/v1/bridge/operations/{operation_id}/ack", json=receipt, headers=headers
    )
    assert repeated_ack.status_code == 200
    verified = await client.post(
        f"/v1/apple-sync/operations/{operation_id}/verify-single-write"
    )
    assert verified.status_code == 200
    assert verified.json()["write_verified"] is True
    # No device readback is misrepresented as confirmation of an iCloud change.
    status = await client.get("/v1/apple-sync/status")
    assert status.json()["cloud_confirmation_available"] is False
    assert "credential_hash" not in status.text
    assert (
        await client.post(f"/v1/apple-sync/devices/{device_id}/revoke")
    ).status_code == 200
    assert (await client.get("/v1/bridge/status", headers=headers)).status_code == 401
