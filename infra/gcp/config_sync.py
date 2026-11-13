#!/usr/bin/env python3
"""Reconcile existing Cloud Run runtime configuration WITHOUT rebuilding images.

The last deployed image and its release SHA are preserved per service/job.
Never runs migrations, starts jobs, creates a service, or changes IAM.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from infra import repository_root
from infra.gcp.cloud_cli import run as cloud_run
from infra.gcp.manage import render

ROOT = repository_root(__file__)
CONFIG = ROOT / "infra/gcp/config.local.json"
IMAGE = re.compile(r"^us-central1-docker\.pkg\.dev/photointel/photointel/api(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$")
SHA = re.compile(r"^[a-f0-9]{40}$")
MODES = ("discover", "backfill", "worker", "maintenance")


class ConfigurationSyncError(RuntimeError):
    pass


def gcloud(args: list[str]) -> str:
    result = cloud_run(args, project="photointel", timeout=100)
    if result.returncode:
        # Cloud Run stderr may contain sensitive URL/IDs: keep logs bounded.
        raise ConfigurationSyncError(
            "Cloud Run lookup or update failed: " + " ".join(args[:3])
            + " (exit " + str(result.returncode) + ")"
        )
    return result.stdout


def find_running_container(node: Any) -> dict[str, Any]:
    """Read a single container from a live service/job's template, not its status."""
    if isinstance(node, dict):
        containers = node.get("containers")
        if isinstance(containers, list) and len(containers) == 1:
            container = containers[0]
            if isinstance(container, dict) and isinstance(container.get("image"), str):
                return container
        for key in ("spec", "template"):
            if key in node:
                candidate = find_running_container(node[key])
                if candidate:
                    return candidate
    return {}


def live_image_and_sha(kind: str, name: str, region: str) -> tuple[str, str]:
    output = gcloud(["run", kind, "describe", name, "--region=" + region, "--format=json"])
    try:
        data = json.loads(output)
    except ValueError as exc:
        raise ConfigurationSyncError("Cloud Run live revision is not valid JSON") from exc
    container = find_running_container(data.get("spec", data.get("template", {})))
    image = container.get("image", "")
    if not IMAGE.fullmatch(image):
        raise ConfigurationSyncError("Running Cloud Run image is not a PhotoIntel Artifact Registry image")
    envs = container.get("env", [])
    sha = next((e.get("value", "") for e in envs
                if isinstance(e, dict) and e.get("name") == "RELEASE_GIT_SHA"), "")
    if not SHA.fullmatch(sha):
        # Tagged images can supply a SHA; immutable digests need an env metadata SHA.
        sha = image.rsplit(":", 1)[-1] if ":" in image else ""
    if not SHA.fullmatch(sha):
        raise ConfigurationSyncError("Cannot identify existing running release SHA")
    return image, sha


def patch(path: Path, image: str, sha: str, *, kind: str) -> None:
    document = json.loads(path.read_text(encoding="utf-8"))
    if kind == "service":
        container = document["spec"]["template"]["spec"]["containers"][0]
    else:
        container = document["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    container["image"] = image
    for env in container["env"]:
        if env["name"] == "RELEASE_GIT_SHA":
            env["value"] = sha
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def reconcile(targets: set[str], *, config_path: Path = CONFIG) -> None:
    # Keep this entry point for existing Manage/CLI callers; Terraform owns writes.
    from infra.terraform.dispatch_media import main as dispatch
    import os
    if not targets or targets - {"api", "jobs"}:
        raise ConfigurationSyncError("Targets must be an api/jobs subset")
    os.environ["TF_SCOPE"] = "gcp"
    os.environ["TF_ACTION"] = "apply"
    os.environ["TF_TARGETS"] = ",".join(sorted(targets))
    dispatch()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", required=True)
    args = parser.parse_args()
    tokens = args.targets.split(",")
    if not tokens or any(x not in {"api", "jobs"} for x in tokens) or len(set(tokens)) != len(tokens):
        parser.error("Targets must be an unambiguous api,jobs subset")
    try:
        reconcile(set(tokens))
    except (ConfigurationSyncError, ValueError, OSError, KeyError, subprocess.TimeoutExpired) as exc:
        print("::error::" + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
