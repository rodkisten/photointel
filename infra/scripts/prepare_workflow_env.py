#!/usr/bin/env python3
"""Load production workflow configuration from one GCP_CONFIG_ENV-derived JSON.

The public configuration comes from infra/gcp/config.local.json. Credentials
are always fetched on demand from Google Secret Manager using short-lived WIF.
Never print a secret, write it to GITHUB_ENV, or store it in the repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra/gcp/config.local.json"
PAGES_PROJECT = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
RELEASE_SHA = re.compile(r"[a-f0-9]{40}")
ACCOUNT_ID = re.compile(r"[A-Fa-f0-9]{32}")
REFERENCE_NAME = re.compile(r"[a-z][a-z0-9-]{0,254}")
REFERENCE_VERSION = re.compile(r"[1-9][0-9]{0,9}")

class WorkflowEnvironmentError(ValueError):
    """Safe-to-print error with no secret contents."""


def read_config() -> dict:
    try:
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise WorkflowEnvironmentError("GCP environment was not prepared") from None
    if not isinstance(config, dict):
        raise WorkflowEnvironmentError("Invalid GCP deployment configuration")
    project = config.get("project_id")
    if not isinstance(project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise WorkflowEnvironmentError("Invalid GCP project ID")
    # A repo's fork or external project cannot be substituted for the production project.
    if os.environ.get("CONFIRM_PROJECT") != project:
        raise WorkflowEnvironmentError("GCP project confirmation mismatch")
    return config


def pages_environment(config: dict) -> dict[str, str]:
    workflows = config.get("workflows") or {}
    pages = workflows.get("pages") or {}
    project = pages.get("project", "")
    api = pages.get("api_base_url", "")
    if not isinstance(project, str) or not PAGES_PROJECT.fullmatch(project):
        raise WorkflowEnvironmentError("Configure WORKFLOWS__PAGES__PROJECT in GCP_CONFIG_ENV")
    if not isinstance(api, str) or any(c in api for c in ("\r", "\n", "\x00")):
        raise WorkflowEnvironmentError("Invalid Pages API origin")
    if api:
        parsed = urlsplit(api)
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            parsed.path not in ("", "/")
        ):
            raise WorkflowEnvironmentError("Pages API origin must be an HTTPS origin")
    sha = os.environ.get("GITHUB_SHA", "")
    if not RELEASE_SHA.fullmatch(sha):
        raise WorkflowEnvironmentError("Invalid GitHub release commit SHA")
    return {
        "VITE_API_BASE_URL": api.rstrip("/"),
        "PAGES_PROJECT": project,
        "VITE_RELEASE_ID": sha,
    }


def append_public_env(values: dict[str, str]) -> None:
    dest = os.environ.get("GITHUB_ENV")
    if not dest:
        raise WorkflowEnvironmentError("GITHUB_ENV is unavailable")
    with Path(dest).open("a", encoding="utf-8") as output:
        for key, value in values.items():
            if any(c in value for c in ("\r", "\n", "\x00")):
                raise WorkflowEnvironmentError("Invalid public workflow variable")
            output.write(f"{key}={value}\n")


def explain_secret_access_failure(key: str, name: str, version: str, stderr: bytes) -> str:
    """Classify gcloud errors without ever displaying raw stderr or secret payload."""
    error = stderr.decode("utf-8", errors="replace").lower()
    target = f"{key} ({name}, version {version})"
    if "permission_denied" in error or "permission denied" in error or "403" in error:
        return (
            f"Access denied for {target}. The authenticated deployer needs "
            "roles/secretmanager.secretAccessor on this secret. "
            "Run Setup GCP apply after configuring workflow_secrets."
        )
    if "not_found" in error or "not found" in error or "404" in error:
        return (
            f"Secret or version not found: {target}. "
            "Create the secret and add the exact numeric version in Google Secret Manager; "
            "Setup GCP only creates secret containers, never their values."
        )
    if (
        "failed_precondition" in error or "disabled" in error
        or "destroyed" in error
    ):
        return (
            f"Secret version unavailable: {target}. "
            "Create/enable a valid version and update the pinned version reference."
        )
    if "unauthenticated" in error or "invalid_grant" in error:
        return f"Google authentication failed while accessing {target}; check WIF."
    return (
        f"Cannot access {target}. Check whether the pinned version exists and is "
        "enabled, and whether the WIF deployer has secretAccessor on this secret."
    )


def secret_value(config: dict, key: str) -> str:
    references = config.get("workflow_secrets") or {}
    ref = references.get(key)
    if not isinstance(ref, dict) or set(ref) != {"name", "version"}:
        raise WorkflowEnvironmentError(f"Missing WORKFLOW_SECRETS__{key} reference")
    name, version = ref["name"], ref["version"]
    if (
        not isinstance(name, str) or not REFERENCE_NAME.fullmatch(name) or
        not isinstance(version, str) or not REFERENCE_VERSION.fullmatch(version)
    ):
        raise WorkflowEnvironmentError(f"Invalid WORKFLOW_SECRETS__{key} reference")
    project = config["project_id"]
    try:
        result = subprocess.run(
            [
                "gcloud", "secrets", "versions", "access", version,
                "--secret", name, "--project", project, "--quiet",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise WorkflowEnvironmentError(f"Could not access GCP secret for {key}") from None
    if result.returncode:
        # gcloud stderr may contain credentials. Classify without echoing it.
        raise WorkflowEnvironmentError(
            explain_secret_access_failure(key, name, version, result.stderr)
        )
    try:
        value = result.stdout.decode("utf-8")
    except UnicodeDecodeError:
        raise WorkflowEnvironmentError(f"Invalid encoding for {key}") from None
    if not value or len(value) > 4096 or any(c in value for c in ("\r", "\n", "\x00")):
        raise WorkflowEnvironmentError(f"Invalid single-line GCP secret {key}")
    return value


def pages_deploy(config: dict) -> None:
    public = pages_environment(config)
    token = secret_value(config, "CLOUDFLARE_API_TOKEN")
    account = secret_value(config, "CLOUDFLARE_ACCOUNT_ID")
    if not token.strip() or not ACCOUNT_ID.fullmatch(account):
        raise WorkflowEnvironmentError("Cloudflare credentials are invalid")
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = account
    env["PAGES_PROJECT"] = public["PAGES_PROJECT"]
    # Credentials exist only in the Wrangler subprocess, never GITHUB_ENV/output.
    result = subprocess.run(
        [
            "npx", "--yes", "wrangler@4", "pages", "deploy",
            "apps/web/dist", "--project-name", public["PAGES_PROJECT"],
        ],
        env=env, check=False,
    )
    if result.returncode:
        raise WorkflowEnvironmentError("Wrangler Pages deploy failed; inspect its logs")


def ssh_environment(config: dict) -> None:
    client = secret_value(config, "TS_OAUTH_CLIENT_ID")
    secret = secret_value(config, "TS_OAUTH_SECRET")
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        raise WorkflowEnvironmentError("GitHub step outputs unavailable")
    # Mask before emitting to step outputs. GitHub output stays within this job.
    for value in (client, secret):
        print(f"::add-mask::{value}", flush=True)
    with Path(path).open("a", encoding="utf-8") as output:
        output.write(f"ts_client_id={client}\n")
        output.write(f"ts_oauth_secret={secret}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=("pages", "pages-deploy", "ssh"))
    opts = parser.parse_args()
    try:
        config = read_config()
        if opts.target == "pages":
            public = pages_environment(config)
            # Fail before npm install/build when credentials or IAM are missing.
            # Reads remain private to this short-lived Python process.
            token = secret_value(config, "CLOUDFLARE_API_TOKEN")
            account_id = secret_value(config, "CLOUDFLARE_ACCOUNT_ID")
            if not token.strip() or not ACCOUNT_ID.fullmatch(account_id):
                raise WorkflowEnvironmentError(
                    "Invalid Cloudflare token or account ID in Google Secret Manager"
                )
            append_public_env(public)
            print("✅ Pages public config and Secret Manager access verified.")
        elif opts.target == "pages-deploy":
            pages_deploy(config)
        else:
            ssh_environment(config)
            print("✅ SSH OAuth credentials retrieved from GCP Secret Manager.")
        return 0
    except WorkflowEnvironmentError as exc:
        print(f"::error title=Workflow Env::{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
