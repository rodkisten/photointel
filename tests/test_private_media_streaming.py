"""Streaming keeps memory bounded, closes streams, and honors authorized revisions."""

import io
from pathlib import Path
from unittest.mock import Mock

import pytest
from botocore.response import StreamingBody
from photointel.errors import AppError
from photointel.services.media_http import matches_etag, media_etag, parse_range
from photointel.storage import STREAM_CHUNK_BYTES, LocalStorage, ObjectStream, S3Storage


class RecordingBody(io.BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)


def test_full_and_ranged_local_streams_are_bounded_and_closed(tmp_path: Path) -> None:
    data = b"a" * (STREAM_CHUNK_BYTES * 3 + 7)
    storage = LocalStorage(tmp_path)
    storage.put("assets/private.webp", data, "image/webp")
    stream = storage.open_stream("assets/private.webp")
    chunks = list(stream.chunks())
    assert b"".join(chunks) == data
    assert max(map(len, chunks)) == STREAM_CHUNK_BYTES
    assert stream.body.closed
    partial = storage.open_stream("assets/private.webp", (12, 20))
    assert partial.length == 9
    assert b"".join(partial.chunks()) == data[12:21]
    assert partial.body.closed


def test_client_cancellation_closes_object_body() -> None:
    body = RecordingBody(b"x" * STREAM_CHUNK_BYTES * 10)
    iterator = ObjectStream(body, STREAM_CHUNK_BYTES * 10).chunks()
    assert len(next(iterator)) == STREAM_CHUNK_BYTES
    iterator.close()
    assert body.closed
    assert body.read_sizes == [STREAM_CHUNK_BYTES]


def test_truncated_stream_closes_and_raises_instead_of_silent_success() -> None:
    body = RecordingBody(b"truncated")
    with pytest.raises(AppError):
        list(ObjectStream(body, 500).chunks())
    assert body.closed


def s3() -> S3Storage:
    storage = S3Storage.__new__(S3Storage)
    storage.bucket = "unit-private"
    storage.max_read_bytes = 2 * 1024 * 1024
    storage.client = Mock()
    return storage


def test_s3_does_not_read_until_response_iteration_and_passes_exact_range() -> None:
    storage = s3()
    body = RecordingBody(b"private")
    storage.client.get_object.return_value = {
        "Body": StreamingBody(body, 7),
        "ContentLength": 7,
        "ContentRange": "bytes 20-26/100",
    }
    stream = storage.open_stream("assets/private.webp", (20, 26))
    assert body.read_sizes == []
    assert storage.client.get_object.call_args.kwargs == {
        "Bucket": "unit-private",
        "Key": "assets/private.webp",
        "Range": "bytes=20-26",
    }
    assert b"".join(stream.chunks()) == b"private"
    assert body.closed
    assert body.read_sizes == [7]


def test_s3_provider_cannot_silently_ignore_range_or_omit_size() -> None:
    storage = s3()
    for response in [
        {"ContentLength": 7},
        {"ContentLength": 7, "ContentRange": "bytes 0-6/100"},
        {},
        {"ContentLength": 10_000_000},
    ]:
        body = RecordingBody(b"private")
        storage.client.get_object.return_value = {"Body": body, **response}
        with pytest.raises(AppError):
            storage.open_stream("assets/private.webp", (20, 26))
        assert body.closed
        assert body.read_sizes == []


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, None),
        ("bytes=0-9", (0, 9)),
        ("bytes=90-999", (90, 99)),
        ("bytes=90-", (90, 99)),
        ("bytes=-10", (90, 99)),
        ("bytes=-1000", (0, 99)),
    ],
)
def test_single_range_is_bounded(header: str | None, expected: object) -> None:
    assert parse_range(header, 100) == expected


@pytest.mark.parametrize(
    "header",
    [
        "bytes=100-",
        "bytes=10-9",
        "bytes=-0",
        "bytes=-",
        "bytes=0-1,5-6",
        "items=0-1",
        "bytes=" + "9" * 500 + "-",
        " bytes=0-10",
    ],
)
def test_invalid_or_multipart_ranges_are_rejected(header: str) -> None:
    with pytest.raises(AppError) as caught:
        parse_range(header, 100)
    assert caught.value.status_code == 416


def test_etags_are_revision_scoped_and_do_not_disclose_object_keys() -> None:
    etag = media_etag("asset-resource-id", "revision-private", "content-hash")
    assert etag != media_etag("asset-resource-id", "new-revision", "content-hash")
    assert "private" not in etag
    assert matches_etag(etag, etag)
    assert matches_etag("*", etag)
    assert matches_etag("W/" + etag, etag)
    assert not matches_etag(None, etag)
    assert not matches_etag('"wrong"', etag)


async def test_media_http_authorizes_before_conditional_and_releases_transaction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from uuid import uuid4

    import httpx
    from fastapi import FastAPI
    from photointel.auth import Identity, require_identity
    from photointel.database import get_session
    from photointel.routers import catalog

    asset_id = uuid4()
    resource = SimpleNamespace(
        id=uuid4(),
        byte_size=12,
        object_key="assets/fixture.webp",
        mime_type="image/webp",
        revision="representation-1",
        sha256="digest",
    )
    session = SimpleNamespace(scalar=AsyncMock(return_value=resource), commit=AsyncMock())
    storage = LocalStorage(tmp_path)
    storage.put(resource.object_key, b"private-body", "image/webp")
    open_stream = storage.open_stream

    def open_after_commit(*args: object) -> ObjectStream:
        assert session.commit.await_count >= 1
        return open_stream(*args)

    monkeypatch.setattr(storage, "open_stream", open_after_commit)
    monkeypatch.setattr(catalog, "get_storage", lambda: storage)
    monkeypatch.setattr(
        catalog,
        "get_asset",
        AsyncMock(
            return_value=SimpleNamespace(
                representation_revision="representation-1",
            )
        ),
    )
    app = FastAPI()
    app.include_router(catalog.router, prefix="/v1")
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[require_identity] = lambda: Identity("test", "test@invalid")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://localhost",
    ) as client:
        url = f"/v1/assets/{asset_id}/media/thumbnail_small"
        full = await client.get(url)
        assert full.status_code == 200
        assert full.content == b"private-body"
        assert full.headers["cache-control"] == "private, no-store"
        etag = full.headers["etag"]
        ranged = await client.get(url, headers={"Range": "bytes=0-6"})
        assert ranged.status_code == 206
        assert ranged.content == b"private"
        assert ranged.headers["content-range"] == "bytes 0-6/12"
        unchanged = await client.get(url, headers={"If-None-Match": etag})
        assert unchanged.status_code == 304
        assert unchanged.content == b""
        assert (await client.get(url, headers={"Range": "bytes=100-"})).status_code == 416
        stale = await client.get(url, headers={"Range": "bytes=0-2", "If-Range": '"old"'})
        assert stale.status_code == 200
        assert stale.content == b"private-body"


async def test_http_disconnect_before_first_chunk_closes_provider() -> None:
    from typing import Any

    from photointel.services.media_http import PrivateStreamingResponse
    from starlette.requests import ClientDisconnect

    body = RecordingBody(b"private")
    response = PrivateStreamingResponse(ObjectStream(body, 7))

    async def send(message: dict[str, Any]) -> None:
        raise OSError("client disconnected")

    async def receive() -> dict[str, str]:
        return {"type": "http.disconnect"}

    with pytest.raises(ClientDisconnect):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert body.closed
    assert body.read_sizes == []
