#!/usr/bin/env python3
"""Sync the GitHub Actions configuration variable to a restricted CircleCI context.

Requires: gh auth with Actions variables read permission; CIRCLECI_TOKEN with
context write permission. No GitHub Actions runners or billing changes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = "rodkisten/photointel"
BASE = "https://circleci.com/api/v2"
CONTEXT = "photointel-production"


def request(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Circle-Token": token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"CircleCI API {method} failed (HTTP {exc.code}); check permissions") from None


def github_variable(name: str) -> str:
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{REPO}/actions/variables/{name}", "--jq", ".value"],
            capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(
            f"Unable to read GitHub Actions variable {name}. "
            "Authenticate gh with repository Actions variables read access."
        ) from exc
    return result.stdout.rstrip("\n")


def context_id(token: str, organization_id: str, name: str) -> str:
    url = f"{BASE}/context?owner-id={urllib.parse.quote(organization_id)}&owner-type=organization"
    while url:
        response = request("GET", url, token)
        matches = [item["id"] for item in response.get("items", []) if item.get("name") == name]
        if len(matches) == 1:
            return matches[0]
        page = response.get("next_page_token")
        url = (
            f"{BASE}/context?owner-id={urllib.parse.quote(organization_id)}"
            f"&owner-type=organization&page-token={urllib.parse.quote(page)}"
            if page else ""
        )
    raise SystemExit(f"Context {name!r} not found. Create and restrict it in CircleCI first.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write CircleCI context (default: dry-run)")
    parser.add_argument("--context", default=CONTEXT)
    args = parser.parse_args()
    raw = github_variable("GCP_CONFIG_ENV")
    if not raw.strip():
        raise SystemExit("GitHub GCP_CONFIG_ENV is empty")
    digest = hashlib.sha256(raw.encode()).hexdigest()
    print(f"GitHub source: {REPO} / GCP_CONFIG_ENV")
    print(f"Bytes: {len(raw.encode())}; SHA256: {digest}; target context: {args.context}")
    if not args.apply:
        print("Dry run only. Use --apply to update CircleCI.")
        return
    token = os.environ.get("CIRCLECI_TOKEN", "")
    org = os.environ.get("CIRCLECI_ORG_ID", "")
    if not token or not org:
        raise SystemExit("CIRCLECI_TOKEN and CIRCLECI_ORG_ID are required for --apply")
    cid = context_id(token, org, args.context)
    for name, value in (
        ("GCP_CONFIG_ENV", raw),
        ("GCP_CONFIG_ENV_SHA256", digest),
    ):
        request(
            "PUT",
            f"{BASE}/context/{urllib.parse.quote(cid)}/environment-variable/{name}",
            token,
            {"value": value},
        )
        print(f"Updated {name} (value not displayed)")
    print("Sync complete. No deployment triggered.")


if __name__ == "__main__":
    main()
