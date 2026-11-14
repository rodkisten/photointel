#!/usr/bin/env python3
"""Conservative Artifact Registry prune: protect deployed digests and two successful builds.

Default mode only reports candidates. Fail closed on incomplete inventory.
"""
import argparse
import json
import re
import subprocess
from collections import defaultdict

PROJECT = "photointel"
REGION = "us-central1"
REPOSITORY = f"{REGION}-docker.pkg.dev/{PROJECT}/photointel"
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


def gcloud(*args):
    result = subprocess.run(
        ["gcloud", *args, f"--project={PROJECT}", "--format=json"],
        capture_output=True, text=True, check=True, timeout=120,
    )
    return json.loads(result.stdout or "null")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-project", default="")
    args = parser.parse_args()
    if args.apply and args.confirm_project != PROJECT:
        parser.error("Apply requires --confirm-project=photointel")

    images = gcloud("artifacts", "docker", "images", "list", REPOSITORY, "--include-tags")
    builds = gcloud("builds", "list", "--region=global", "--limit=1000")
    services = gcloud("run", "services", "list", f"--region={REGION}")
    jobs = gcloud("run", "jobs", "list", f"--region={REGION}")
    if not isinstance(images, list) or not isinstance(builds, list):
        raise RuntimeError("Incomplete image/build inventory; refusing to prune")
    protected = set()
    for service in services:
        name = service.get("metadata", {}).get("name") or service.get("name", "").split("/")[-1]
        if not name:
            raise RuntimeError("Service without name")
        detail = gcloud("run", "services", "describe", name, f"--region={REGION}")
        for container in detail.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
            protected.update(DIGEST.findall(container.get("image", "")))
        for container in detail.get("template", {}).get("containers", []):
            protected.update(DIGEST.findall(container.get("image", "")))
        # The live revision may differ from the current template. Protect it too.
        for status in detail.get("status", {}).get("traffic", []):
            revision = status.get("revisionName")
            if revision:
                revision_detail = gcloud("run", "revisions", "describe", revision, f"--region={REGION}")
                for container in revision_detail.get("spec", {}).get("containers", []):
                    protected.update(DIGEST.findall(container.get("image", "")))
    # Preserve *all* Cloud Run revisions, not only the currently routed one.
    revisions = gcloud("run", "revisions", "list", f"--region={REGION}")
    if not isinstance(revisions, list):
        raise RuntimeError("Incomplete Cloud Run revisions inventory")
    for revision in revisions:
        name = revision.get("metadata", {}).get("name") or revision.get("name", "").split("/")[-1]
        if not name:
            raise RuntimeError("Revision without name")
        detail = gcloud("run", "revisions", "describe", name, f"--region={REGION}")
        for container in detail.get("spec", {}).get("containers", []):
            protected.update(DIGEST.findall(container.get("image", "")))
    for job in jobs:
        name = job.get("metadata", {}).get("name") or job.get("name", "").split("/")[-1]
        if not name:
            raise RuntimeError("Job without name")
        detail = gcloud("run", "jobs", "describe", name, f"--region={REGION}")
        template = detail.get("spec", {}).get("template", {}).get("spec", {}).get("template", {}).get("spec", {})
        for container in template.get("containers", []):
            protected.update(DIGEST.findall(container.get("image", "")))
        for container in detail.get("template", {}).get("template", {}).get("containers", []):
            protected.update(DIGEST.findall(container.get("image", "")))

    # Only build SHA tags whose SUCCESS status is independently established are eligible.
    successes = set()
    for build in builds:
        if build.get("status") != "SUCCESS":
            continue
        source = build.get("source", {}).get("repoSource", {}).get("commitSha", "")
        substitutions = build.get("substitutions") or {}
        for value in (source, substitutions.get("COMMIT_SHA"), substitutions.get("_GIT_SHA")):
            if isinstance(value, str) and SHA.fullmatch(value.lower()):
                successes.add(value.lower())
    if not successes:
        raise RuntimeError("No successful builds with verifiable commit SHA; refusing cleanup")

    grouped = defaultdict(list)
    for item in images:
        package = item.get("package") or item.get("name", "").split("@")[0]
        digest = item.get("version") or item.get("digest") or ""
        found = DIGEST.search(digest)
        if not package or not found:
            raise RuntimeError("Image record lacks package/digest; refusing cleanup")
        tags = item.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        shas = {str(tag).rsplit(":", 1)[-1].lower() for tag in tags}
        timestamp = item.get("updateTime") or item.get("createTime") or ""
        grouped[package].append((timestamp, found.group(), shas))

    candidates = []
    for package, versions in sorted(grouped.items()):
        successful = sorted(
            (version for version in versions if version[2] & successes),
            reverse=True,
        )
        if len(successful) < 2:
            print(f"SKIP {package}: fewer than two verified successful versions")
            continue
        keep = {entry[1] for entry in successful[:2]} | protected
        for timestamp, digest, tags in versions:
            if digest in keep or any(tag.startswith("retain-") for tag in tags):
                continue
            # Never delete unverified or untagged builds automatically.
            if not tags or not tags & successes:
                continue
            candidates.append((package, digest))
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "protected_running_digests": len(protected),
        "verified_successful_shas": len(successes),
        "candidates": [f"{p}@{d}" for p, d in candidates],
    }, indent=2))
    if args.apply:
        for package, digest in candidates:
            subprocess.run(
                ["gcloud", "artifacts", "docker", "images", "delete",
                 f"{package}@{digest}", "--delete-tags", "--quiet",
                 f"--project={PROJECT}"],
                check=True, timeout=120,
            )


if __name__ == "__main__":
    main()
