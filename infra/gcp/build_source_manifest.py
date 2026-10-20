"""Identify repository-trigger builds without requiring .git in the source export.

Cloud Build supplies the immutable source commit. This is provenance only: no
test/cloud gate is marked passed, and deployment is a separate operator action.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import tomllib
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def build(root: Path, sha: str, branch: str, build_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("A repository trigger must supply a full COMMIT_SHA")
    if branch and not re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", branch):
        raise ValueError("Invalid source branch")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", build_id):
        raise ValueError("Invalid Cloud Build ID")
    spec = importlib.util.spec_from_file_location(
        "release_source", root / "infra/scripts/release-manifest.py"
    )
    assert spec and spec.loader
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    release.ROOT = root
    digest = hashlib.sha256()
    # Only source files; never read local configuration/state/keys for provenance.
    for path in sorted((root / "infra").rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or not path.is_file():
            continue
        if any(part in {"__pycache__", "rendered", "state"} for part in path.parts):
            continue
        if path.suffix not in {".py", ".sh", ".yaml", ".yml", ".Dockerfile"}:
            continue
        digest.update(relative.encode() + b"\0" + path.read_bytes())
    pins = json.loads((root / "packages/configuration/model-pins.json").read_text())
    return {
        "manifest_version": 1,
        "git_sha": sha,
        "branch": branch or None,
        "build_timestamp": datetime.now(UTC).isoformat(),
        "build_provider": "google-cloud-build",
        "build_id": build_id,
        "container_digest": None,  # Assigned by the registry after the image push.
        "frontend_release_id": None,  # This pipeline builds only the backend.
        "api_version": tomllib.loads((root / "pyproject.toml").read_text())["project"][
            "version"
        ],
        "database_migration_head": release.migration_head(),
        "models": {
            key: {"model_id": pins[key]["model_id"], "revision": pins[key]["revision"]}
            for key in ("joytag", "siglip2")
        },
        "modal_deployment_id": None,
        "infrastructure_hash": digest.hexdigest(),
        "ci_run_ids": [],
        "test_results": [],
        "provenance_status": "identified",
        "validation_status": "unverified",
    }


def main() -> None:
    path = ROOT / "release-manifest.json"
    if path.exists():
        raise SystemExit("Refusing to overwrite an existing release manifest")
    try:
        manifest = build(
            ROOT,
            os.environ.get("SOURCE_GIT_SHA", ""),
            os.environ.get("SOURCE_BRANCH", ""),
            os.environ.get("SOURCE_BUILD_ID", ""),
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Identified source {manifest['git_sha']}; external gates remain unverified")


if __name__ == "__main__":
    main()
