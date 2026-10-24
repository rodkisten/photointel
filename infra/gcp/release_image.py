#!/usr/bin/env python3
"""Read-only Artifact Registry checks for the GitHub Cloud Run release workflow.

Never mutates cloud resources, evaluates shell input, or prints secret values.
All mutable operations remain in manage.py behind explicit authorization flags.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra/gcp/config.local.json"
SHA_PATTERN = re.compile(r"[a-f0-9]{40}")
DIGEST_PATTERN = re.compile(r"sha256:[a-f0-9]{64}")


class ReleaseCheckError(RuntimeError):
    """Fail closed when a cloud prerequisite or image identity cannot be verified."""


def config_for_project(project: str, config_path: Path = CONFIG) -> dict[str, Any]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config["project_id"] != project:
        raise ReleaseCheckError("GitHub project confirmation does not match configuration")
    return config


def gcloud(args: list[str], project: str) -> str:
    command = ["gcloud", *args, "--project", project, "--quiet"]
    result = subprocess.run(
        command, capture_output=True, text=True, timeout=120, check=False
    )
    if result.returncode:
        raise ReleaseCheckError(
            f"gcloud {' '.join(args[:3])} failed: {result.stderr.strip() or 'unknown error'}"
        )
    return result.stdout.strip()


def image_name(config: dict[str, Any]) -> str:
    return (
        f"{config['region']}-docker.pkg.dev/{config['project_id']}/"
        f"{config['repository']}/api"
    )


def parse_release_digest(listing: str, sha: str) -> str | None:
    if not SHA_PATTERN.fullmatch(sha):
        raise ReleaseCheckError("Release requires an exact 40-character Git SHA")
    try:
        entries = json.loads(listing)
    except (ValueError, TypeError) as exc:
        raise ReleaseCheckError("Artifact Registry returned invalid JSON") from exc
    if not isinstance(entries, list):
        raise ReleaseCheckError("Artifact Registry image catalog must be a JSON array")
    matches = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        tags = entry.get("tags")
        if not isinstance(tags, list):
            continue
        if sha not in tags:
            continue
        digest = entry.get("version")
        if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
            raise ReleaseCheckError("Artifact Registry returned an invalid release digest")
        matches.append(digest)
    if len(matches) > 1:
        raise ReleaseCheckError(f"Ambiguous release tag: found {len(matches)} images")
    return matches[0] if matches else None


def lookup_digest(project: str, config: dict[str, Any], sha: str) -> str | None:
    target = image_name(config)
    try:
        listing = gcloud(
            ["artifacts", "docker", "images", "list", target, "--include-tags", "--format=json"],
            project,
        )
    except ReleaseCheckError as exc:
        # A missing image package is expected before the first build. Anything
        # else, including IAM errors, must fail rather than trigger another build.
        error = str(exc).lower()
        if "not_found" in error or "not found" in error or "does not exist" in error:
            return None
        raise
    return parse_release_digest(listing, sha)


def preflight(project: str, config: dict[str, Any]) -> None:
    account = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], project)
    if not account:
        raise ReleaseCheckError("gcloud has no active authenticated account")
    print(f"🔐 Active deploy identity: {account}")

    enabled = gcloud(
        ["services", "list", "--enabled", "--format=value(config.name)"], project
    ).splitlines()
    if "cloudbuild.googleapis.com" not in enabled:
        raise ReleaseCheckError("Cloud Build API is not enabled; run administrative bootstrap")

    bucket = f"gs://{project}-photointel-build-source"
    gcloud(["storage", "buckets", "describe", bucket, "--format=value(name,location)"], project)
    builder = f"photointel-builder@{project}.iam.gserviceaccount.com"
    gcloud(["iam", "service-accounts", "describe", builder, "--format=value(email)"], project)
    registry_format = gcloud(
        [
            "artifacts", "repositories", "describe", config["repository"],
            f"--location={config['region']}", "--format=value(format)",
        ],
        project,
    )
    if registry_format != "DOCKER":
        raise ReleaseCheckError("Artifact Registry repository must have Docker format")
    print(f"✅ Build prerequisites verified: {bucket}, {builder}, {config['repository']}")


def append_github_file(variable: str, value: str) -> None:
    filename = os.environ.get(variable)
    if not filename:
        return
    with open(filename, "a", encoding="utf-8") as file:
        file.write(value + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "cache", "verify"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--sha")
    parser.add_argument("--config", type=Path, default=CONFIG)
    args = parser.parse_args()
    try:
        config = config_for_project(args.project, args.config)
        if args.action == "preflight":
            preflight(args.project, config)
            return 0
        if not args.sha or not SHA_PATTERN.fullmatch(args.sha):
            raise ReleaseCheckError("Image checks require --sha with the full Git commit SHA")
        digest = lookup_digest(args.project, config, args.sha)
        if args.action == "cache":
            append_github_file("GITHUB_OUTPUT", f"skip={'true' if digest else 'false'}")
            if digest:
                print(f"✅ Existing image: {image_name(config)}@{digest} (no rebuild)")
                append_github_file(
                    "GITHUB_STEP_SUMMARY",
                    f"🏗️ Reused the existing SHA {args.sha} image with digest {digest}.",
                )
            else:
                print("🏗️ Release image not present; Cloud Build will run.")
            return 0
        if digest is None:
            raise ReleaseCheckError(
                f"No Artifact Registry image tagged {args.sha}. Build this SHA first."
            )
        print(f"✅ Verified immutable release: {image_name(config)}@{digest}")
        return 0
    except (ReleaseCheckError, KeyError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
