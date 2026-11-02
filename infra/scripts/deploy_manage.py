#!/usr/bin/env python3
"""Publish a separate, Cloudflare Access-protected PhotoIntel management Worker.

The existing PhotoIntel Worker, GCP deployments, R2, DNS routes and Access apps
are not mutated. Values are read from GCP Secret Manager, never GitHub Actions
env vars, source files or a committed Wrangler configuration.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from cloudflare_setup import client, policy, reconcile_app, SetupError
from prepare_workflow_env import read_config, secret_value

ROOT = Path(__file__).resolve().parents[2]
MANAGE = ROOT / "apps/manage"
DOMAIN = "photos-manage.migos.club"
APP_NAME = "photointel-manage"
WORKER_NAME = "photointel-manage"


def run(args: list[str], *, env: dict[str, str], stdin: str | None = None) -> None:
    proc = subprocess.run(
        args, cwd=MANAGE, env=env,
        input=stdin, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False, timeout=180,
    )
    if proc.returncode:
        # Wrangler may echo provider response bodies, tokens, or account data.
        # Keep them out of GitHub Actions logs.
        raise SetupError("Management Wrangler command failed; inspect Cloudflare "
                         "dashboard deploy logs and your API permissions.")


def probe_installed_credential(label: str, url: str, token: str) -> str:
    """Exercise the exact Secret Manager value without displaying credential content."""
    request = Request(url, headers={
        "Authorization": "Bearer " + token.strip(),
        "Accept": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "photointel-manage-deploy-probe",
    })
    try:
        with urlopen(request, timeout=8) as response:
            status = response.status
            permissions = response.headers.get("X-Accepted-GitHub-Permissions", "")
    except HTTPError as exc:
        status = exc.code
        permissions = exc.headers.get("X-Accepted-GitHub-Permissions", "")
        exc.close()
    except (URLError, TimeoutError, OSError):
        return label + ": network/timeout"
    if not re.fullmatch(r"[a-z_=,; -]{0,180}", permissions, flags=re.IGNORECASE):
        permissions = ""
    suffix = " (required: " + permissions + ")" if permissions else ""
    return label + ": HTTP " + str(status) + suffix



def public_sentry_settings(config: dict) -> tuple[str, str]:
    """Validate a public ingest DSN; no Sentry API token is required."""
    extra = config.get("extra_environment") or {}
    dsn = str(extra.get("MANAGE_SENTRY_DSN") or "").strip()
    org = str(extra.get("SENTRY_ORG") or "").strip()
    if org and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", org):
        raise SetupError("Invalid Sentry organization slug for Manage")
    if dsn:
        parsed = urlsplit(dsn)
        if (parsed.scheme != "https" or not parsed.username or parsed.password
                or not re.fullmatch(r"[A-Fa-f0-9]{12,64}", parsed.username)
                or not parsed.hostname or not parsed.hostname.endswith(".sentry.io")
                or not re.fullmatch(r"/[0-9]+/?", parsed.path)
                or parsed.query or parsed.fragment):
            raise SetupError("MANAGE_SENTRY_DSN must be a valid public Sentry HTTPS ingest DSN")
    return dsn, org


def export_browser_sentry(config: dict) -> None:
    """Provide the same public DSN to Vite without a separate secret or token."""
    dsn, org = public_sentry_settings(config)
    output = os.environ.get("GITHUB_ENV")
    if not output:
        raise SetupError("GITHUB_ENV unavailable for browser Sentry config")
    with open(output, "a", encoding="utf8") as handle:
        if dsn:
            handle.write("VITE_MANAGE_SENTRY_DSN=" + dsn + "\n")
        if org:
            handle.write("VITE_MANAGE_SENTRY_ORG=" + org + "\n")
        sha = os.environ.get("GITHUB_SHA", "")
        if re.fullmatch(r"[a-f0-9]{40}", sha):
            handle.write("VITE_MANAGE_RELEASE=" + sha + "\n")
    print("Manage browser Sentry ingest:", "configured" if dsn else "disabled")



def publish(config: dict, *, apply: bool) -> dict[str, object]:
    extra = config.get("extra_environment", {})
    sentry_dsn, sentry_org = public_sentry_settings(config)
    raw_emails = extra.get("MANAGE_ACCESS_ALLOWED_EMAILS", "")
    try:
        emails = json.loads(raw_emails)
    except (ValueError, TypeError):
        emails = None
    if (config.get("project_id") != "photointel"
            or not isinstance(emails, list) or not emails
            or any(not isinstance(e, str) or not re.fullmatch(r"[^@\s]+@[^@\s]+", e)
                   for e in emails)):
        raise SetupError("Configure a dedicated MANAGEMENT admin allowlist in "
                         "extra_environment.MANAGE_ACCESS_ALLOWED_EMAILS as a JSON array")
    api = client(config)
    apps = api.pages(api.base + "/access/apps")
    domains = api.pages(api.base + "/workers/domains")
    occupied = [d for d in domains if d.get("hostname") == DOMAIN]
    if any(d.get("service") != WORKER_NAME for d in occupied):
        raise SetupError("The management hostname is already bound to a different Worker; refusing to replace it")
    idps = api.pages(api.base + "/access/identity_providers")
    otp = [x for x in idps if x.get("type") == "onetimepin"]
    if not otp and apply:
        otp = [api.write("POST", api.base + "/access/identity_providers",
                         {"name": "PhotoIntel Manage PIN", "type": "onetimepin", "config": {}})]
    app = reconcile_app(
        api, apps, APP_NAME, [DOMAIN], None,
        [policy(sorted({e.casefold() for e in emails}))], apply,
        [x["id"] for x in otp],
    )
    result: dict[str, object] = {
        "domain": DOMAIN, "worker": WORKER_NAME,
        "access": app.get("id") if app else None,
        "mode": "apply" if apply else "plan",
    }
    if not apply:
        print(json.dumps(result))
        return result
    if not app or not isinstance(app.get("aud"), str) or not app["aud"]:
        raise SetupError("Cloudflare Access did not return a valid independent application AUD")
    if not (MANAGE / "dist/index.html").is_file():
        raise SetupError("Build apps/manage first with npm ci and npm run build")

    gh_token = secret_value(config, "MANAGE_GITHUB_API_TOKEN")
    if len(gh_token.strip()) < 20:
        raise SetupError("MANAGE_GITHUB_API_TOKEN secret is absent or invalid")
    cf_token = (secret_value(config, "MANAGE_CLOUDFLARE_API_TOKEN")
                if "MANAGE_CLOUDFLARE_API_TOKEN" in config.get("workflow_secrets", {})
                else secret_value(config, "CLOUDFLARE_API_TOKEN"))
    cf_account = secret_value(config, "CLOUDFLARE_ACCOUNT_ID")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", cf_account) or len(cf_token) < 20:
        raise SetupError("Invalid Cloudflare deployment credentials")

    # Test the exact version-pinned runtime tokens at deploy time (not the
    # GitHub connector's own identity). Continue publishing diagnostic UI even
    # when the provider denies the token, so the operator can inspect it.
    pat_version = str(config["workflow_secrets"]["MANAGE_GITHUB_API_TOKEN"]["version"])
    github_probe = probe_installed_credential(
        "GitHub PAT version " + pat_version + " / Actions",
        "https://api.github.com/repos/rodkisten/photointel/actions/runs?per_page=1",
        gh_token,
    )
    cf_probe = probe_installed_credential(
        "Cloudflare Manage runtime token / Workers",
        "https://api.cloudflare.com/client/v4/accounts/" + cf_account + "/workers/scripts",
        cf_token,
    )
    for outcome in (github_probe, cf_probe):
        print(("::notice::" if "HTTP 200" in outcome else "::warning::") +
              "Manage credential preflight: " + outcome)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf8") as handle:
            handle.write("### Manage credential preflight (read-only)\n\n")
            for outcome in (github_probe, cf_probe):
                handle.write("- " + outcome + "\n")
            handle.write("\nNo secret values were logged.\n")

    # These identifiers are not credentials. Use the dedicated provider
    # provisioned by GCP bootstrap instead of silently disabling GCP integration.
    expected_wif = (
        "//iam.googleapis.com/projects/799387180206/locations/global/"
        "workloadIdentityPools/manage/providers/cloudflare-access"
    )
    expected_account = "photointel-manage@photointel.iam.gserviceaccount.com"
    wif = extra.get("MANAGE_GCP_WIF_AUDIENCE") or expected_wif
    impersonate = extra.get("MANAGE_GCP_IMPERSONATE_SERVICE_ACCOUNT") or expected_account
    if wif != expected_wif or impersonate != expected_account:
        raise SetupError(
            "Manage GCP WIF must use the dedicated photointel-manage pool/provider and read-only SA"
        )
    # Only used by this management Worker, never the public PhotoIntel Worker
    # or the Cloud Run API/Jobs. No JSON service-account keys are created.
    wrangler = {
        "name": WORKER_NAME,
        "main": "src/worker.ts",
        "compatibility_date": "2026-11-01",
        "workers_dev": False,
        "preview_urls": False,
        "observability": {
            "enabled": True,
            "logs": {"enabled": True, "invocation_logs": False},
        },
        "assets": {
            "directory": "./dist", "binding": "ASSETS",
            "run_worker_first": True,
            "not_found_handling": "single-page-application",
        },
        "routes": [{"pattern": DOMAIN, "custom_domain": True}],
        "vars": {
            "ACCESS_TEAM_DOMAIN": config["access_team_domain"],
            "ACCESS_AUDIENCE": app["aud"],
            "ACCESS_ALLOWED_EMAILS": json.dumps(emails),
            "GITHUB_REPO": "rodkisten/photointel",
            "GITHUB_ENVIRONMENT": "production",
            # Non-secret evidence of which pinned version last populated the
            # runtime GITHUB_API_TOKEN. Does not reveal any token material.
            "GITHUB_TOKEN_SECRET_VERSION":
                str(config["workflow_secrets"]["MANAGE_GITHUB_API_TOKEN"]["version"]),
            "GCP_PROJECT_ID": "photointel",
            "GCP_REGION": config.get("region", "us-central1"),
            **({"CLOUDFLARE_ACCOUNT_ID": cf_account}),
            **({"GCP_WIF_AUDIENCE": wif} if wif else {}),
            **({"GCP_IMPERSONATE_SERVICE_ACCOUNT": impersonate} if impersonate else {}),
            **({"SENTRY_ORG": sentry_org} if sentry_org else {}),
            **({"SENTRY_DSN": sentry_dsn} if sentry_dsn else {}),
        },
    }
    env = os.environ.copy()
    env.update(CLOUDFLARE_API_TOKEN=secret_value(config, "CLOUDFLARE_API_TOKEN"),
               CLOUDFLARE_ACCOUNT_ID=cf_account, WRANGLER_SEND_METRICS="false")
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf8", suffix=".json",
                                         dir=MANAGE, prefix=".manage-deploy-",
                                         delete=False) as out:
            temp_path = Path(out.name)
            temp_path.chmod(0o600)
            json.dump(wrangler, out)
        run(["npx", "--yes", "wrangler@4", "deploy", "--config", str(temp_path)], env=env)
        secrets = {"GITHUB_API_TOKEN": gh_token,
                   "CLOUDFLARE_API_TOKEN": cf_token}
        if "MANAGE_SENTRY_API_TOKEN" in config.get("workflow_secrets", {}):
            secrets["SENTRY_API_TOKEN"] = secret_value(config, "MANAGE_SENTRY_API_TOKEN")
        # stdin avoids storing secrets in arguments, config files or CLI logs.
        for name, value in secrets.items():
            run(["npx", "--yes", "wrangler@4", "secret", "put", name,
                 "--name", WORKER_NAME], env=env, stdin=value + "\n")
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)
    print("PhotoIntel Manage published to https://" + DOMAIN)
    return result


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("plan", "apply", "browser-env"):
            raise SetupError("Use: deploy_manage.py plan|apply|browser-env")
        if sys.argv[1] == "browser-env":
            export_browser_sentry(read_config())
        else:
            result = publish(read_config(), apply=sys.argv[1] == "apply")
            summary = os.environ.get("GITHUB_STEP_SUMMARY")
            if summary:
                with open(summary, "a", encoding="utf8") as f:
                    f.write("### PhotoIntel Manage\n\n" + json.dumps(result, indent=2) + "\n")
    except (SetupError, ValueError) as exc:
        print("Manage deploy failed: " + str(exc), file=sys.stderr)
        sys.exit(1)
