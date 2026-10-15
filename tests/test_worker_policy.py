"""Worker safety and real image processing policies without external accounts."""

import io
import json
import os
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image

from photointel.config import Settings
from photointel.errors import AppError
from photointel.models import Asset, utcnow
from photointel.services.duplicates import hash_distance
from photointel.services.identity import revision_hash
from photointel.services.ingestion import (
    ICloudAdapter,
    authentication_state,
    classify_icloud_failure,
    record_authentication,
)
from photointel.services.jobs import retry_delay
from photointel.services.media import decode_media, source_path


def test_real_decode_normalizes_orientation_and_strips_exif(tmp_path: Path) -> None:
    path = tmp_path / "oriented.jpg"
    image = Image.new("RGB", (80, 40), "green")
    exif = Image.Exif()
    exif[274] = 6
    exif[272] = "Fixture camera"
    image.save(path, exif=exif)
    result = decode_media(path, Settings())
    assert (result.width, result.height) == (40, 80)
    assert result.metadata["camera"] == "Fixture camera"
    assert len(result.variants) == 4
    for variant in result.variants:
        decoded = Image.open(io.BytesIO(variant.data))
        assert len(decoded.getexif()) == 0
        assert decoded.height / decoded.width == 2
    assert len(result.sha256) == 64
    assert len(result.phash) == 16
    assert 0 <= result.quality["brightness"] <= 1
    assert result.quality["heuristic"] is True


def test_corrupt_or_oversized_images_fail_explicitly(tmp_path: Path) -> None:
    path = tmp_path / "bad.jpg"
    path.write_bytes(b"not a photograph")
    with pytest.raises(AppError, match="inválida"):
        decode_media(path, Settings())
    path.write_bytes(b"x" * 2048)
    with pytest.raises(AppError, match="excede limite"):
        decode_media(path, Settings(media_max_bytes=1024))


def test_source_manifest_cannot_escape_processing_root(tmp_path: Path) -> None:
    settings = Settings(temp_directory=tmp_path / "processing")
    private = tmp_path / "private.jpg"
    private.write_bytes(b"private")
    asset = Asset(library_id=uuid4(), source_asset_key="x", filename="x.jpg",
                  source_metadata={
                      "fixture": True, "cache_relative_path": "../../private.jpg",
                  })
    with pytest.raises(AppError):
        source_path(asset, settings)


def test_cookies_never_imply_valid_session(tmp_path: Path) -> None:
    settings = Settings(icloud_enabled=True, icloud_account="fixture@example.invalid",
                        icloud_session_directory=tmp_path)
    (tmp_path / "cookies").write_text("exists")
    assert authentication_state(settings)["valid"] is False
    record_authentication(settings, "valid", "Online verification succeeded")
    assert authentication_state(settings)["valid"] is True
    report = tmp_path / "photointel-auth-state.json"
    data = json.loads(report.read_text())
    data["checked_at"] = (utcnow() - timedelta(hours=2)).isoformat()
    report.write_text(json.dumps(data))
    assert authentication_state(settings)["valid"] is False
    assert os.stat(tmp_path).st_mode & 0o777 == 0o700


def test_duplicate_similarity_does_not_define_identity() -> None:
    assert hash_distance("0000000000000000", "0000000000000003") == 2
    with pytest.raises(ValueError):
        hash_distance("ffff", "0000")
    assert revision_hash({"id": "a", "size": 10}) == revision_hash({
        "size": 10, "id": "a",
    })
    assert revision_hash({"id": "a"}) != revision_hash({"id": "b"})
    assert retry_delay(1).total_seconds() == 5
    assert retry_delay(100).total_seconds() == 3600


def test_download_stream_enforces_advertised_and_actual_size(tmp_path: Path) -> None:
    settings = Settings(max_download_bytes=1024)
    adapter = ICloudAdapter(settings)
    adapter.client = SimpleNamespace(session=object())

    class Response:
        status_code = 200
        headers: dict[str, str] = {}

        def raise_for_status(self) -> None:
            pass

        def iter_content(self, chunk_size: int) -> list[bytes]:
            return [b"x" * 512, b"x" * 512, b"x"]

        def close(self) -> None:
            pass

    photo = SimpleNamespace(download=lambda *args, **kwargs: Response())
    version = SimpleNamespace(size=1024, url="https://private.invalid/not-logged")
    with pytest.raises(AppError, match="tamanho autorizado"):
        adapter.download(photo, version, tmp_path / "download.image")
    assert not (tmp_path / "download.image").exists()
    assert (tmp_path / "download.part").stat().st_size <= 1024


def test_error_taxonomy_does_not_return_private_exception() -> None:
    assert classify_icloud_failure("authentication failed")[0] == "ICLOUD_AUTH_EXPIRED"
    code, message = classify_icloud_failure(
        "https://signed.invalid/?secret=do-not-expose",
    )
    assert code == "ICLOUD_ACCESS_DENIED"
    assert "secret" not in message


def test_pending_jobs_skip_superseded_input_revisions() -> None:
    from photointel.services.worker import superseded_reason
    assert superseded_reason({}, "c2", "r2") is None
    assert superseded_reason({"content_revision": "c2"}, "c2", "r2") is None
    assert superseded_reason({"content_revision": "c1"}, "c2", "r2") == (
        "superseded_content_revision"
    )
    assert superseded_reason({"representation_revision": "r1"}, "c2", "r2") == (
        "superseded_representation_revision"
    )


def test_auth_proof_is_scoped_to_account_and_library(tmp_path: Path) -> None:
    settings = Settings(icloud_enabled=True, icloud_account="first@example.invalid",
                        icloud_session_directory=tmp_path)
    record_authentication(settings, "valid", "Online check")
    assert authentication_state(settings)["valid"] is True
    other = settings.model_copy(update={"icloud_account": "other@example.invalid"})
    assert authentication_state(other)["valid"] is False
    other = settings.model_copy(update={"icloud_library": "OtherLibrary"})
    assert authentication_state(other)["valid"] is False


def test_resume_rejects_wrong_range_before_appending(tmp_path: Path) -> None:
    settings = Settings(max_download_bytes=1024)
    adapter = ICloudAdapter(settings)
    adapter.client = SimpleNamespace(session=object())
    partial = tmp_path / "download.part"
    partial.write_bytes(b"x" * 512)

    class Response:
        status_code = 206
        headers = {"Content-Range": "bytes 0-511/1024", "Content-Length": "512"}

        def raise_for_status(self) -> None:
            pass

        def iter_content(self, chunk_size: int) -> list[bytes]:
            raise AssertionError("Invalid range must be rejected before reading payload")

        def close(self) -> None:
            pass

    photo = SimpleNamespace(download=lambda *args, **kwargs: Response())
    version = SimpleNamespace(size=1024, url="https://private.invalid/not-logged")
    with pytest.raises(AppError, match="não corresponde"):
        adapter.download(photo, version, tmp_path / "download.image")
    assert partial.read_bytes() == b"x" * 512
    assert not (tmp_path / "download.image").exists()
