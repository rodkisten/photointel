"""Revision-bound, atomic local cache completion records.

Apple's representation checksum is opaque: it is a revision discriminator only,
never compared with a SHA-256 digest unless the upstream semantics are verified.
"""

import json
import os
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

CACHE_VERSION = 1


def cache_binding(version: Any, target: Path) -> dict[str, Any]:
    return {
        "manifest_version": CACHE_VERSION,
        "representation_revision": sha256(
            json.dumps(
                [
                    str(target.name),
                    int(version.size),
                    str(getattr(version, "checksum", "")),
                ],
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
        "expected_size": int(version.size),
    }


def digest_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for data in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def marker_path(path: Path) -> Path:
    return path.with_name(path.name + ".manifest.json")


def _read(path: Path) -> dict[str, Any]:
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return {}
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(payload, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def completed_cache_valid(target: Path, binding: dict[str, Any]) -> bool:
    record = _read(marker_path(target))
    if (
        target.is_symlink()
        or not target.is_file()
        or any(record.get(key) != value for key, value in binding.items())
        or record.get("completed") is not True
    ):
        return False
    return target.stat().st_size == binding["expected_size"] and digest_file(
        target
    ) == record.get("sha256")


def partial_offset(partial: Path, binding: dict[str, Any]) -> int:
    record = _read(marker_path(partial))
    if partial.is_symlink() or not partial.is_file():
        return 0
    # Unbound legacy partials are not resumed. A fresh 200 response can safely
    # replace them; an unsolicited 206 must be rejected by the caller.
    if any(record.get(key) != value for key, value in binding.items()):
        return 0
    size = partial.stat().st_size
    if (
        record.get("completed") is not False
        or record.get("partial_bytes") != size
        or record.get("partial_sha256") != digest_file(partial)
    ):
        return 0
    return size


def write_partial_marker(partial: Path, binding: dict[str, Any]) -> None:
    _write(
        marker_path(partial),
        {
            **binding,
            "completed": False,
            "partial_bytes": partial.stat().st_size if partial.is_file() else 0,
            "partial_sha256": digest_file(partial)
            if partial.is_file()
            else sha256(b"").hexdigest(),
        },
    )


def complete_download(partial: Path, target: Path, binding: dict[str, Any]) -> None:
    digest = digest_file(partial)
    os.replace(partial, target)
    os.chmod(target, 0o600)
    _write(marker_path(target), {**binding, "completed": True, "sha256": digest})
    marker_path(partial).unlink(missing_ok=True)


def record_cache_incident(target: Path, binding: dict[str, Any]) -> dict[str, Any]:
    """Keep bounded forensic metadata; never signed URLs or image bytes."""
    record = _read(marker_path(target))
    actual_digest = (
        digest_file(target) if target.is_file() and not target.is_symlink() else None
    )
    incident = {
        "code": "CACHE_INTEGRITY_FAILED",
        "detected_at": datetime.now(UTC).isoformat(),
        "expected_sha256": record.get("sha256"),
        "actual_sha256": actual_digest,
        "representation_revision": binding["representation_revision"],
    }
    path = target.with_name(target.name + ".incidents.json")
    history = _read(path).get("incidents", [])
    history = history if isinstance(history, list) else []
    _write(path, {"incidents": [*history[-9:], incident]})
    return incident
