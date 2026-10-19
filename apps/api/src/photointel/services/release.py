"""Public-to-authorized-admin provenance, with an explicit safe-field allowlist.

A release manifest identifies artifacts; it is never evidence that cloud or device
validation happened. Test references are accepted only for this exact Git SHA.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from photointel import __version__

_SHA = re.compile(r"^[0-9a-f]{40}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_.:/@+ -]{1,200}$")
_REFERENCE = re.compile(
    r"^(?:https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(?:/[A-Za-z0-9_./-]*)?|[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)$"
)


def _text(value: Any, pattern: re.Pattern[str] = _TOKEN) -> str | None:
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def get_release_manifest() -> dict[str, Any]:
    """Read a small non-secret manifest and discard unexpected or malformed fields."""
    source: dict[str, Any] = {}
    path = Path(os.getenv("PHOTOINTEL_RELEASE_MANIFEST", "/app/release-manifest.json"))
    try:
        if path.stat().st_size <= 65_536:
            value = json.loads(path.read_text())
            if isinstance(value, dict):
                source = value
    except (OSError, ValueError):
        pass  # Missing provenance is reported as unidentified, never as verified.
    sha = _text(source.get("git_sha") or os.getenv("RELEASE_GIT_SHA"), _SHA)
    models = source.get("models", {})
    models = models if isinstance(models, dict) else {}
    dirty = source.get("provenance_status") == "dirty"
    checks: list[dict[str, str]] = []
    raw_checks = source.get("test_results", [])
    for check in raw_checks[:100] if isinstance(raw_checks, list) else []:
        if not isinstance(check, dict) or check.get("git_sha") != sha or not sha or dirty:
            continue
        reference = _text(check.get("reference"), _REFERENCE)
        name = _text(check.get("name"))
        if reference and name and check.get("status") in {"passed", "failed", "not_run"}:
            checks.append(
                {
                    "name": name,
                    "status": check["status"],
                    "reference": reference,
                    "git_sha": sha,
                }
            )
    runs = source.get("ci_run_ids", [])
    return {
        "manifest_version": 1,
        "git_sha": sha,
        "branch": _text(source.get("branch") or os.getenv("RELEASE_BRANCH")),
        "build_timestamp": _text(source.get("build_timestamp")),
        "container_digest": _text(source.get("container_digest"), _DIGEST),
        "frontend_release_id": _text(source.get("frontend_release_id")),
        "api_version": __version__,
        "database_migration_head": _text(source.get("database_migration_head")),
        "models": {
            key: {"revision": _text((models.get(key) or {}).get("revision"), _SHA)}
            for key in ("joytag", "siglip2")
            if isinstance(models.get(key, {}), dict)
        },
        "modal_deployment_id": _text(source.get("modal_deployment_id")),
        "infrastructure_hash": _text(
            source.get("infrastructure_hash"), re.compile(r"^[0-9a-f]{64}$")
        ),
        "ci_run_ids": [
            str(run)
            for run in runs[:100]
            if isinstance(run, (int, str)) and str(run).isdigit()
        ]
        if isinstance(runs, list)
        else [],
        "test_results": checks,
        "provenance_status": "dirty"
        if dirty
        else "identified"
        if sha
        else "unidentified",
        "validation_status": "referenced" if checks else "unverified",
        "notice": (
            "Referências de testes pertencem somente a este SHA; "
            "integrações exigem gates próprios."
        ),
    }
