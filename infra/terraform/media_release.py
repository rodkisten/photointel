"""Prepare safe Media adoption, review plans, and verify deployed Jobs.

Only metadata is read from Google Cloud. Imports are declarative: Plan shows
adoption before Apply; a failed describe never means permission to recreate.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from infra.gcp.cloud_cli import classify, run as cloud_run
from infra.gcp.media import JOB_TYPES, REQUIRED_SECRET_ENV, validate_job

ROOT = Path(__file__).resolve().parent / "environments/production"
SHA = re.compile(r"^[a-f0-9]{40}$")
INITIAL_SHA = "f6b667c5da7d49ee6d1d059ae8dd4f8159a477cc"


def terraform_json(*args: str, root: Path = ROOT):
    result = subprocess.run(["terraform", *args], cwd=root, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("Terraform metadata read failed; refusing to assume an empty state")
    return json.loads(result.stdout)


def release_settings(outputs: dict, requested: str, bucket: str) -> dict:
    current = outputs.get("media_release", {}).get("value", {})
    sha = requested or current.get("source_sha", INITIAL_SHA)
    selected_bucket = bucket or current.get("bucket", "photointel")
    if not SHA.fullmatch(sha):
        raise ValueError("A full lowercase source commit SHA is required")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", selected_bucket):
        raise ValueError("Invalid media bucket")
    # An unrelated apply must not resolve mutable tags again for an existing
    # release: preserve the exact digests saved by its successful Apply.
    digests = current.get("images", {}) if sha == current.get("source_sha") else {}
    return {"media_image_sha": sha, "media_bucket": selected_bucket,
            "media_image_digests": digests, "enable_media_jobs": True}


def describe(kind: str, project: str, region: str) -> dict | None:
    result = cloud_run(["run", "jobs", "describe", f"photointel-media-{kind}",
                        "--region", region, "--format=json"], project=project)
    if result.returncode:
        failure = classify(result.stderr)
        if failure.code == "NOT_FOUND":
            return None
        raise RuntimeError(f"Cannot inventory media-{kind}: {failure.code} {failure.hint}")
    return json.loads(result.stdout)


def adoption_imports(state: list[str], jobs: dict[str, dict | None], project: str, region: str) -> list[dict]:
    imports = []
    for kind, job in jobs.items():
        address = f'google_cloud_run_v2_job.media["{kind}"]'
        if job is None:
            if address in state:
                raise RuntimeError(f"Managed media-{kind} disappeared; investigate before recreating")
            continue
        # Unknown settings need explicit modeling, never silent loss on adoption.
        task = job["spec"]["template"]["spec"]["template"]["spec"]
        containers = task["containers"]
        allowed = {"R2_BUCKET", *(name for name, _ in REQUIRED_SECRET_ENV)}
        if len(containers) != 1 or any(e["name"] not in allowed for e in containers[0].get("env", [])):
            raise RuntimeError(f"media-{kind} has additional container configuration; model it before adoption")
        if any(task.get(key) for key in ("volumes", "vpcAccess", "encryptionKey")) or any(
            containers[0].get(key) for key in ("command", "args", "volumeMounts")
        ):
            raise RuntimeError(f"media-{kind} has custom execution settings; model them before adoption")
        if address not in state:
            imports.append({"to": address, "id": f"projects/{project}/locations/{region}/jobs/photointel-media-{kind}"})
    return imports


def review_plan(plan: dict) -> list[str]:
    changes = []
    for resource in plan.get("resource_changes", []):
        actions = resource["change"]["actions"]
        if "delete" in actions:
            raise RuntimeError(f"Destruction/replacement blocked: {resource['address']}")
        if resource.get("mode") == "managed" and actions != ["no-op"]:
            changes.append(f"{resource['address']}: {', '.join(actions)}")
    return changes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "review", "verify"])
    parser.add_argument("--image-sha", default="")
    parser.add_argument("--bucket", default="")
    parser.add_argument("--project", default="photointel")
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    if args.action == "prepare":
        settings = release_settings(terraform_json("output", "-json"), args.image_sha, args.bucket)
        # A typo or unrelated commit must not select an untraceable image release.
        for command in (["git", "cat-file", "-e", settings["media_image_sha"] + "^{commit}"],
                        ["git", "merge-base", "--is-ancestor", settings["media_image_sha"], "HEAD"]):
            subprocess.run(command, check=True)
        state = subprocess.run(["terraform", "state", "list"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
        jobs = {kind: describe(kind, args.project, args.region) for kind in JOB_TYPES}
        imports = adoption_imports(state, jobs, args.project, args.region)
        (ROOT / "media-release.auto.tfvars.json").write_text(json.dumps(settings, indent=2) + "\n")
        (ROOT / "media-imports.auto.tf.json").write_text(json.dumps({"import": imports}, indent=2) + "\n")
        print(f"Media source: {settings['media_image_sha']}; existing Jobs to import: {len(imports)}")
    elif args.action == "review":
        changes = review_plan(terraform_json("show", "-json", "tfplan", root=args.root))
        print("Plan reviewed: no deletion or replacement.\n" + "\n".join(changes))
    else:
        release = terraform_json("output", "-json")["media_release"]["value"]
        config = {"project_id": args.project, "region": args.region, "repository": "photointel", "storage_bucket": release["bucket"]}
        for kind in JOB_TYPES:
            job = describe(kind, args.project, args.region)
            if job is None:
                raise RuntimeError(f"media-{kind} missing after Apply")
            validate_job(job, config, kind, release["source_sha"], image=release["images"][kind])
            print(f"Verified photointel-media-{kind}: {release['images'][kind]}, runtime, secrets and resource settings")


if __name__ == "__main__":
    main()
