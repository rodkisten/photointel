#!/usr/bin/env python3
"""Prepare Cloudflare Worker frontend and SSH from a single GCP_CONFIG_ENV.

The public configuration comes from infra/gcp/config.local.json. Credentials
are always fetched on demand from Google Secret Manager using short-lived WIF.
Never print a secret, write it to GITHUB_ENV, or store it in the repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import tomllib
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra/gcp/config.local.json"
WORKER_NAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
DOMAIN = re.compile(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?")
RELAY_CONFIG = ROOT / "infra/cloudflare/cloud-run-proxy/wrangler.toml"
WORKER_COMPATIBILITY_DATE = "2026-10-31"
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


def relay_configuration() -> dict:
    """Preserve the existing Worker name and API domain from the checked-in relay."""
    try:
        with RELAY_CONFIG.open("rb") as stream:
            cfg = tomllib.load(stream)
    except (OSError, ValueError):
        raise WorkflowEnvironmentError("Missing or malformed API relay Wrangler config") from None
    if cfg.get("name") != "photointel-api-relay" or cfg.get("main") != "worker.mjs":
        raise WorkflowEnvironmentError("Unexpected existing API relay Worker identity")
    if not isinstance(cfg.get("routes"), list):
        raise WorkflowEnvironmentError("Missing existing API relay custom domain")
    routes = cfg["routes"]
    if not routes or any(
        not isinstance(route, dict)
        or route.get("custom_domain") is not True
        or not isinstance(route.get("pattern"), str)
        or not DOMAIN.fullmatch(route["pattern"])
        for route in routes
    ):
        raise WorkflowEnvironmentError("Invalid existing API relay custom domain")
    return cfg


def worker_environment(config: dict) -> dict[str, str]:
    """Deploy frontend + API to the already existing photointel-api-relay Worker."""
    relay = relay_configuration()
    worker = (config.get("workflows") or {}).get("worker") or {}
    name = worker.get("name") or relay["name"]
    frontend = config.get("frontend_origin", "")
    if not isinstance(name, str) or name != relay["name"]:
        raise WorkflowEnvironmentError(
            "One Worker only: set WORKFLOWS__WORKER__NAME=photointel-api-relay "
            "or omit the setting"
        )
    origin = urlsplit(frontend)
    if (
        origin.scheme != "https" or not origin.hostname
        or origin.username or origin.password or origin.port
        or origin.path not in ("", "/") or origin.query or origin.fragment
    ):
        raise WorkflowEnvironmentError("FRONTEND_ORIGIN must be an HTTPS origin")
    domain = worker.get("domain") or origin.hostname
    if (
        not isinstance(domain, str) or not DOMAIN.fullmatch(domain)
        or domain != origin.hostname
    ):
        raise WorkflowEnvironmentError(
            "WORKFLOWS__WORKER__DOMAIN must match FRONTEND_ORIGIN, or be omitted"
        )
    if domain in {route["pattern"] for route in relay["routes"]}:
        raise WorkflowEnvironmentError(
            "Frontend hostname must be different from the existing API hostname"
        )
    sha = os.environ.get("GITHUB_SHA", "")
    if not RELEASE_SHA.fullmatch(sha):
        raise WorkflowEnvironmentError("Invalid GitHub release commit SHA")
    # The browser calls /v1/* on the same origin. No second API hostname needed.
    # Legacy WORKFLOWS__PAGES__* and WORKFLOWS__WORKER__API_BASE_URL are ignored.
    return {
        "VITE_API_BASE_URL": "",
        "WORKER_NAME": name,
        "WORKER_DOMAIN": domain,
        "VITE_RELEASE_ID": sha,
    }


def discover_cloud_run_origin(config: dict) -> str:
    """Resolve the real deployed Cloud Run URL instead of a placeholder .run.app."""
    try:
        result = subprocess.run(
            [
                "gcloud", "run", "services", "describe", "photointel-api",
                "--region", config["region"], "--project", config["project_id"],
                "--format=value(status.url)", "--quiet",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            timeout=45, check=False,
        )
    except (OSError, subprocess.TimeoutExpired, KeyError):
        raise WorkflowEnvironmentError("Could not inspect Cloud Run photointel-api") from None
    if result.returncode:
        raise WorkflowEnvironmentError(
            "Cannot describe Cloud Run photointel-api: confirm deployment "
            "and the GCP deployer run.services.get permission"
        )
    origin = result.stdout.strip()
    url = urlsplit(origin)
    if (
        url.scheme != "https" or not url.hostname
        or not url.hostname.endswith(".run.app")
        or url.username or url.password or url.port
        or url.path not in ("", "/") or url.query or url.fragment
    ):
        raise WorkflowEnvironmentError("Cloud Run returned an invalid API service URL")
    return origin.rstrip("/")


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


def worker_deploy(config: dict) -> None:
    public = worker_environment(config)
    token = secret_value(config, "CLOUDFLARE_API_TOKEN")
    account = secret_value(config, "CLOUDFLARE_ACCOUNT_ID")
    if not token.strip() or not ACCOUNT_ID.fullmatch(account):
        raise WorkflowEnvironmentError("Cloudflare credentials are invalid")
    config_dir = RELAY_CONFIG.parent
    dist = ROOT / "apps/web/dist"
    if not (dist / "index.html").is_file():
        raise WorkflowEnvironmentError("Missing frontend build: apps/web/dist/index.html")

    # Same Worker, same API relay name and existing API custom domain.
    relay = relay_configuration()
    routes = list(relay["routes"])
    routes.append({"pattern": public["WORKER_DOMAIN"], "custom_domain": True})
    wrangler = {
        "name": relay["name"],
        "main": "./worker.mjs",
        "compatibility_date": WORKER_COMPATIBILITY_DATE,
        "workers_dev": False,
        "preview_urls": False,
        "vars": {
            "CLOUD_RUN_ORIGIN": discover_cloud_run_origin(config),
            "FRONTEND_ORIGIN": config["frontend_origin"],
        },
        "assets": {
            "directory": "../../../apps/web/dist",
            "binding": "ASSETS",
            # Explicit Worker-first preserves API precedence and isolates assets
            # to the frontend hostname even on the legacy api.* custom domain.
            "run_worker_first": True,
            "not_found_handling": "single-page-application",
        },
        "routes": routes,
    }
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = account
    env["WRANGLER_SEND_METRICS"] = "false"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", prefix=".wrangler-deploy-",
            suffix=".json", dir=config_dir, delete=False,
        ) as stream:
            temporary = Path(stream.name)
            temporary.chmod(0o600)
            json.dump(wrangler, stream, indent=2)
            stream.write("\n")
        result = subprocess.run(
            ["npx", "--yes", "wrangler@4", "deploy", "--config", str(temporary)],
            env=env, cwd=config_dir, check=False,
        )
        if result.returncode:
            raise WorkflowEnvironmentError(
                "Unified Cloudflare Worker deploy failed; inspect Wrangler logs. "
                "An existing DNS CNAME for the frontend custom domain may need adjustment."
            )
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


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
    parser.add_argument("target", choices=("worker", "worker-deploy", "ssh"))
    opts = parser.parse_args()
    try:
        config = read_config()
        if opts.target == "worker":
            public = worker_environment(config)
            # Check Secret Manager before npm ci/build to fail quickly.
            token = secret_value(config, "CLOUDFLARE_API_TOKEN")
            account_id = secret_value(config, "CLOUDFLARE_ACCOUNT_ID")
            if not token.strip() or not ACCOUNT_ID.fullmatch(account_id):
                raise WorkflowEnvironmentError(
                    "Invalid Cloudflare token or account ID in Google Secret Manager"
                )
            append_public_env(public)
            print("✅ Unified frontend/API Worker config and Secret Manager access verified.")
        elif opts.target == "worker-deploy":
            worker_deploy(config)
        else:
            ssh_environment(config)
            print("✅ SSH OAuth credentials retrieved from GCP Secret Manager.")
        return 0
    except WorkflowEnvironmentError as exc:
        print(f"::error title=Workflow Env::{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
