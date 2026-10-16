"""Redistributable procedural artwork: local fixtures, never private photographs."""

from pathlib import Path

from PIL import Image, ImageDraw


def generate_fixtures(directory: Path, count: int = 12) -> Path:
    if not 1 <= count <= 1000:
        raise ValueError("Fixture generation is bounded to 1000 images")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for number in range(count):
        target = directory / f"fixture-{number:03d}.jpg"
        if target.exists():
            continue
        image = Image.new("RGB", (960, 720), (12 + number * 13 % 90, 25, 40))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 430, 960, 720), fill=(40, 80 + number * 8 % 150, 90))
        draw.ellipse((620, 60, 790, 230), fill=(245, 192, 98))
        draw.polygon([(0, 440), (260, 170 + number * 5), (520, 440)], fill=(90, 110, 155))
        draw.polygon([(340, 440), (680, 240), (960, 440)], fill=(67, 90, 120))
        draw.text((32, 660), f"Photo Intelligence / fixture {number:03d}", fill="white")
        image.save(target, "JPEG", quality=90)
    # Keep the duplicate inside the requested bounded initial import.
    if count >= 4:
        duplicate = directory / f"fixture-{count - 1:03d}.jpg"
        duplicate.write_bytes((directory / "fixture-000.jpg").read_bytes())
    return directory
