"""Media Engine Cloud Run job provisioning through the shared cloud_cli transport.

The default is a non-mutating plan. This module deliberately does not enable
APIs, modify billing, create buckets, grant public IAM, or deploy the main API.
Media images must already exist in the configured Artifact Registry repository.
"""
from __future__ import annotations

import re
import json
from typing import Any

from infra.gcp.cloud_cli import run as cloud_run, command as cloud_command, classify as cloud_classify

JOB_TYPES = ("image", "video")
REQUIRED_SECRET_ENV = (
    ("R2_ENDPOINT", "photointel-r2-endpoint"),
    ("R2_ACCESS_KEY_ID", "photointel-r2-access-key"),
    ("R2_SECRET_ACCESS_KEY", "photointel-r2-secret-key"),
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
    if apply:
        raise RuntimeError("Media Job deployment is owned by Terraform. Run TF · Production or Media · jobs-deploy; direct gcloud writes are disabled.")
    from infra.gcp.cloud_cli import print_running_command
    for args in commands(config, sha):
        print_running_command(cloud_command(args, project=config["project_id"]))
    print("PLAN ONLY: legacy command preview; deployment is owned by Terraform.")


def validate_job(job: dict[str, Any], config: dict[str, Any], kind: str, sha: str, *, image: str | None = None) -> None:
    """Check the deployed definition without printing secret values or provider JSON."""
    expected = commands(config, sha)[JOB_TYPES.index(kind)]
    task = job["spec"]["template"]["spec"]["template"]["spec"]
    container = task["containers"][0]
    checks = {
        "image": container.get("image") == (image or expected[expected.index("--image") + 1]),
        "service account": task.get("serviceAccountName") == expected[expected.index("--service-account") + 1],
        "retry policy": task.get("maxRetries", 0) == 0,
        "task count": job["spec"]["template"]["spec"].get("taskCount", 1) == 1,
        "parallelism": job["spec"]["template"]["spec"].get("parallelism", 1) == 1,
        "timeout": str(task.get("timeoutSeconds")) == ("1800" if kind == "video" else "600"),
        "CPU": str(container.get("resources", {}).get("limits", {}).get("cpu")) in (("2", "2000m") if kind == "video" else ("1", "1000m")),
        "memory": container.get("resources", {}).get("limits", {}).get("memory") == ("2Gi" if kind == "video" else "1Gi"),
        "readiness": any(c.get("type") == "Ready" and str(c.get("status")).lower() == "true" for c in job.get("status", {}).get("conditions", [])),
    }
    env = {e["name"]: e for e in container.get("env", [])}
    checks["bucket"] = env.get("R2_BUCKET", {}).get("value") == config["storage_bucket"]
    for name, secret in REQUIRED_SECRET_ENV:
        ref = env.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
        checks[f"secret reference {name}"] = ref.get("name") == secret and ref.get("key") == "latest"
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise RuntimeError(f"Media {kind} verification failed: " + ", ".join(failed))


def verify_jobs(config: dict[str, Any], sha: str) -> None:
    for kind in JOB_TYPES:
        result = cloud_run(["run", "jobs", "describe", f"photointel-media-{kind}",
                            "--region", config["region"], "--format=json"],
                           project=config["project_id"])
        if result.returncode:
            failure = cloud_classify(result.stderr)
            raise RuntimeError(f"Media {kind} verification failed: {failure.code} {failure.hint}")
        try:
            validate_job(json.loads(result.stdout), config, kind, sha)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise RuntimeError(f"Media {kind} verification returned an invalid Job definition") from None
        print(f"Verified photointel-media-{kind}: image source {sha}, runtime identity, secret references and resource settings.")
