#!/usr/bin/env python3
"""Generate non-secret, commit-bound provenance without deploying or spending."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import tomllib
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def git(*arguments: str) -> str:
    return subprocess.check_output(["git", *arguments], cwd=ROOT, text=True).strip()


def migration_head() -> str:
    revisions: set[str] = set()
    parents: set[str] = set()
    for path in (ROOT / "infra/migrations/versions").glob("*.py"):
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                names = [item.id for item in node.targets if isinstance(item, ast.Name)]
                if "revision" in names and isinstance(node.value.value, str):
                    revisions.add(node.value.value)
                if "down_revision" in names and isinstance(node.value.value, str):
                    parents.add(node.value.value)
    heads = revisions - parents
    if len(heads) != 1:
        raise ValueError("Expected one Alembic migration head")
    return heads.pop()


def build(args: argparse.Namespace) -> dict:
    sha = git("rev-parse", "HEAD")
    if git("status", "--porcelain") and not args.allow_dirty:
        raise ValueError(
            "Working tree is dirty; commit changes before creating release evidence"
        )
    if args.container_digest and not re.fullmatch(
        r"sha256:[0-9a-f]{64}", args.container_digest
    ):
        raise ValueError("Expected an immutable sha256 container digest")
    files = sorted(
        ROOT / name
        for name in git("ls-files", "infra").splitlines()
        if (ROOT / name).is_file() and ".env" not in Path(name).name
    )
    digest = hashlib.sha256()
    for path in files:
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    checks = json.loads(args.test_results.read_text()) if args.test_results else []
    if not isinstance(checks, list) or any(
        not isinstance(check, dict) or check.get("git_sha") != sha for check in checks
    ):
        raise ValueError("Every test result must reference this exact Git SHA")
    # Evidence inputs contain only references, never arbitrary report payloads.
    allowed = {"git_sha", "name", "status", "reference"}
    if any(set(check) - allowed for check in checks):
        raise ValueError("Test references contain unexpected fields")
    for check in checks:
        if check.get("status") not in {"passed", "failed", "not_run"}:
            raise ValueError("Invalid test status")
        if not isinstance(check.get("reference"), str) or not re.fullmatch(
            r"(?:https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(?:/[A-Za-z0-9_./-]*)?|[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)",
            check["reference"],
        ):
            raise ValueError(
                "Evidence must be a safe report path or GitHub Actions run reference"
            )
    pins = json.loads((ROOT / "packages/configuration/model-pins.json").read_text())
    version = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
    return {
        "manifest_version": 1,
        "git_sha": sha,
        "branch": git("branch", "--show-current") or None,
        "build_timestamp": datetime.now(UTC).isoformat(),
        "container_digest": args.container_digest,
        "frontend_release_id": args.frontend_release_id or sha,
        "api_version": version,
        "database_migration_head": migration_head(),
        "models": {
            key: {"model_id": pins[key]["model_id"], "revision": pins[key]["revision"]}
            for key in ("joytag", "siglip2")
        },
        "modal_deployment_id": args.modal_deployment_id,
        "infrastructure_hash": digest.hexdigest(),
        "ci_run_ids": args.ci_run_id,
        "test_results": checks,
        "provenance_status": "dirty" if args.allow_dirty else "identified",
        "validation_status": "referenced" if checks else "unverified",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path("reports/release-manifest.json")
    )
    parser.add_argument("--container-digest")
    parser.add_argument("--frontend-release-id")
    parser.add_argument("--modal-deployment-id")
    parser.add_argument("--ci-run-id", action="append", default=[])
    parser.add_argument("--test-results", type=Path)
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Local diagnostics only; does not establish release provenance",
    )
    args = parser.parse_args()
    try:
        manifest = build(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(2, f"Release manifest rejected: {error}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(
        f"Manifest generated for {manifest['git_sha']} ({manifest['validation_status']})"
    )


if __name__ == "__main__":
    main()
