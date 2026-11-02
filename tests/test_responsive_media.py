"""Responsive media must have fallback renditions and correct MIME/size metadata."""

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from photointel.config import Settings
from photointel.services.media import decode_media


def _sample(tmp_path: Path) -> Path:
    image = Image.new("RGB", (480, 320))
    pixels = image.load()
    assert pixels is not None
    for y in range(320):
        for x in range(480):
            pixels[x, y] = (x % 256, y % 256, (x * 3 + y * 2) % 256)
    path = tmp_path / "sample.png"
    image.save(path, format="PNG")
    return path


def test_all_required_preview_sizes_have_supported_fallbacks(tmp_path: Path) -> None:
    result = decode_media(_sample(tmp_path), Settings(_env_file=None))
    by_name = {item.variant: item for item in result.variants}
    for name, max_edge in {
        "thumbnail_small": 240,
        "thumbnail_medium": 640,
        "preview_large": 1600,
        "inference_input": 512,
    }.items():
        rendition = by_name[name]
        assert rendition.mime in {"image/webp", "image/jpeg"}
        assert rendition.extension in {"webp", "jpg"}
        assert max(rendition.width, rendition.height) <= max_edge
        assert rendition.data
        with Image.open(BytesIO(rendition.data)) as decoded:
            assert decoded.size == (rendition.width, rendition.height)
    assert not any(key.startswith("inference_input_avif") for key in by_name)
    for name, rendition in by_name.items():
        if name.endswith("_avif"):
            assert rendition.mime == "image/avif"
            assert rendition.extension == "avif"
            assert len(rendition.data) < len(
                by_name[name.removesuffix("_avif")].data
            ) * 0.95


def test_missing_avif_encoder_is_nonfatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_save = Image.Image.save

    def fallback(self: Image.Image, fp: object, format: str | None = None, **kwargs):
        if format == "AVIF":
            raise OSError("No AVIF encoder installed")
        return real_save(self, fp, format=format, **kwargs)

    monkeypatch.setattr(Image.Image, "save", fallback)
    result = decode_media(_sample(tmp_path), Settings(_env_file=None))
    assert {item.variant for item in result.variants} == {
        "thumbnail_small", "thumbnail_medium", "preview_large", "inference_input"
    }
