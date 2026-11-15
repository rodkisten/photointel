#!/usr/bin/env python3
"""Safe GCP CI diagnostics via the shared PhotoIntel classifier."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from infra.gcp.cloud_cli import classify


def main() -> int:
    if len(sys.argv) != 3 or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", sys.argv[2]):
        return 2
    logfile, project = sys.argv[1:]
    if not Path(logfile).is_file():
        return 2
    failure = classify(Path(logfile).read_bytes())
    catalog_path = Path(__file__).resolve().parents[2] / "apps/manage/src/gcp-diagnostic-catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    match = catalog.get(failure.category) or catalog.get(failure.code)
    links = {
        "QUOTA": ("GCP quotas", "iam-admin/quotas"),
        "AUTHENTICATION": ("GCP authentication", "iam-admin/iam"),
        "SECRET_MANAGER": ("Secret Manager", "security/secret-manager"),
        "ARTIFACT_REGISTRY": ("Artifact Registry", "artifacts"),
        "SERVICE_ACCOUNT_NOT_FOUND": ("Service accounts", "iam-admin/serviceaccounts"),
        "CLOUD_RUN_JOB_IAM": ("Cloud Run jobs", "run/jobs"),
    }
    if match:
        title, route = match["title"], match["route"]
    elif failure.category in links:
        title, route = links[failure.category]
    elif failure.code == "PERMISSION_DENIED":
        title, route = "GCP IAM", "iam-admin/iam"
    elif failure.code == "NOT_FOUND":
        title, route = "GCP resources", "home/dashboard"
    elif failure.code == "UNAUTHENTICATED":
        title, route = "GCP authentication", "iam-admin/iam"
    else:
        title, route = "GCP logs", "logs/query"
    messages = {
        "PERMISSION_DENIED": "Access denied (403).",
        "NOT_FOUND": "Resource not found (404).",
        "UNAUTHENTICATED": "GCP authentication required.",
        "RESOURCE_EXHAUSTED": "GCP quota or rate limit exceeded.",
        "PROVIDER_ERROR": "GCP command failed.",
    }
    hint = messages[failure.code]
    if failure.hint:
        hint += " " + failure.hint
    elif match:
        hint += " " + match["hint"]
    if failure.permissions:
        hint += " Permissions: " + ", ".join(failure.permissions)
    print(hint)
    print(title)
    print("https://console.cloud.google.com/" + route + "?project=" + project)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
