#!/usr/bin/env python3
"""Measure local private-media buffering versus streaming using a synthetic JPEG.

No private photo, cloud API or billing is used. The measurements describe Python
allocation and bytes read through a local adapter, not Cloud Run/R2 or cellular.
"""

import argparse
import gc
import io
import json
import random
import tempfile
import time
import tracemalloc
from hashlib import sha256
from pathlib import Path
from typing import Any

from photointel.storage import STREAM_CHUNK_BYTES, LocalStorage
from PIL import Image


def measure(
    storage: LocalStorage, key: str, streaming: bool, repeats: int
) -> dict[str, Any]:
    gc.collect()
    tracemalloc.start()
    begin = time.perf_counter()
    total = 0
    for _ in range(repeats):
        digest = sha256()
        if streaming:
            stream = storage.open_stream(key)
            for chunk in stream.chunks():
                total += len(chunk)
                digest.update(chunk)
        else:
            data = storage.get(key)
            total += len(data)
            digest.update(data)
            del data
    elapsed = time.perf_counter() - begin
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {
        "requests": repeats,
        "bytes_read": total,
        "peak_python_allocated_bytes": peak,
        "wall_seconds": elapsed,
        "last_sha256": digest.hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--requests", type=int, default=10)
    args = parser.parse_args()
    if not 1 <= args.requests <= 100:
        parser.error("--requests must be between 1 and 100")
    rng = random.Random(20261018)
    image = Image.frombytes("RGB", (1920, 1080), rng.randbytes(1920 * 1080 * 3))
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=85)
    data = encoded.getvalue()
    with tempfile.TemporaryDirectory(prefix="photointel-media-benchmark-") as directory:
        storage = LocalStorage(Path(directory))
        key = "assets/synthetic-preview.jpg"
        storage.put(key, data, "image/jpeg")
        buffered = measure(storage, key, False, args.requests)
        streamed = measure(storage, key, True, args.requests)
        assert (
            buffered["last_sha256"] == streamed["last_sha256"] == sha256(data).hexdigest()
        )
    report = {
        "schema_version": 1,
        "dataset": "procedural synthetic JPEG, 1920x1080, quality=85",
        "source_bytes": len(data),
        "adapter": "LocalStorage; no live R2, Google Cloud or cellular measurement",
        "stream_chunk_bytes": STREAM_CHUNK_BYTES,
        "buffered": buffered,
        "streamed": streamed,
        "cache_policy": "private, no-store; repeat-scroll bandwidth is not reduced",
        "limitations": [
            "Sequential local filesystem, no network concurrency or provider latency",
            "tracemalloc reports Python allocations, not total process RSS",
            "Object request counts are adapter calls, not measured R2 invoices",
            "Conditional response avoidance is covered by HTTP regression tests",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {"source_bytes": len(data), "buffered": buffered, "streamed": streamed}
        )
    )


if __name__ == "__main__":
    main()
