"""Persist and verify Terraform saved plans in the private state bucket.

Plan files may contain secrets. Never upload them as public Actions artifacts.
Terraform itself rejects a saved plan if remote state changed.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOTS = {
    "gcp": pathlib.Path("infra/terraform/environments/production"),
    "cloudflare": pathlib.Path("infra/terraform/environments/cloudflare"),
}


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Missing {name}")
    return value


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def context():
    scope = required("TF_SCOPE")
    if scope not in ROOTS:
        raise ValueError("Unsupported Terraform scope")
    bucket = required("TF_PLAN_BUCKET")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,221}", bucket):
        raise ValueError("Invalid bucket")
    sha = required("GITHUB_SHA")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Invalid Git commit SHA")
    root = ROOTS[scope]
    config = pathlib.Path("infra/gcp/config.local.json")
    return {
        "scope": scope,
        "sha": sha,
        "root": root,
        "bucket": bucket,
        "config_sha256": checksum(config),
        "runtime_targets": os.environ.get("TF_RUNTIME_TARGETS", "api,jobs") if scope == "gcp" else "",
        "api_sha": os.environ.get("TF_API_SHA", "") if scope == "gcp" else "",
        "image_sha": os.environ.get("TF_IMAGE_SHA", "") if scope == "gcp" else "",
    }


def run(*args):
    subprocess.run(args, check=True, timeout=180)


def latest_plan_id(ctx):
    """Find newest matching plan; never silently select an incompatible plan."""
    prefix = f"gs://{ctx['bucket']}/terraform-reviewed-plans/{ctx['scope']}/"
    result = subprocess.run(
        ["gcloud", "storage", "ls", prefix + "*/manifest.json"],
        capture_output=True, text=True, check=True, timeout=120,
    )
    ids = set()
    for line in result.stdout.splitlines():
        match = re.fullmatch(re.escape(prefix) + r"([0-9]{1,20})/manifest[.]json", line.strip())
        if match:
            ids.add(match.group(1))
    if not ids:
        raise ValueError("No saved plans for this scope. Run Plan first.")
    # GitHub run IDs are monotonically increasing. Only use the latest
    # successful Plan, never fall back to an older plan without permission.
    return str(max(map(int, ids)))


def main():
    action = sys.argv[1]
    ctx = context()
    if action == "save":
        run_id = required("GITHUB_RUN_ID")
    elif action == "restore":
        run_id = os.environ.get("PLAN_RUN_ID", "").strip() or latest_plan_id(ctx)
    else:
        raise ValueError("Expected save or restore")
    if not re.fullmatch(r"[0-9]{1,20}", run_id):
        raise ValueError("Plan run ID must be numeric")
    uri = f"gs://{ctx['bucket']}/terraform-reviewed-plans/{ctx['scope']}/{run_id}"
    plan = ctx["root"] / "tfplan"
    manifest = ctx["root"] / "tfplan-manifest.json"
    if action == "save":
        if not plan.is_file():
            raise ValueError("Plan was not generated")
        metadata = {k: v for k, v in ctx.items() if k not in ("root", "bucket")}
        metadata.update(
            run_id=run_id,
            plan_sha256=checksum(plan),
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        manifest.write_text(json.dumps(metadata, sort_keys=True))
        run("gcloud", "storage", "cp", str(plan), uri + "/tfplan")
        run("gcloud", "storage", "cp", str(manifest), uri + "/manifest.json")
        print(f"Reviewed plan stored privately. Apply with plan_run_id={run_id}")
    else:
        # Download the manifest before the binary. A missing plan is fatal.
        run("gcloud", "storage", "cp", uri + "/manifest.json", str(manifest))
        metadata = json.loads(manifest.read_text())
        for key in ("scope", "sha", "config_sha256", "runtime_targets", "api_sha", "image_sha"):
            if metadata.get(key) != ctx[key]:
                raise ValueError(f"Reviewed plan mismatch: {key}. Run a new plan.")
        if metadata.get("run_id") != run_id:
            raise ValueError("Plan run ID mismatch")
        created = datetime.fromisoformat(metadata["created_at"])
        if (datetime.now(timezone.utc) - created).total_seconds() > 86400:
            raise ValueError("Plan expired (24h). Run a new plan.")
        run("gcloud", "storage", "cp", uri + "/tfplan", str(plan))
        if checksum(plan) != metadata.get("plan_sha256"):
            raise ValueError("Plan checksum mismatch")
        print(f"Verified saved plan from run {run_id}; Terraform will check remote state on apply.")


if __name__ == "__main__":
    main()
