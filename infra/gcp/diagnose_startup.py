#!/usr/bin/env python3
"""Read-only Cloud Run startup and dependency diagnostics with safe output."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloud_cli import run as cloud_run  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra/gcp/config.local.json"
SERVICE = "photointel-api"

# Emit only fixed guidance, never provider log lines or Pydantic's input_value.
SIGNALS: tuple[tuple[str, str, str], ...] = (
    (
        "readiness_neon_failed",
        "NEON_HEALTH_FAILED",
        "The running API cannot complete SELECT 1 against Neon PostgreSQL. "
        "Check the DATABASE_URL secret version, password, TLS, Neon project state "
        "and Cloud Run egress. Exception messages are intentionally omitted.",
    ),
    (
        "readiness_r2_failed",
        "R2_HEALTH_FAILED",
        "The running API cannot inspect the R2 bucket. Check storage endpoint, "
        "bucket, S3 access key/secret version and bucket-scoped permissions. "
        "Exception messages are intentionally omitted.",
    ),
    (
        "channel_binding=require",
        "NEON_CHANNEL_BINDING",
        "The Neon URL contains channel_binding=require, unsupported by asyncpg. "
        "Correct the Secret Manager DATABASE_URL using the documented TLS-verified URL.",
    ),
    (
        "production bridge_token_pepper must contain",
        "BRIDGE_PEPPER_TOO_SHORT",
        "BRIDGE_TOKEN_PEPPER is too short. Set a cryptographically random value "
        "of at least 32 characters in Secret Manager, then deploy a new revision.",
    ),
    (
        "database_url must use postgresql with asyncpg",
        "DATABASE_DRIVER",
        "DATABASE_URL must be PostgreSQL with the asyncpg-compatible driver.",
    ),
    (
        "cloud run production requires database tls and gates",
        "PRODUCTION_GATES",
        "Required Cloud Run production database TLS / verification gates are disabled.",
    ),
    (
        "access_team_domain must name a cloudflare access team",
        "CLOUDFLARE_TEAM",
        "Check the Cloudflare Access team domain in production configuration.",
    ),
    (
        "modulenotfounderror",
        "MISSING_PYTHON_MODULE",
        "A Python module is unavailable in the runtime image. Recheck the lockfile "
        "and Docker build dependencies.",
    ),
    (
        "validationerror",
        "INVALID_RUNTIME_CONFIG",
        "Pydantic rejected runtime configuration. Review env/Secret Manager versions "
        "and the Cloud Run revision logs in the Google Cloud console.",
    ),
    (
        "memory limit exceeded",
        "MEMORY_LIMIT",
        "Cloud Run reports memory pressure. Inspect observed usage before "
        "adjusting the container memory limit.",
    ),
    (
        "failed to start and listen on the port",
        "PORT_NOT_LISTENING",
        "The API never listened on the configured PORT. Check Python startup "
        "exceptions, entrypoint, and container logs.",
    ),
)


def classify_entries(entries: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Return safe error codes and fixed remediation hints, never raw log values."""
    messages: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        payload = entry.get("jsonPayload")
        values = [entry.get("textPayload", "")]
        if isinstance(payload, dict):
            values.extend([payload.get("message", ""), payload.get("error", "")])
        for value in values:
            if isinstance(value, str):
                messages.append(value.lower())
    combined = "\n".join(messages)
    return [
        (code, guidance)
        for marker, code, guidance in SIGNALS
        if marker in combined
    ]


def read_logs(project: str, service: str, region: str) -> list[dict[str, Any]]:
    filter_expression = (
        'resource.type="cloud_run_revision" '
        f'AND resource.labels.service_name="{service}" '
        f'AND resource.labels.location="{region}"'
    )
    result = cloud_run(
        ["logging", "read", filter_expression,
         "--freshness=15m", "--limit=100", "--format=json"],
        project=project, timeout=45,
    )
    if result.returncode:
        raise RuntimeError("Cloud Logging could not be read. The deployer may need "
                           "roles/logging.viewer; run administrative bootstrap.")
    parsed = json.loads(result.stdout or "[]")
    if not isinstance(parsed, list):
        raise ValueError("Cloud Logging response was not a JSON array")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--config", type=Path, default=CONFIG)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if args.project != config["project_id"]:
            raise ValueError("Project ID mismatch; refusing to query another project")
        region = config["region"]
        if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", region):
            raise ValueError("Invalid region in configuration")
        entries = read_logs(args.project, SERVICE, region)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        # Do not print exception text from provider responses: it can include IDs or secrets.
        print("::warning::Cloud Run startup diagnosis unavailable. "
              "Check logging.viewer permissions and revision logs in Cloud Console.")
        return 0

    print(f"::notice::Cloud Run startup/readiness diagnostics: examined {len(entries)} recent log entries.")
    signals = classify_entries(entries)
    if signals:
        for code, guidance in signals:
            print(f"::error title=Cloud Run startup ({code})::{guidance}")
    else:
        print("::warning::No safe startup root-cause signature recognized. "
              "Inspect the failed revision's Cloud Logging traceback manually.")
    print(
        "Cloud Run revision logs: "
        f"https://console.cloud.google.com/run/detail/{region}/{SERVICE}/logs?project={args.project}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
