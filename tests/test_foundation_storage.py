"""Private storage has bounded reads and never accepts arbitrary filesystem paths."""

import io
import stat
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.response import StreamingBody
from photointel.errors import AppError
from photointel.storage import LocalStorage, S3Storage, object_key, validate_key


@pytest.mark.parametrize(
    "key",
    [
        "../secret",
        "/etc/passwd",
        "assets/../secret",
        "assets//photo",
        "a/./b",
        "a\\b",
        "",
        "a\x00b",
        "http://evil.invalid/photo",
        "a\nb",
        "a?signature=secret",
        "a/%2e%2e/b",
    ],
)
def test_invalid_keys_are_rejected(key: str) -> None:
    with pytest.raises(AppError):
        validate_key(key)


def test_deterministic_resource_keys_are_revision_specific() -> None:
    asset_id = str(uuid4())
    first = object_key(asset_id, "revision-1", "thumbnail_medium")
    assert first == object_key(asset_id, "revision-1", "thumbnail_medium")
    assert first != object_key(asset_id, "revision-2", "thumbnail_medium")
    assert first != object_key(str(uuid4()), "revision-1", "thumbnail_medium")
    assert "revision-1" not in first
    with pytest.raises(AppError):
        object_key(asset_id, "revision", "original")


@pytest.mark.parametrize("variant", [
    "thumbnail_small", "thumbnail_medium", "preview_large",
])
def test_avif_derivatives_use_safe_immutable_object_keys(variant: str) -> None:
    asset_id = str(uuid4())
    webp_key = object_key(asset_id, "revision:hash", variant, "webp")
    avif_key = object_key(asset_id, "revision:hash", variant + "_avif", "avif")
    assert avif_key.endswith(f"/{variant}_avif.avif")
    assert avif_key != webp_key
    assert avif_key == object_key(asset_id, "revision:hash", variant + "_avif", "avif")
    assert "revision:hash" not in avif_key
    for bad in [
        (variant, "avif"), (variant + "_avif", "webp"),
        ("inference_input_avif", "avif"), ("../thumbnail_medium_avif", "avif"),
        ("thumbnail_medium_avif", "svg"),
    ]:
        with pytest.raises(AppError):
            object_key(asset_id, "revision:hash", *bad)


def test_local_storage_round_trip_is_private_and_atomic(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    key = object_key(str(uuid4()), "r1", "thumbnail_small")
    storage.put(key, b"private-thumbnail", "image/webp")
    assert storage.get(key) == b"private-thumbnail"
    assert storage.exists(key)
    assert stat.S_IMODE((tmp_path / key).stat().st_mode) == 0o600
    storage.put(key, b"updated-thumbnail", "image/webp")
    assert storage.get(key) == b"updated-thumbnail"
    assert len(list((tmp_path / key).parent.iterdir())) == 1
    storage.delete(key)
    storage.delete(key)  # temporary cleanup is idempotent
    assert not storage.exists(key)
    with pytest.raises(AppError) as caught:
        storage.get(key)
    assert caught.value.status_code == 404


def test_local_symlink_escape_is_rejected(tmp_path: Path) -> None:
    root, private = tmp_path / "objects", tmp_path / "private"
    private.mkdir()
    (private / "secret").write_bytes(b"secret")
    storage = LocalStorage(root)
    (root / "escape").symlink_to(private, target_is_directory=True)
    with pytest.raises(AppError) as caught:
        storage.get("escape/secret")
    assert caught.value.status_code == 403
    with pytest.raises(AppError):
        storage.put("escape/new-file", b"bad", "image/webp")
    assert not (private / "new-file").exists()


def test_local_storage_has_no_public_media_url(tmp_path: Path) -> None:
    with pytest.raises(AppError) as caught:
        LocalStorage(tmp_path).presign_get("assets/private.webp")
    assert caught.value.status_code == 503


def s3_storage() -> S3Storage:
    storage = S3Storage.__new__(S3Storage)
    storage.bucket = "private-unit-bucket"
    storage.max_read_bytes = 16
    storage.client = Mock()
    return storage


def test_s3_upload_does_not_set_public_acl() -> None:
    storage = s3_storage()
    storage.put("assets/test.webp", b"private", "image/webp")
    arguments = storage.client.put_object.call_args.kwargs
    assert "ACL" not in arguments
    assert arguments["Bucket"] == "private-unit-bucket"
    assert arguments["CacheControl"] == "private, no-store"


@pytest.mark.parametrize("advertised", [False, True])
def test_s3_response_limits_close_streams(advertised: bool) -> None:
    storage = s3_storage()
    raw = io.BytesIO(b"x" * 32)
    response = {"Body": StreamingBody(raw, 32)}
    if advertised:
        response["ContentLength"] = 32
    storage.client.get_object.return_value = response
    with pytest.raises(AppError) as caught:
        storage.get("assets/private.webp")
    assert caught.value.status_code == 503
    assert raw.closed


def test_s3_signed_urls_are_short_lived() -> None:
    storage = s3_storage()
    storage.client.generate_presigned_url.return_value = "https://private.invalid/scoped"
    assert storage.presign_get("assets/test.webp", 60).startswith("https://")
    assert storage.client.generate_presigned_url.call_args.kwargs["ExpiresIn"] == 60
    with pytest.raises(AppError):
        storage.presign_get("assets/test.webp", 86400)


def test_s3_provider_errors_are_safe_public_errors() -> None:
    storage = s3_storage()
    storage.client.get_object.side_effect = EndpointConnectionError(
        endpoint_url="https://private.invalid/?token=provider-secret",
    )
    with pytest.raises(AppError) as caught:
        storage.get("assets/test.webp")
    assert caught.value.code == "STORAGE_UNAVAILABLE"
    assert "provider-secret" not in caught.value.message
    storage.client.get_object.side_effect = ClientError(
        {"Error": {"Code": "NoSuchKey"}},
        "GetObject",
    )
    with pytest.raises(AppError) as caught:
        storage.get("assets/test.webp")
    assert caught.value.status_code == 404
