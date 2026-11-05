#!/usr/bin/env python3
"""Read-only, secret-safe diagnosis of the PhotoIntel Cloud Run HTTP service.

Runs with GCP deployer WIF in Actions. Never prints environment, Secret Manager
values, HTTP response bodies, or raw Cloud Logging messages.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloud_cli import run as cloud_run

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "infra/gcp/config.local.json"
SERVICE = "photointel-api"
TIMEOUT = 10
ALLOWED_PROJECT = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]")
ALLOWED_REGION = re.compile(r"[a-z]+-[a-z]+[0-9]")
URL_SUFFIX = ".run.app"


def service_details(project: str, region: str) -> dict[str, Any]:
    try:
        result = cloud_run(
            ["run", "services", "describe", SERVICE, "--region", region, "--format=json"],
            project=project, timeout=45,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("Cannot execute Cloud Run service inspection") from None
    if result.returncode:
        raise RuntimeError(
            "Cloud Run service describe failed. Check project/region, "
            "service existence and run.services.get access."
        )
    try:
        doc = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("Cloud Run returned an unreadable service description") from None
    if not isinstance(doc, dict):
        raise RuntimeError("Cloud Run returned an invalid service description")
    return doc


def safe_service_status(data: dict[str, Any]) -> dict[str, Any]:
    status = data.get("status") or {}
    if not isinstance(status, dict):
        status = {}
    conditions = status.get("conditions") or []
    ready = next(
        (c.get("status") for c in conditions
         if isinstance(c, dict) and c.get("type") == "Ready"),
        "Unknown",
    )
    url = status.get("url")
    if not isinstance(url, str):
        url = ""
    parsed = urllib.parse.urlsplit(url)
    # Require a Google-managed run.app hostname, never an arbitrary URL from
    # user config or provider metadata.
    safe_url = (
        parsed.scheme == "https" and parsed.hostname is not None
        and parsed.hostname.endswith(URL_SUFFIX)
        and parsed.hostname != URL_SUFFIX.lstrip(".")
        and not (parsed.port or parsed.username or parsed.password
                 or parsed.query or parsed.fragment
                 or parsed.path not in ("", "/"))
    )
    revisions = {
        "created": status.get("latestCreatedRevisionName"),
        "ready": status.get("latestReadyRevisionName"),
    }
    traffic = status.get("traffic") or []
    percentages = [
        item.get("percent")
        for item in traffic
        if isinstance(item, dict) and isinstance(item.get("percent"), int)
    ]
    return {
        "ready": ready,
        "url": url.rstrip("/") if safe_url else None,
        "revision_created": revisions["created"] if isinstance(revisions["created"], str) else None,
        "revision_ready": revisions["ready"] if isinstance(revisions["ready"], str) else None,
        "traffic_percent": sum(percentages),
    }


def probe(url: str, path: str) -> int | None:
    request = urllib.request.Request(
        url + path, headers={"User-Agent": "photointel-readonly-health/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            # Body is intentionally not logged or persisted.
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def assess(ready: str, liveness: int | None, readiness: int | None) -> list[str]:
    problems = []
    if ready != "True":
        problems.append(
            "Cloud Run service is not Ready. Open the revision's startup logs."
        )
    if liveness is None:
        problems.append(
            "The Cloud Run endpoint is unreachable from GitHub Actions. "
            "Check service URL, ingress, DNS and network connectivity."
        )
    elif liveness in (401, 403):
        problems.append(
            "Health endpoint rejected the request. Check Cloud Run Invoker IAM "
            "and ingress; /health/live is intentionally unauthenticated by the app."
        )
    elif liveness != 200:
        problems.append(
            f"Live health returned HTTP {liveness}. Check the active revision."
        )
    if liveness == 200 and readiness == 503:
        problems.append(
            "API is listening, but /health/ready returned 503. "
            "Investigate Neon PostgreSQL and Cloudflare R2 dependency access."
        )
    elif liveness == 200 and readiness != 200:
        kind = "unreachable" if readiness is None else f"HTTP {readiness}"
        problems.append(f"Readiness probe returned {kind}. Check DB and R2.")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="photointel")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        project = config.get("project_id")
        region = config.get("region")
        if (
            project != args.project
            or not isinstance(project, str)
            or not ALLOWED_PROJECT.fullmatch(project)
            or not isinstance(region, str)
            or not ALLOWED_REGION.fullmatch(region)
        ):
            raise ValueError("Project/region mismatch or invalid configuration")
    except (OSError, ValueError, TypeError, AttributeError):
        print("::error::GCP_CONFIG_ENV is missing or invalid for this diagnosis.")
        return 1

    try:
        state = safe_service_status(service_details(project, region))
    except RuntimeError as exc:
        print(f"::error::{exc}")
        return 1

    print(f"Project: {project} | Region: {region} | Service: {SERVICE}")
    print(f"Cloud Run Ready condition: {state['ready']}")
    # Revision IDs do not contain secrets, but limit length as defense in depth.
    for label, key in (
        ("Latest created revision", "revision_created"),
        ("Latest ready revision", "revision_ready"),
    ):
        value = state[key] or "unavailable"
        if re.fullmatch(r"[a-zA-Z0-9-]{1,128}", value):
            print(f"{label}: {value}")
    print(f"Traffic percentage reported: {state['traffic_percent']}%")
    if state["revision_ready"] != state["revision_created"]:
        print("::warning::Latest created revision differs from latest Ready revision.")

    origin = state["url"]
    if not origin:
        print(
            "::error::No valid default run.app endpoint in Cloud Run status. "
            "Inspect service networking settings; a cloud.run vanity URL "
            "does not replace the service's actual configured endpoint."
        )
        return 1

    print(f"Cloud Run service URL: {origin}")
    live = probe(origin, "/health/live")
    ready = probe(origin, "/health/ready")
    print(f"/health/live: {'unreachable' if live is None else 'HTTP ' + str(live)}")
    print(f"/health/ready: {'unreachable' if ready is None else 'HTTP ' + str(ready)}")
    problems = assess(str(state["ready"]), live, ready)
    for problem in problems:
        print(f"::error::{problem}")
    print(
        f"Cloud Run logs: "
        f"https://console.cloud.google.com/run/detail/{region}/{SERVICE}/logs?project={project}"
    )
    if problems:
        print(
            "::warning::This is a backend health problem or an ingress/IAM blocker. "
            "Do not attempt another Cloudflare Worker deploy until resolved."
        )
        return 1
    print(
        "✅ Cloud Run HTTP and configured database/storage readiness passed. "
        "If the frontend still cannot connect, check Worker deploy SHA, "
        "Cloudflare Access JWT audience, /v1 route and browser cache."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
