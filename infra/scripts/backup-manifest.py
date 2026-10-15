#!/usr/bin/env python3
"""Hash backup files without embedding credentials or media in the manifest."""
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

directory = Path(sys.argv[1]).resolve()
files = []
for path in sorted(directory.rglob("*")):
    if not path.is_file() or path.name == "manifest.json":
        continue
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    files.append({"path": str(path.relative_to(directory)), "bytes": path.stat().st_size,
                  "sha256": digest.hexdigest()})
(directory / "manifest.json").write_text(json.dumps({
    "created_at": datetime.now(UTC).isoformat(), "format": "photointel-backup-v1",
    "database_contains_embeddings": True,
    "object_storage_included": False, "files": files,
}, indent=2) + "\n")
