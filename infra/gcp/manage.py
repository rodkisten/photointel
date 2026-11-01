#!/usr/bin/env python3
"""Reproducible Google Cloud operations; default is an offline, reviewable plan.

No shell interpolation and no account/resource mutation without two explicit flags.
Configuration contains secret *references*, never secret values.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
MODES = ("discover", "backfill", "worker", "maintenance", "migrate")
SCHEDULED = ("discover", "worker", "maintenance")
SCOPES = "https://www.googleapis.com/auth/cloud-platform"
SECRET_FIELDS = {
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "STORAGE_ACCESS_KEY",
    "STORAGE_SECRET_KEY",
    "BRIDGE_TOKEN_PEPPER",
    "BRIDGE_ENROLLMENT_SECRET",
    "ICLOUD_SESSION_KEY",
    "MODAL_TOKEN",
    "MODAL_PROXY_KEY",
    "MODAL_PROXY_SECRET",
    "NOTIFY_DEVICE_ID",
    "NOTIFY_TOKEN",
    "SENTRY_DSN",
    "SENTRY_API_TOKEN",
}
WORKFLOW_SECRET_FIELDS = {
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "TS_OAUTH_CLIENT_ID",
    "TS_OAUTH_SECRET",
    "SENTRY_AUTH_TOKEN",
}
API_SECRETS = SECRET_FIELDS - {"MIGRATION_DATABASE_URL", "ICLOUD_SESSION_KEY"}
REQUIRED_SECRETS = SECRET_FIELDS - {
    "MODAL_TOKEN",
    "MODAL_PROXY_KEY",
    "MODAL_PROXY_SECRET",
    "NOTIFY_DEVICE_ID",
    "NOTIFY_TOKEN",
    "SENTRY_DSN",
    "SENTRY_API_TOKEN",
}
SERVICES = (
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "logging.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
)
ROLES = ("api", "jobs", "migrate", "scheduler", "builder", "deployer")
PROTECTED_ENV = {
    "APP_ENV",
    "AUTH_MODE",
    "GPU_ENABLED",
    "ICLOUD_ENABLED",
    "INFERENCE_BACKEND",
    "APPLE_NATIVE_WRITE_ENABLED",
    "AUTO_DELETE_ENABLED",
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "ACCESS_ALLOWED_EMAILS",
    "INITIAL_IMPORT_LIMIT",
    "INGESTION_IMPORT_LIMIT",
    "STORAGE_BACKEND",
    "GCP_PROJECT_ID",
    "GCP_REGION",
    "GCP_JOB_DISPATCH_ENABLED",
    "NOTIFY_JOB_EVENTS_ENABLED",
    "EXECUTION_PLATFORM",
    "VERIFICATION_GATES_ENFORCED",
    "TEMP_DIRECTORY",
    "ICLOUD_SESSION_DIRECTORY",
    "ICLOUD_DOWNLOAD_DIRECTORY",
    "RELEASE_GIT_SHA",
    "RELEASE_BRANCH",
}


class ConfigurationError(ValueError):
    """Invalid non-secret deployment configuration."""


def https_origin(value: str, *, path_allowed: bool = False) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or (not path_allowed and parsed.path not in {"", "/"})
    ):
        raise ConfigurationError("Expected an HTTPS origin without credentials")
    return value.rstrip("/")


def validate(config: dict[str, Any], *, production: bool = False) -> dict[str, Any]:
    """Reject arbitrary command/identity/secret injection before provider operations."""
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", config["project_id"]):
        raise ConfigurationError("Invalid Google Cloud project ID")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", config["region"]):
        raise ConfigurationError("Invalid Google Cloud region")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,61}[a-z0-9]", config["repository"]):
        raise ConfigurationError("Invalid Artifact Registry repository")
    prefix = (
        f"{config['region']}-docker.pkg.dev/{config['project_id']}/"
        f"{config['repository']}/api"
    )
    image = config["image"]
    if not re.fullmatch(
        re.escape(prefix) + r"(?:@sha256:[a-f0-9]{64}|:[a-f0-9]{40})", image
    ) and (production or "REPLACE_GIT_SHA" not in image):
        raise ConfigurationError("Image must use a SHA-256 digest or full Git commit tag")
    release_sha = config.get("release_git_sha") or image.rsplit(":", 1)[-1]
    image_tag = image.rsplit(":", 1)[-1]
    if re.fullmatch(r"[a-f0-9]{40}", image_tag) and release_sha != image_tag:
        raise ConfigurationError("Release SHA must match the image commit tag")
    if production and not re.fullmatch(r"[a-f0-9]{40}", release_sha):
        raise ConfigurationError(
            "Digest images require release_git_sha with source commit"
        )
    if not re.fullmatch(r"[A-Za-z0-9_./-]{1,100}", config.get("release_branch", "main")):
        raise ConfigurationError("Invalid release branch")
    for name in ("frontend_origin", "api_origin", "storage_endpoint"):
        https_origin(config[name])
    if not re.fullmatch(
        r"[a-z0-9-]+\.cloudflareaccess\.com", config["access_team_domain"]
    ):
        raise ConfigurationError("Invalid Access team domain")
    if not config["access_audience"] or len(config["access_audience"]) > 256:
        raise ConfigurationError("Invalid Access audience")
    emails = config["access_allowed_emails"]
    if not isinstance(emails, list) or not 1 <= len(emails) <= 100:
        raise ConfigurationError("Configure a bounded trusted email allowlist")
    if any(not re.fullmatch(r"[^\s@]+@[^\s@]+", email) for email in emails):
        raise ConfigurationError("Invalid allowlisted email")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", config["storage_bucket"]):
        raise ConfigurationError("Invalid private storage bucket")
    for name, low, high in (
        ("api_max_instances", 1, 30),
        ("api_concurrency", 1, 80),
        ("api_timeout_seconds", 10, 3600),
        ("job_task_count", 1, 32),
        ("job_parallelism", 1, 32),
        ("job_max_jobs", 1, 10000),
        ("job_deadline_seconds", 30, 82800),
        ("job_timeout_seconds", 60, 86400),
        ("database_catalog_limit", 100, 10000000),
    ):
        if type(config[name]) is not int or not low <= config[name] <= high:
            raise ConfigurationError(f"{name} must be an integer from {low} to {high}")
    if config["job_deadline_seconds"] + 60 > config["job_timeout_seconds"]:
        raise ConfigurationError("Reserve at least 60 seconds for graceful shutdown")
    if config["job_parallelism"] > config["job_task_count"]:
        raise ConfigurationError("Job parallelism must not exceed task count")
    if config["database_profile"] not in {"limited", "full"}:
        raise ConfigurationError("Unknown database profile")
    if (
        config["database_profile"] == "limited"
        and config["database_catalog_limit"] > 10000
    ):
        raise ConfigurationError("Limited database profile is capped at 10000 assets")
    secrets = config["secrets"]
    if not secrets.keys() >= REQUIRED_SECRETS or not secrets.keys() <= SECRET_FIELDS:
        raise ConfigurationError(
            "Missing required or unrecognized Secret Manager reference"
        )
    for reference in secrets.values():
        if set(reference) != {"name", "version"} or not re.fullmatch(
            r"[a-z][a-z0-9-]{0,254}", reference["name"]
        ):
            raise ConfigurationError("Invalid Secret Manager reference")
        if not re.fullmatch(r"[1-9][0-9]{0,9}", reference["version"]):
            raise ConfigurationError(
                "Pin a numeric secret version; latest is not reproducible"
            )
    workflow_refs = config.get("workflow_secrets", {})
    if not isinstance(workflow_refs, dict) or set(workflow_refs) - WORKFLOW_SECRET_FIELDS:
        raise ConfigurationError("Invalid workflow secret references")
    for reference in workflow_refs.values():
        if (
            not isinstance(reference, dict)
            or set(reference) != {"name", "version"}
            or not isinstance(reference["name"], str)
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,254}", reference["name"])
            or not isinstance(reference["version"], str)
            or not re.fullmatch(r"[1-9][0-9]{0,9}", reference["version"])
        ):
            raise ConfigurationError("Invalid workflow secret version or name")
    workflows = config.get("workflows", {})
    # Old Pages entries remain tolerated during migration, but never deployed.
    if not isinstance(workflows, dict) or set(workflows) - {"worker", "pages"}:
        raise ConfigurationError("Invalid workflows configuration")
    worker = workflows.get("worker", {})
    if (
        not isinstance(worker, dict)
        or set(worker) - {"name", "domain", "api_base_url"}
        or any(not isinstance(value, str) for value in worker.values())
    ):
        raise ConfigurationError("Invalid Worker workflow configuration")
    if worker.get("name") and not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", worker["name"]
    ):
        raise ConfigurationError("Invalid Cloudflare Worker name")
    if worker.get("name") and worker["name"] != "photointel":
        raise ConfigurationError(
            "Unified frontend/API deployment must reuse the existing photointel Worker"
        )
    if worker.get("domain") and (
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", worker["domain"])
        or "." not in worker["domain"]
    ):
        raise ConfigurationError("Invalid Worker custom domain")
    if worker.get("api_base_url"):
        https_origin(worker["api_base_url"])
    extra = config.get("extra_environment", {})
    if not isinstance(extra, dict) or any(
        not re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", key)
        or key in PROTECTED_ENV | SECRET_FIELDS
        or not isinstance(value, str)
        or len(value) > 8192
        for key, value in extra.items()
    ):
        raise ConfigurationError("Invalid extra environment; credentials require secrets")
    if any(
        re.search(r"PASSWORD|CREDENTIAL|SECRET|TOKEN|PRIVATE_KEY", key)
        and key != "ACCESS_BRIDGE_SERVICE_TOKENS"
        for key in extra
    ):
        raise ConfigurationError(
            "Secret-looking environment values must use Secret Manager"
        )
    if "ACCESS_BRIDGE_SERVICE_TOKENS" in extra:
        try:
            identifiers = json.loads(extra["ACCESS_BRIDGE_SERVICE_TOKENS"])
        except json.JSONDecodeError:
            raise ConfigurationError(
                "Bridge service identities must be a JSON list"
            ) from None
        if (
            not isinstance(identifiers, list)
            or not 1 <= len(identifiers) <= 100
            or any(
                not isinstance(value, str)
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,255}", value)
                for value in identifiers
            )
        ):
            raise ConfigurationError("Invalid public Bridge service client identifiers")
    for name in ("enable_gpu", "enable_icloud"):
        if type(config.get(name, False)) is not bool:
            raise ConfigurationError(f"{name} must be an explicit boolean")
    if config.get("enable_icloud") and not all(
        config.get(name) for name in ("icloud_account", "icloud_library")
    ):
        raise ConfigurationError("Enabled iCloud requires account and selected library")
    if config.get("enable_gpu") and not (
        {"MODAL_TOKEN", "MODAL_PROXY_KEY", "MODAL_PROXY_SECRET"} <= secrets.keys()
        and extra.get("MODAL_ENDPOINT", "").startswith("https://")
    ):
        raise ConfigurationError(
            "Enabled GPU requires Modal endpoint and secret references"
        )
    if production:
        serialized = json.dumps(config)
        if (
            "REPLACE" in serialized
            or "replace" in serialized
            or ".example.com" in serialized
        ):
            raise ConfigurationError(
                "Replace every example placeholder before deployment"
            )
    return config


def identity(config: dict[str, Any], role: str) -> str:
    if role not in ROLES:
        raise ConfigurationError("Unknown service-account role")
    return f"photointel-{role}@{config['project_id']}.iam.gserviceaccount.com"


def environment(config: dict[str, Any], mode: str) -> list[dict[str, Any]]:
    values = {
        "APP_ENV": "production",
        "AUTH_MODE": "cloudflare",
        "EXECUTION_PLATFORM": "cloud_run",
        "VERIFICATION_GATES_ENFORCED": "true",
        "RELEASE_GIT_SHA": config.get("release_git_sha")
        or config["image"].rsplit(":", 1)[-1],
        "RELEASE_BRANCH": config.get("release_branch", "main"),
        "FRONTEND_ORIGIN": config["frontend_origin"],
        "API_ORIGIN": config["api_origin"],
        "ACCESS_TEAM_DOMAIN": config["access_team_domain"],
        "ACCESS_AUDIENCE": config["access_audience"],
        "ACCESS_ALLOWED_EMAILS": json.dumps(config["access_allowed_emails"]),
        "STORAGE_BACKEND": "r2",
        "STORAGE_ENDPOINT": config["storage_endpoint"],
        "STORAGE_BUCKET": config["storage_bucket"],
        "STORAGE_REGION": "auto",
        "GPU_ENABLED": str(config.get("enable_gpu", False)).lower(),
        "ICLOUD_ENABLED": str(config.get("enable_icloud", False)).lower(),
        "INFERENCE_BACKEND": "modal",
        "APPLE_NATIVE_WRITE_ENABLED": "false",
        "AUTO_DELETE_ENABLED": "false",
        "INITIAL_IMPORT_LIMIT": "100",
        "INGESTION_IMPORT_LIMIT": "100",
        "ICLOUD_ACCOUNT": config.get("icloud_account", ""),
        "ICLOUD_LIBRARY": config.get("icloud_library", ""),
        "TEMP_DIRECTORY": "/tmp/photointel/processing",
        "ICLOUD_SESSION_DIRECTORY": "/tmp/photointel/session",
        "ICLOUD_DOWNLOAD_DIRECTORY": "/tmp/photointel/downloads",
        "DATABASE_POOL_SIZE": "2",
        "DATABASE_MAX_OVERFLOW": "0",
        "DATABASE_POOL_MODE": "transaction",
        "DATABASE_REQUIRE_TLS": "true",
        # psycopg-binary bundles libpq/OpenSSL; use the Debian CA bundle explicitly.
        "DATABASE_TLS_CA_FILE": "/etc/ssl/certs/ca-certificates.crt",
        "DATABASE_PROFILE": config["database_profile"],
        "CATALOG_ASSET_LIMIT": str(config["database_catalog_limit"]),
        "ICLOUD_SESSION_BACKEND": "encrypted_object",
        "GCP_PROJECT_ID": config["project_id"],
        "GCP_REGION": config["region"],
        "GCP_JOB_DISPATCH_ENABLED": "false" if mode == "migrate" else "true",
        "NOTIFY_JOB_EVENTS_ENABLED": str(
            mode != "migrate"
            and {"NOTIFY_DEVICE_ID", "NOTIFY_TOKEN"} <= config["secrets"].keys()
        ).lower(),
    }
    values.update(config.get("extra_environment", {}))
    entries: list[dict[str, Any]] = [
        {"name": name, "value": value} for name, value in sorted(values.items())
    ]
    allowed = (
        API_SECRETS if mode == "api"
        else SECRET_FIELDS - {"MIGRATION_DATABASE_URL", "SENTRY_API_TOKEN"}
    )
    if mode == "migrate":
        allowed = {"DATABASE_URL", "MIGRATION_DATABASE_URL"}
    for key, reference in sorted(config["secrets"].items()):
        if key in allowed:
            entries.append(
                {
                    "name": key,
                    "valueFrom": {
                        "secretKeyRef": {
                            "name": reference["name"],
                            "key": reference["version"],
                        }
                    },
                }
            )
    return entries


def service(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {"name": "photointel-api", "namespace": config["project_id"]},
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "autoscaling.knative.dev/minScale": "0",
                        "autoscaling.knative.dev/maxScale": str(
                            config["api_max_instances"]
                        ),
                        "run.googleapis.com/cpu-throttling": "true",
                        "run.googleapis.com/startup-cpu-boost": "false",
                    }
                },
                "spec": {
                    "serviceAccountName": identity(config, "api"),
                    "containerConcurrency": config["api_concurrency"],
                    "timeoutSeconds": config["api_timeout_seconds"],
                    "containers": [
                        {
                            "image": config["image"],
                            "command": ["python"],
                            "args": ["/app/infra/gcp/entrypoint.py"],
                            "ports": [{"containerPort": 8080}],
                            "env": environment(config, "api"),
                            "resources": {"limits": {"cpu": "1000m", "memory": "1Gi"}},
                            "startupProbe": {
                                "httpGet": {"path": "/health/live", "port": 8080},
                                "periodSeconds": 10,
                                "timeoutSeconds": 5,
                                "failureThreshold": 12,
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/health/live", "port": 8080},
                                "periodSeconds": 30,
                                "timeoutSeconds": 5,
                                "failureThreshold": 3,
                            },
                        }
                    ],
                },
            }
        },
    }


def job(config: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode not in MODES:
        raise ConfigurationError("Unknown finite job mode")
    migration = mode == "migrate"
    task_count = (
        1
        if mode in {"discover", "backfill", "maintenance", "migrate"}
        else (config["job_task_count"])
    )
    return {
        "apiVersion": "run.googleapis.com/v1",
        "kind": "Job",
        "metadata": {"name": f"photointel-{mode}", "namespace": config["project_id"]},
        "spec": {
            "template": {
                "spec": {
                    "taskCount": task_count,
                    "parallelism": min(config["job_parallelism"], task_count),
                    "template": {
                        "spec": {
                            "serviceAccountName": identity(
                                config, "migrate" if migration else "jobs"
                            ),
                            "maxRetries": 0 if migration else 1,
                            "timeoutSeconds": "1800"
                            if migration
                            else str(config["job_timeout_seconds"]),
                            "containers": [
                                {
                                    "image": config["image"],
                                    "command": ["python"],
                                    "args": [
                                        "-m",
                                        "photointel.services.task_runner",
                                        mode,
                                        "--max-jobs",
                                        str(config["job_max_jobs"]),
                                        "--deadline-seconds",
                                        "1700"
                                        if migration
                                        else str(config["job_deadline_seconds"]),
                                    ],
                                    "env": environment(config, mode),
                                    "resources": {
                                        "limits": {"cpu": "1000m", "memory": "2Gi"}
                                    },
                                }
                            ],
                        }
                    },
                }
            }
        },
    }


def render(config: dict[str, Any], directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    paths = []
    for name, document in [("api", service(config))] + [
        (mode, job(config, mode)) for mode in MODES
    ]:
        path = directory / f"photointel-{name}.json"
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)
        paths.append(path)
    return paths



def verified_docker_digest(listing: str, git_sha: str) -> str:
    """Find the immutable digest for exactly one image carrying the release SHA tag."""
    try:
        images = json.loads(listing)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Artifact Registry did not return a valid JSON image list") from exc
    if not isinstance(images, list):
        raise RuntimeError("Artifact Registry image list must be a JSON array")
    matches = []
    for entry in images:
        if not isinstance(entry, dict):
            continue
        tags = entry.get("tags")
        if not isinstance(tags, list) or git_sha not in tags:
            continue
        digest = entry.get("version")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise RuntimeError("Artifact Registry returned an invalid digest for the release tag")
        matches.append(digest)
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly one Artifact Registry image tagged with release SHA; got {len(matches)}"
        )
    return matches[0]


class Runner:
    def __init__(self, config: dict[str, Any], apply: bool) -> None:
        self.config = config
        self.apply = apply

    def command(self, args: list[str], *, capture: bool = False) -> str:
        command = ["gcloud", *args, "--project", self.config["project_id"], "--quiet"]
        print(shlex.join(command), flush=True)
        if not self.apply:
            return ""
        result = subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            timeout=3600,
        )
        return result.stdout.strip() if capture else ""

    def ensure(self, query: list[str], create: list[str]) -> None:
        if self.apply:
            command = [
                "gcloud",
                *query,
                "--project",
                self.config["project_id"],
                "--quiet",
            ]
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            if result.returncode == 0:
                return
            if "NOT_FOUND" not in result.stderr and "does not exist" not in result.stderr:
                raise RuntimeError(
                    "Provider existence check failed; refusing ambiguous create"
                )
        self.command(create)


def bootstrap(runner: Runner) -> None:
    config = runner.config
    # gcloud services enable needs serviceusage.services.enable even when APIs
    # are already enabled. Avoid that unnecessary privileged mutation on retries.
    # This does NOT replace the administrative IAM needed for remaining bootstrap.
    if runner.apply:
        enabled = set(
            runner.command(
                ["services", "list", "--enabled", "--format=value(config.name)"],
                capture=True,
            ).splitlines()
        )
        missing = [api for api in SERVICES if api not in enabled]
        if missing:
            print("APIs not enabled: " + ", ".join(missing), flush=True)
            print(
                "Enabling APIs requires serviceusage.services.enable; "
                "use a project administrator for initial bootstrap.",
                flush=True,
            )
            runner.command(["services", "enable", *missing])
        else:
            print("All required APIs already enabled; skipping services enable.", flush=True)
    else:
        runner.command(["services", "list", "--enabled", "--format=value(config.name)"])
        runner.command(["services", "enable", *SERVICES])
    repository = config["repository"]
    region = config["region"]
    runner.ensure(
        ["artifacts", "repositories", "describe", repository, "--location", region],
        [
            "artifacts",
            "repositories",
            "create",
            repository,
            "--location",
            region,
            "--repository-format",
            "docker",
            "--description",
            "Private PhotoIntel images",
        ],
    )
    for role in ROLES:
        account = f"photointel-{role}"
        runner.ensure(
            ["iam", "service-accounts", "describe", identity(config, role)],
            [
                "iam",
                "service-accounts",
                "create",
                account,
                "--display-name",
                f"PhotoIntel {role}",
            ],
        )
    for reference in list(config["secrets"].values()) + list(
        config.get("workflow_secrets", {}).values()
    ):
        runner.ensure(
            ["secrets", "describe", reference["name"]],
            ["secrets", "create", reference["name"], "--replication-policy", "automatic"],
        )
    for role in ("api", "jobs", "migrate"):
        permitted = (
            API_SECRETS
            if role == "api"
            else (
                {"DATABASE_URL", "MIGRATION_DATABASE_URL"}
                if role == "migrate"
                else (SECRET_FIELDS - {"MIGRATION_DATABASE_URL"})
            )
        )
        for name in permitted & config["secrets"].keys():
            runner.command(
                [
                    "secrets",
                    "add-iam-policy-binding",
                    config["secrets"][name]["name"],
                    "--member",
                    f"serviceAccount:{identity(config, role)}",
                    "--role",
                    "roles/secretmanager.secretAccessor",
                ]
            )
    # Workflow credentials belong only to GitHub's WIF deploy identity.
    # API/worker/migration containers must never receive these references.
    deployer = f"serviceAccount:{identity(config, 'deployer')}"
    for reference in config.get("workflow_secrets", {}).values():
        runner.command([
            "secrets", "add-iam-policy-binding", reference["name"],
            "--member", deployer,
            "--role", "roles/secretmanager.secretAccessor",
        ])
    source_bucket = f"{config['project_id']}-photointel-build-source"
    runner.ensure(
        ["storage", "buckets", "describe", "gs://" + source_bucket],
        [
            "storage",
            "buckets",
            "create",
            "gs://" + source_bucket,
            "--location",
            region,
            "--uniform-bucket-level-access",
            "--public-access-prevention",
        ],
    )
    runner.command(
        [
            "storage",
            "buckets",
            "add-iam-policy-binding",
            "gs://" + source_bucket,
            "--member",
            f"serviceAccount:{identity(config, 'builder')}",
            "--role",
            "roles/storage.objectViewer",
        ]
    )
    runner.command(
        [
            "artifacts",
            "repositories",
            "add-iam-policy-binding",
            repository,
            "--location",
            region,
            "--member",
            f"serviceAccount:{identity(config, 'builder')}",
            "--role",
            "roles/artifactregistry.writer",
        ]
    )
    # GCP Terminal's explicit build action uses the separate bootstrap WIF SA.
    # It must read image metadata/digests and create the immutable :ready tag
    # after Docker push. Grant only on the production Artifact Registry repository.
    runner.command(
        [
            "artifacts",
            "repositories",
            "add-iam-policy-binding",
            repository,
            "--location",
            region,
            "--member",
            f"serviceAccount:photointel-bootstrap@{config['project_id']}.iam.gserviceaccount.com",
            "--role",
            "roles/artifactregistry.writer",
        ]
    )
    runner.command(
        [
            "projects",
            "add-iam-policy-binding",
            config["project_id"],
            "--member",
            f"serviceAccount:{identity(config, 'builder')}",
            "--role",
            "roles/logging.logWriter",
        ]
    )

    deployer = f"serviceAccount:{identity(config, 'deployer')}"
    for role in (
        "roles/run.admin",
        "roles/cloudscheduler.admin",
        "roles/cloudbuild.builds.editor",
        "roles/artifactregistry.reader",
        # Needed to show classified failed-revision logs without exposing secret values.
        "roles/logging.viewer",
        # Allows service usage (not API enablement); bootstrap itself uses an admin.
        "roles/serviceusage.serviceUsageConsumer",
    ):
        runner.command(
            [
                "projects",
                "add-iam-policy-binding",
                config["project_id"],
                "--member",
                deployer,
                "--role",
                role,
            ]
        )
    runner.command(
        [
            "storage",
            "buckets",
            "add-iam-policy-binding",
            "gs://" + source_bucket,
            "--member",
            deployer,
            "--role",
            "roles/storage.objectAdmin",
        ]
    )
    for role in ("api", "jobs", "migrate", "scheduler", "builder"):
        runner.command(
            [
                "iam",
                "service-accounts",
                "add-iam-policy-binding",
                identity(config, role),
                "--member",
                deployer,
                "--role",
                "roles/iam.serviceAccountUser",
            ]
        )


    runner.command(
        [
            "iam", "service-accounts", "add-iam-policy-binding",
            identity(config, "migrate"),
            "--member", deployer,
            "--role", "roles/iam.serviceAccountTokenCreator",
        ]
    )


def deploy_jobs(runner: Runner, directory: Path) -> None:
    config = runner.config
    for mode in MODES:
        # Alembic now runs from GitHub Actions directly against Neon.
        # Do not recreate the legacy photointel-migrate Cloud Run Job.
        if mode == "migrate":
            continue
        runner.command(
            [
                "run",
                "jobs",
                "replace",
                str(directory / f"photointel-{mode}.json"),
                "--region",
                config["region"],
            ]
        )
        accounts = [identity(config, "api"), identity(config, "jobs")]
        if mode in SCHEDULED:
            accounts.append(identity(config, "scheduler"))
        for account in accounts:
            runner.command(
                [
                    "run",
                    "jobs",
                    "add-iam-policy-binding",
                    f"photointel-{mode}",
                    "--region",
                    config["region"],
                    "--member",
                    f"serviceAccount:{account}",
                    "--role",
                    "roles/run.invoker",
                ]
            )


def scheduler(runner: Runner) -> None:
    config = runner.config
    schedules = {
        "discover": config["discovery_schedule"],
        "worker": config["worker_schedule"],
        "maintenance": config["maintenance_schedule"],
    }
    for mode, schedule in schedules.items():
        name = f"photointel-{mode}"
        uri = (
            f"https://run.googleapis.com/v2/projects/{config['project_id']}/"
            f"locations/{config['region']}/jobs/{name}:run"
        )
        # Create and update have different header flags. Always keep jobs paused
        # after reconciliation; the scheduler must never start ingestion by itself.
        command = "create"
        if runner.apply:
            result = subprocess.run(
                [
                    "gcloud",
                    "scheduler",
                    "jobs",
                    "describe",
                    name,
                    "--location",
                    config["region"],
                    "--project",
                    config["project_id"],
                    "--format=json",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0:
                command = "update"
            elif "NOT_FOUND" not in result.stderr:
                raise RuntimeError("Unable to verify scheduler job existence")
        runner.command(
            [
                "scheduler",
                "jobs",
                command,
                "http",
                name,
                "--location",
                config["region"],
                "--schedule",
                schedule,
                "--time-zone",
                config["scheduler_timezone"],
                "--uri",
                uri,
                "--http-method",
                "POST",
                "--headers" if command == "create" else "--update-headers",
                "Content-Type=application/json",
                "--message-body",
                "{}",
                "--oauth-service-account-email",
                identity(config, "scheduler"),
                "--oauth-token-scope",
                SCOPES,
                "--attempt-deadline",
                "60s",
                "--max-retry-attempts",
                "1",
            ]
        )
        runner.command(
            [
                "scheduler",
                "jobs",
                "pause",
                name,
                "--location",
                config["region"],
            ]
        )


def smoke(config: dict[str, Any], origin: str) -> dict[str, Any]:
    """Anonymous direct-origin probes must reject every private API route."""
    https_origin(origin)
    expected_host = urlsplit(origin).hostname or ""
    if not expected_host.endswith(".run.app"):
        raise ConfigurationError("Smoke origin must be the actual HTTPS run.app origin")
    checks = []
    for path in (
        "/v1/assets",
        "/v1/search/facets",
        "/v1/system/status",
        "/v1/apple-sync/status",
        "/v1/assets/00000000-0000-0000-0000-000000000000/media/thumbnail_small",
    ):
        request = urllib.request.Request(
            origin.rstrip("/") + path,
            headers={
                "Cf-Access-Authenticated-User-Email": config["access_allowed_emails"][0]
            },
        )

        # Reject redirects so an unexpected public response cannot masquerade as login.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
                return None

        try:
            with urllib.request.build_opener(NoRedirect()).open(
                request, timeout=30
            ) as response:
                status = response.status
        except urllib.error.HTTPError as exc:
            status = exc.code
        checks.append({"path": path, "status": status, "passed": status in {401, 403}})
    result = {"kind": "anonymous_origin_authentication", "checks": checks}
    if not all(check["passed"] for check in checks):
        raise RuntimeError("Direct Cloud Run origin authentication check failed")
    return result


def verify_backup_receipt(directory: Path, receipt_path: Path) -> None:
    """Operator-controlled integrity attestation, not a cryptographic authorization."""
    if directory.is_symlink() or receipt_path.is_symlink():
        raise ConfigurationError("Backup references must not be symlinks")
    header_path = directory / "backup.json"
    if (
        header_path.is_symlink()
        or not header_path.is_file()
        or header_path.stat().st_size > 65536
    ):
        raise ConfigurationError("Backup header is missing or too large")
    if not receipt_path.is_file() or receipt_path.stat().st_size > 65536:
        raise ConfigurationError("Backup verification receipt is missing or too large")
    manifest_path = directory / "manifest.enc"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ConfigurationError("Encrypted backup manifest is missing")
    if manifest_path.stat().st_size > 256 * 1024 * 1024 + 28:
        raise ConfigurationError(
            "Encrypted backup manifest exceeds the backup format limit"
        )
    with manifest_path.open("rb") as handle:
        manifest_digest = hashlib.file_digest(handle, "sha256").hexdigest()
    header = json.loads(header_path.read_text())
    receipt = json.loads(receipt_path.read_text())
    if (
        header.get("format") != "photointel-application-backup-v2"
        or not (directory / "manifest.enc").is_file()
        or not re.fullmatch(r"[a-f0-9]{32}", header.get("backup_id", ""))
        or not re.fullmatch(r"[a-f0-9]{64}", header.get("manifest_sha256", ""))
        or manifest_digest != header.get("manifest_sha256")
        or receipt.get("backup_id") != header["backup_id"]
        or receipt.get("manifest_sha256") != header["manifest_sha256"]
        or receipt.get("verification_kind") != "database-and-object-restore"
        or receipt.get("status") != "passed"
        or type(receipt.get("files_verified")) is not int
        or receipt["files_verified"] < 1
        or receipt.get("database_fingerprints_match") is not True
        or not isinstance(receipt.get("migration_heads"), list)
        or not receipt.get("migration_heads")
        or type(receipt.get("objects_restored_and_read_back")) is not int
        or receipt["objects_restored_and_read_back"] < 0
    ):
        raise ConfigurationError(
            "Backup requires a matching successful database-and-object restore receipt"
        )
    try:
        verified = datetime.fromisoformat(receipt["verified_at"])
        age = datetime.now(UTC) - verified
    except (KeyError, TypeError, ValueError):
        raise ConfigurationError("Invalid backup verification timestamp") from None
    if age < timedelta(minutes=-5) or age > timedelta(hours=24):
        raise ConfigurationError(
            "Re-verify a backup created before this migration (24h limit)"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "doctor",
            "bootstrap",
            "build",
            "render",
            "deploy",
            "jobs-deploy",
            "scheduler",
            "migrate",
            "smoke",
            "rollback",
            "cleanup",
            "secret-add",
        ],
    )
    parser.add_argument(
        "--config", type=Path, default=ROOT / "infra/gcp/config.local.json"
    )
    parser.add_argument("--output", type=Path, default=ROOT / "infra/gcp/rendered")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--authorize-charges", action="store_true")
    parser.add_argument("--confirm-project")
    parser.add_argument("--git-sha")
    parser.add_argument("--revision")
    parser.add_argument("--origin")
    parser.add_argument("--secret", choices=sorted(SECRET_FIELDS))
    parser.add_argument("--backup-directory", type=Path)
    parser.add_argument("--backup-receipt", type=Path)
    parser.add_argument("--initial-empty-database", action="store_true")
    args = parser.parse_args()
    config = validate(json.loads(args.config.read_text()), production=args.apply)
    if (
        args.apply
        and args.action not in {"doctor", "render", "smoke"}
        and (not args.authorize_charges or args.confirm_project != config["project_id"])
    ):
        parser.error(
            "Mutation requires --authorize-charges --confirm-project EXACT_PROJECT"
        )
    runner = Runner(config, args.apply)
    directory = args.output.resolve()
    if args.action in {"render", "deploy", "jobs-deploy"}:
        render(config, directory)
    if args.action == "render":
        print(json.dumps({"directory": str(directory), "resources": 6}))
    elif args.action == "doctor":
        runner.command(["version"])
        runner.command(
            ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]
        )
        runner.command(["projects", "describe", config["project_id"], "--format=json"])
        runner.command(["services", "list", "--enabled", "--format=value(config.name)"])
        runner.command(
            [
                "run",
                "services",
                "describe",
                "photointel-api",
                "--region",
                config["region"],
                "--format=json",
            ]
        )
    elif args.action == "secret-add":
        if args.secret not in config["secrets"]:
            raise ConfigurationError("Choose a configured secret field with --secret")
        name = config["secrets"][args.secret]["name"]
        command = [
            "gcloud",
            "secrets",
            "versions",
            "add",
            name,
            "--data-file=-",
            "--project",
            config["project_id"],
            "--quiet",
        ]
        print(shlex.join(command), flush=True)
        if args.apply:
            value = getpass.getpass("Secret value (hidden; never stored in config): ")
            if not value:
                raise ConfigurationError("Empty secret is not accepted")
            subprocess.run(command, input=value.encode(), check=True, timeout=60)
    elif args.action == "bootstrap":
        bootstrap(runner)
    elif args.action == "build":
        sha = (
            args.git_sha
            or subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip()
        )
        if not re.fullmatch(r"[a-f0-9]{40}", sha):
            raise ConfigurationError("Build requires a full Git commit SHA")
        image = config["image"].split("@")[0].rsplit(":", 1)[0] + ":" + sha
        manifest = ROOT / "release-manifest.json"
        if runner.apply:
            current = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip()
            if current != sha or manifest.exists():
                raise ConfigurationError(
                    "Build must match HEAD and not overwrite a manifest"
                )
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "infra/scripts/release-manifest.py"),
                    "--output",
                    str(manifest),
                ],
                cwd=ROOT,
                check=True,
                timeout=60,
            )
        try:
            runner.command(
                [
                    "builds",
                    "submit",
                    str(ROOT),
                    "--config",
                    str(ROOT / "infra/gcp/cloudbuild.yaml"),
                    "--substitutions",
                    f"_IMAGE_URI={image},_GIT_SHA={sha}",
                    "--ignore-file",
                    str(ROOT / "infra/gcp/build.gcloudignore"),
                    "--gcs-source-staging-dir",
                    f"gs://{config['project_id']}-photointel-build-source/source",
                    "--service-account",
                    f"projects/{config['project_id']}/serviceAccounts/"
                    + identity(config, "builder"),
                ]
            )
        finally:
            if runner.apply:
                manifest.unlink(missing_ok=True)
        # Listing digests/tags uses Artifact Registry Reader, without requiring
        # Container Analysis occurrence permissions needed by "images describe".
        image_name = image.rsplit(":", 1)[0]
        listing = runner.command(
            [
                "artifacts",
                "docker",
                "images",
                "list",
                image_name,
                "--include-tags",
                "--format=json",
            ],
            capture=True,
        )
        if runner.apply:
            digest = verified_docker_digest(listing, sha)
            print(
                f"Verified Artifact Registry image: {image_name}@{digest} "
                f"(commit {sha})",
                flush=True,
            )
    elif args.action == "deploy":
        runner.command(
            [
                "run",
                "services",
                "replace",
                str(directory / "photointel-api.json"),
                "--region",
                config["region"],
            ]
        )
        # Public network transport, authenticated inside FastAPI. Never call it private.
        runner.command(
            [
                "run",
                "services",
                "add-iam-policy-binding",
                "photointel-api",
                "--region",
                config["region"],
                "--member",
                "allUsers",
                "--role",
                "roles/run.invoker",
            ]
        )
    elif args.action == "jobs-deploy":
        deploy_jobs(runner, directory)
    elif args.action == "scheduler":
        scheduler(runner)
    elif args.action == "migrate":
        if args.apply and not args.initial_empty_database:
            if not args.backup_directory or not args.backup_receipt:
                raise ConfigurationError(
                    "Migration requires --backup-directory and --backup-receipt, "
                    "or explicit --initial-empty-database for a verified empty database"
                )
            verify_backup_receipt(args.backup_directory, args.backup_receipt)
        runner.command(
            [
                "run",
                "jobs",
                "execute",
                "photointel-migrate",
                "--wait",
                "--region",
                config["region"],
            ]
        )
    elif args.action == "rollback":
        if not args.revision or not re.fullmatch(
            r"photointel-api-[a-z0-9-]{1,45}", args.revision
        ):
            raise ConfigurationError("Specify the exact previously verified API revision")
        runner.command(
            [
                "run",
                "services",
                "update-traffic",
                "photointel-api",
                "--region",
                config["region"],
                "--to-revisions",
                args.revision + "=100",
            ]
        )
    elif args.action == "cleanup":
        # Pause only; never destroy the database, bucket, secret versions or images.
        for mode in SCHEDULED:
            runner.command(
                [
                    "scheduler",
                    "jobs",
                    "pause",
                    f"photointel-{mode}",
                    "--location",
                    config["region"],
                ]
            )
    elif args.action == "smoke":
        if not args.origin:
            raise ConfigurationError(
                "Specify --origin https://SERVICE-HASH-REGION.run.app"
            )
        if args.apply:
            print(json.dumps(smoke(config, args.origin), indent=2))
        else:
            print(
                "Offline plan: anonymous origin probes; no credentials or cloud mutation"
            )


if __name__ == "__main__":
    try:
        main()
    except (ConfigurationError, KeyError, json.JSONDecodeError) as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
