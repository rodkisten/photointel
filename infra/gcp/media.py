"""Media Engine Cloud Run job provisioning through the shared cloud_cli transport.

The default is a non-mutating plan. This module deliberately does not enable
APIs, modify billing, create buckets, grant public IAM, or deploy the main API.
Media images must already exist in the configured Artifact Registry repository.
"""
from __future__ import annotations

import re
from typing import Any

from infra.gcp.cloud_cli import run as cloud_run, command as cloud_command

JOB_TYPES = ("image", "video")
REQUIRED_SECRET_ENV = (
    ("R2_ENDPOINT", "photointel-media-r2-endpoint"),
    ("R2_ACCESS_KEY_ID", "photointel-media-r2-access-key"),
    ("R2_SECRET_ACCESS_KEY", "photointel-media-r2-secret-key"),
)


def commands(config: dict[str, Any], sha: str) -> list[list[str]]:
    """Return explicit, reproducible gcloud argument arrays, never shell strings.

    The media job receives per-execution object keys via Cloud Run job overrides;
    no user-supplied object key is embedded into the provisioned job definition.
    """
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Media image requires an immutable full Git commit SHA")
    project, region, repository = (
        config["project_id"], config["region"], config["repository"]
    )
    bucket = config["storage_bucket"]
    commands_out: list[list[str]] = []
    for kind in JOB_TYPES:
        image = f"{region}-docker.pkg.dev/{project}/{repository}/media-{kind}:{sha}"
        name = f"photointel-media-{kind}"
        args = [
            "run", "jobs", "deploy", name,
            "--region", region,
            "--image", image,
            "--tasks", "1",
            "--parallelism", "1",
            "--max-retries", "0",
            "--task-timeout", "1800s" if kind == "video" else "600s",
            "--cpu", "2" if kind == "video" else "1",
            "--memory", "2Gi" if kind == "video" else "1Gi",
            "--set-env-vars", f"R2_BUCKET={bucket}",
        ]
        args += ["--service-account", f"photointel-media@{project}.iam.gserviceaccount.com"]
        args += ["--update-secrets", ",".join(
            f"{env_name}={secret_name}:latest" for env_name, secret_name in REQUIRED_SECRET_ENV
        )]
        commands_out.append(args)
    return commands_out


def execute(config: dict[str, Any], sha: str, *, apply: bool) -> None:
    """Use the same command renderer, redaction and execution path as manage.py."""
    for args in commands(config, sha):
        invocation = cloud_command(args, project=config["project_id"])
        if apply:
            result = cloud_run(args, project=config["project_id"], timeout=1800)
            if result.returncode:
                raise RuntimeError("Media job deployment failed; inspect Cloud Logging")
        else:
            # cloud_cli prints full-width highlighted command panels when run.
            from infra.gcp.cloud_cli import print_running_command
            print_running_command(invocation)
    if not apply:
        print("PLAN ONLY: no Cloud Run jobs were created or updated.")
