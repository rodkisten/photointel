#!/usr/bin/env python3
"""Synchronize the versioned startup script to the existing GCE VM metadata.

This is a metadata-only operation: no VM deletion, restart, boot-disk changes,
container replacement, GitHub Actions or GCP_CONFIG_ENV needed. Defaults to plan.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gcp'))
from cloud_cli import run as cloud_run

PROJECT = "photointel"
ZONE = "us-central1-a"
INSTANCE = "photointel-terminal"
SCRIPT = Path(__file__).resolve().parent / "startup.sh"


def gcloud(*args: str) -> str:
    response = cloud_run(args, project=PROJECT, timeout=90)
    if response.returncode:
        operation = " ".join(args[:3])
        raise RuntimeError(
            "gcloud " + operation + " failed. Check your Google login and "
            "compute.instances.get / compute.instances.setMetadata IAM permissions."
        )
    return response.stdout


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def validate_instance(info: dict[str, Any]) -> str:
    labels = info.get("labels") or {}
    machine = str(info.get("machineType") or "")
    if (
        info.get("name") != INSTANCE
        or labels.get("app") != "photointel"
        or labels.get("purpose") != "terminal"
        or not machine.endswith("/e2-micro")
    ):
        raise ValueError("Refusing to update a VM outside the PhotoIntel terminal identity.")
    items = (info.get("metadata") or {}).get("items") or []
    values = {i.get("key"): i.get("value") for i in items if isinstance(i, dict)}
    if not isinstance(values.get("terminal-config"), str) or not values["terminal-config"]:
        raise ValueError("VM terminal-config metadata is absent; refusing partial provisioning.")
    old = values.get("startup-script")
    return old if isinstance(old, str) else ""


def sync(*, apply: bool = False) -> str:
    source = SCRIPT.read_text(encoding="utf-8")
    syntax = subprocess.run(
        ["bash", "-n", str(SCRIPT)], capture_output=True, text=True, check=False,
        timeout=15,
    )
    if syntax.returncode:
        raise ValueError("Repository startup.sh has a Bash syntax error; refusing to publish.")
    try:
        info = json.loads(gcloud(
            "compute", "instances", "describe", INSTANCE,
            "--zone=" + ZONE, "--format=json",
        ))
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("GCP returned invalid VM metadata.") from error
    old = validate_instance(info)
    current, desired = sha256(old), sha256(source)
    print("Target:", PROJECT, ZONE, INSTANCE)
    print("Current startup SHA-256:", current)
    print("Repo startup SHA-256:   ", desired)
    print("VM status:", info.get("status", "UNKNOWN"))
    if old == source:
        print("Already in sync. No change needed.")
        return "unchanged"
    if not apply:
        print("PLAN: change only metadata key startup-script; existing terminal-config is preserved.")
        print("Use --apply to synchronize. Reboot separately when convenient.")
        return "planned"
    if old:
        backup = Path.home() / ".local" / "state" / "photointel-terminal" / "startup-backups"
        backup.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = backup / ("startup-" + current[:16] + ".sh")
        if not path.exists():
            path.write_text(old, encoding="utf-8")
            os.chmod(path, 0o600)
    gcloud(
        "compute", "instances", "add-metadata", INSTANCE,
        "--zone=" + ZONE,
        "--metadata-from-file=startup-script=" + str(SCRIPT),
    )
    print("Startup script synchronized. No VM stop/start was requested.")
    print("Next normal VM boot will execute this exact repository script.")
    return "updated"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write startup-script metadata after safety checks.")
    args = parser.parse_args()
    try:
        sync(apply=args.apply)
        return 0
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print("Startup sync failed:", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
