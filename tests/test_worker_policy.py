"""Worker safety and real image processing policies without external accounts."""

import hashlib
import io
import json
import math
import os
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
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
from PIL import Image
from PIL.TiffImagePlugin import IFDRational


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


def test_real_heif_roundtrip_preserves_source_and_generates_private_variants(
    tmp_path: Path,
) -> None:
    path = tmp_path / "synthetic-oriented.heic"
    image = Image.new("RGB", (192, 96), (230, 40, 20))
    image.paste((20, 40, 230), (96, 0, 192, 96))
    exif = Image.Exif()
    exif[274] = 6
    exif[272] = "Synthetic HEIF fixture"
    exif[34853] = {
        1: "N",
        2: (IFDRational(23), IFDRational(30), IFDRational(0)),
        3: "W",
        4: (IFDRational(46), IFDRational(37), IFDRational(0)),
    }
    # The media module registers the real pillow-heif encoder and decoder.
    # A missing codec must fail this regression rather than skip required HEIF support.
    # pillow-heif reads orientation from EXIF bytes before encoding its HEIF rotation.
    # Passing an Image.Exif object bypasses that extraction in the pinned plugin.
    image.save(path, format="HEIF", quality=95, exif=exif.tobytes())
    source_bytes = path.read_bytes()
    with Image.open(path) as encoded:
        encoded.load()
        assert encoded.format == "HEIF"
        assert encoded.size == (96, 192)
        assert encoded.info["original_orientation"] == 6
        assert encoded.getexif().get(274) == 1

    settings = Settings(
        thumbnail_small_size=32,
        thumbnail_medium_size=64,
        preview_large_size=128,
        inference_input_size=128,
    )
    result = decode_media(path, settings)

    assert (result.width, result.height) == (96, 192)
    assert result.metadata["camera"] == "Synthetic HEIF fixture"
    assert result.metadata["latitude"] == pytest.approx(23.5)
    assert result.metadata["longitude"] == pytest.approx(-(46 + 37 / 60))
    expected_dimensions = {
        "thumbnail_small": (16, 32),
        "thumbnail_medium": (32, 64),
        "preview_large": (64, 128),
        "inference_input": (64, 128),
    }
    assert {variant.variant for variant in result.variants} == set(expected_dimensions)
    assert len(result.variants) == 4
    for variant in result.variants:
        assert (variant.width, variant.height) == expected_dimensions[variant.variant]
        with Image.open(io.BytesIO(variant.data)) as derived:
            derived.load()
            assert derived.size == (variant.width, variant.height)
            assert derived.height == derived.width * 2
            assert len(derived.getexif()) == 0
            assert derived.format in {"WEBP", "JPEG"}
            # EXIF rotation must happen once: source left/right becomes top/bottom.
            rgb = derived.convert("RGB")
            top = rgb.getpixel((derived.width // 2, derived.height // 4))
            bottom = rgb.getpixel(
                (derived.width // 2, derived.height * 3 // 4),
            )
            assert top[0] > top[2] + 100
            assert bottom[2] > bottom[0] + 100

    assert result.sha256 == hashlib.sha256(source_bytes).hexdigest()
    assert len(result.phash) == 16
    assert int(result.phash, 16) >= 0
    assert result.quality["resolution"] == 96 * 192
    assert result.quality["file_bytes"] == len(source_bytes)
    for metric in ("brightness", "contrast", "sharpness", "score"):
        assert math.isfinite(result.quality[metric])
    assert 0 <= result.quality["brightness"] <= 1
    assert 0 <= result.quality["contrast"] <= 1
    assert result.quality["heuristic"] is True
    assert path.read_bytes() == source_bytes


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
    asset = Asset(
        library_id=uuid4(),
        source_asset_key="x",
        filename="x.jpg",
        source_metadata={
            "fixture": True,
            "cache_relative_path": "../../private.jpg",
        },
    )
    with pytest.raises(AppError):
        source_path(asset, settings)


def test_cookies_never_imply_valid_session(tmp_path: Path) -> None:
    settings = Settings(
        icloud_enabled=True,
        icloud_account="fixture@example.invalid",
        icloud_session_directory=tmp_path,
    )
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
    assert revision_hash({"id": "a", "size": 10}) == revision_hash(
        {
            "size": 10,
            "id": "a",
        }
    )
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
    settings = Settings(
        icloud_enabled=True,
        icloud_account="first@example.invalid",
        icloud_session_directory=tmp_path,
    )
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
