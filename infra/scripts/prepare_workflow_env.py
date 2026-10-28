#!/usr/bin/env python3
"""Validate and stage GitHub Actions workflow environment without exposing secrets.

Production Pages: export only validated PUBLIC build configuration to GITHUB_ENV.
SSH: validate Tailscale OAuth secrets for the interactive session, but never
export credentials to GITHUB_ENV, logs, artifacts or the repository.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

PAGES_PROJECT = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
RELEASE_SHA = re.compile(r"[a-f0-9]{40}")


class WorkflowEnvironmentError(ValueError):
    """Configuration error that never embeds environment values."""


def safe_value(name: str, *, required: bool = True) -> str:
    value = os.environ.get(name, "")
    if required and not value:
        raise WorkflowEnvironmentError(f"Missing {name} in GitHub production Environment")
    if any(char in value for char in ("\n", "\r", "\x00")):
        raise WorkflowEnvironmentError(f"Invalid line break in {name}")
    if len(value) > 2048:
        raise WorkflowEnvironmentError(f"Invalid length for {name}")
    return value


def pages_environment() -> dict[str, str]:
    """Pages vars are public build-time values; tokens remain scoped to Wrangler."""
    api = safe_value("VITE_API_BASE_URL", required=False)
    if api:
        url = urlsplit(api)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
            or url.path not in ("", "/")
            or not url.netloc
        ):
            raise WorkflowEnvironmentError(
                "VITE_API_BASE_URL must be a HTTPS origin (or empty for same-origin)"
            )
    project = safe_value("PAGES_PROJECT")
    if not PAGES_PROJECT.fullmatch(project):
        raise WorkflowEnvironmentError("PAGES_PROJECT must be a valid Cloudflare Pages name")
    # Do not write credentials to GITHUB_ENV or echo them.
    token = safe_value("CLOUDFLARE_API_TOKEN")
    account = safe_value("CLOUDFLARE_ACCOUNT_ID")
    if not token.strip() or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise WorkflowEnvironmentError(
            "Cloudflare credentials are missing or account ID is invalid"
        )
    sha = safe_value("GITHUB_SHA")
    if not RELEASE_SHA.fullmatch(sha):
        raise WorkflowEnvironmentError("Invalid GitHub release commit SHA")
    return {
        "VITE_API_BASE_URL": api.rstrip("/"),
        "PAGES_PROJECT": project,
        "VITE_RELEASE_ID": sha,
    }


def ssh_environment() -> None:
    """Check credentials only for interactive SSH sessions, never persist secrets."""
    if not safe_value("TS_OAUTH_CLIENT_ID").strip() or not safe_value(
        "TS_OAUTH_SECRET"
    ).strip():
        raise WorkflowEnvironmentError(
            "Missing Tailscale OAuth credentials in repository Actions secrets"
        )


def append_public_env(values: dict[str, str]) -> None:
    dest = os.environ.get("GITHUB_ENV")
    if not dest:
        raise WorkflowEnvironmentError("GITHUB_ENV is unavailable")
    # Every value was checked for embedded newlines before being written.
    with Path(dest).open("a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=("pages", "ssh"))
    target = parser.parse_args().target
    try:
        if target == "pages":
            append_public_env(pages_environment())
            print("✅ Pages environment ready (public variables staged, secrets kept scoped).")
        else:
            ssh_environment()
            print("✅ SSH environment ready (OAuth credentials validated without export).")
        return 0
    except WorkflowEnvironmentError as exc:
        print(f"::error title=Workflow environment::{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
