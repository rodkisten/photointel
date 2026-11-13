"""Adopt API/finite Jobs without rebuilding, losing live settings or secret data."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

from infra.gcp.cloud_cli import classify, run as cloud_run
from infra.gcp.manage import MODES, SECRET_FIELDS, job, service
from infra.gcp.release_image import parse_release_digest
from infra.terraform.media_release import ROOT

DIGEST = re.compile(r"^us-central1-docker[.]pkg[.]dev/photointel/photointel/api@sha256:[a-f0-9]{64}$")


def lookup(args, *, missing=False):
    result = cloud_run(args, project="photointel")
    if result.returncode:
        failure = classify(result.stderr)
        if missing and failure.code == "NOT_FOUND":
            return None
        raise RuntimeError(f"Cloud Run/registry inventory failed: {failure.code} {failure.hint}")
    return json.loads(result.stdout)


def image_digest(image: str, region: str) -> str:
    if DIGEST.fullmatch(image):
        return image
    name, _, sha = image.rpartition(":")
    if name != "us-central1-docker.pkg.dev/photointel/photointel/api" or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("API image must be a full source SHA tag or an immutable PhotoIntel digest")
    listing = lookup(["artifacts", "docker", "images", "list", name, "--include-tags", "--format=json"])
    digest = parse_release_digest(json.dumps(listing), sha)
    if not digest:
        raise RuntimeError("Requested API image is not published; build once before deploying")
    return name + "@" + digest


def env_spec(entries: list[dict]) -> list[dict]:
    """Preserve secret references and report all unsafe plaintext bindings at once."""
    result = []
    unsafe = []
    for entry in entries:
        name = entry["name"]
        if "valueFrom" in entry:
            ref = entry["valueFrom"]["secretKeyRef"]
            result.append({"name": name, "secret": ref["name"], "version": str(ref["key"])})
        elif name != "TELEGRAM_NOTIFICATION_API_TOKEN" and (name in SECRET_FIELDS or re.search(r"(?:^|_)(?:PASSWORD|PRIVATE_KEY|API_KEY|SECRET|TOKEN)$", name)):
            unsafe.append(name)
        else:
            result.append({"name": name, "value": str(entry.get("value", ""))})
    if unsafe:
        names = ", ".join(sorted(set(unsafe)))
        guidance = (
            "Terraform adoption blocked: sensitive Cloud Run environment variables "
            "are configured as literal values, not Secret Manager references. "
            "A secret existing in Secret Manager is insufficient; the Cloud Run "
            "service or Job revision must reference it via valueFrom.secretKeyRef. "
            "Affected variables: " + names + ". "
            "Inspect the Cloud Run service/Job environment configuration (not secret values). "
            "Update each binding to reference the existing Secret Manager secret/version "
            "and ensure its runtime service account can access it. "
            "No secret values were printed; do not paste them into logs or Terraform."
        )
        print("::group::🔐 Terraform · Secret Manager reference check", flush=True)
        print("::error title=Cloud Run secrets need references::" + guidance, flush=True)
        print("::endgroup::", flush=True)
        raise ValueError(guidance)
    if len({e["name"] for e in result}) != len(result):
        raise ValueError("Duplicate runtime environment names")
    return result


def container_spec(desired: dict, live: dict | None, image: str) -> dict:
    current = live or desired
    if current.get("volumeMounts") or len(current.get("ports", [])) > 1:
        raise ValueError("Custom volumes/ports must be modeled before adoption")
    # Existing extra env survives; configured names remain authoritative.
    env = {e["name"]: e for e in current.get("env", [])}
    env.update({e["name"]: e for e in desired.get("env", [])})
    limits = dict(current.get("resources", desired["resources"])["limits"])
    if limits.get("cpu", "").endswith("m"):
        limits["cpu"] = format(int(limits["cpu"][:-1]) / 1000, "g")
    return {"image": image, "command": current.get("command", desired.get("command", [])),
            "args": current.get("args", desired.get("args", [])),
            "env": env_spec(list(env.values())), "limits": limits}


def invokers(policy: dict, *, name: str) -> dict:
    result = {}
    for binding in policy.get("bindings", []):
        if binding["role"] != "roles/run.invoker":
            continue
        for member in binding.get("members", []):
            item = {"member": member, "job": name}
            if "condition" in binding:
                item["condition"] = binding["condition"]
            key = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:24]
            result[key] = item
    return result


def prepare(config: dict, requested_sha: str = "", targets: str = "api,jobs") -> None:
    selected = set(targets.split(","))
    if not selected or selected - {"api", "jobs"}:
        raise ValueError("Runtime targets must be an api/jobs subset")
    if config["project_id"] != "photointel" or config["region"] != "us-central1":
        raise ValueError("Production adoption is restricted to photointel/us-central1")
    if requested_sha and not re.fullmatch(r"[a-f0-9]{40}", requested_sha):
        raise ValueError("API source SHA must be full lowercase hex")
    if requested_sha:
        subprocess.run(["git", "merge-base", "--is-ancestor", requested_sha, "HEAD"], check=True)
    state = subprocess.run(["terraform", "state", "list"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    imports = []
    definitions = {}
    api = lookup(["run", "services", "describe", "photointel-api", "--region", config["region"], "--format=json"], missing=True)
    if api is None:
        raise RuntimeError("Existing API not found; refusing to invent a new service during adoption")
    api_task = api["spec"]["template"]["spec"]
    if len(api_task["containers"]) != 1 or api_task.get("volumes"):
        raise ValueError("API sidecars or volumes require explicit modeling before adoption")
    annotations = api["spec"]["template"].get("metadata", {}).get("annotations", {})
    if any(k in annotations for k in ("run.googleapis.com/vpc-access-connector", "run.googleapis.com/network-interfaces", "run.googleapis.com/encryption-key")):
        raise ValueError("API networking/encryption must be modeled before adoption")
    live_container = api_task["containers"][0]
    if requested_sha and "api" in selected:
        image = image_digest("us-central1-docker.pkg.dev/photointel/photointel/api:" + requested_sha, config["region"])
        config["release_git_sha"] = requested_sha
    else:
        revision = api["status"].get("latestReadyRevisionName")
        if not revision:
            raise RuntimeError("API has no ready revision; inspect startup errors before adoption")
        ready = lookup(["run", "revisions", "describe", revision, "--region", config["region"], "--format=json"])
        image = image_digest(ready["status"]["imageDigest"], config["region"])
        config["release_git_sha"] = next((e["value"] for e in live_container.get("env", []) if e["name"] == "RELEASE_GIT_SHA" and "value" in e), config.get("release_git_sha", ""))
    desired = service(config)["spec"]["template"]["spec"]["containers"][0]
    definition = container_spec(desired if "api" in selected else live_container, live_container, image)
    ingress = api.get("metadata", {}).get("annotations", {}).get("run.googleapis.com/ingress", "all")
    ingress_names = {"all": "INGRESS_TRAFFIC_ALL", "internal": "INGRESS_TRAFFIC_INTERNAL_ONLY", "internal-and-cloud-load-balancing": "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"}
    for probe in ("startupProbe", "livenessProbe"):
        value = live_container.get(probe, desired.get(probe))
        if value and (value.get("grpc") or (probe == "livenessProbe" and not value.get("httpGet"))):
            raise ValueError("Custom API health probe requires explicit modeling")
        definition["startup_probe" if probe == "startupProbe" else "liveness_probe"] = value
    if api_task.get("serviceAccountName") != "photointel-api@photointel.iam.gserviceaccount.com":
        raise ValueError("Unexpected API runtime identity; model its IAM before adoption")
    definition.update({"session_affinity": annotations.get("run.googleapis.com/sessionAffinity", "false") == "true", "service_account": api_task.get("serviceAccountName", "photointel-api@photointel.iam.gserviceaccount.com"),
        "ingress": ingress_names[ingress], "concurrency": api_task.get("containerConcurrency", config["api_concurrency"]),
        "timeout": str(api_task.get("timeoutSeconds", config["api_timeout_seconds"])) + "s",
        "min_instances": int(annotations.get("autoscaling.knative.dev/minScale", 0)),
        "max_instances": int(annotations.get("autoscaling.knative.dev/maxScale", config["api_max_instances"])),
        "execution_environment": {"gen1": "EXECUTION_ENVIRONMENT_GEN1", "gen2": "EXECUTION_ENVIRONMENT_GEN2"}.get(annotations.get("run.googleapis.com/execution-environment")),
        "cpu_idle": annotations.get("run.googleapis.com/cpu-throttling", "true") == "true",
        "startup_cpu_boost": annotations.get("run.googleapis.com/startup-cpu-boost", "false") == "true",
        "port": live_container.get("ports", [{"containerPort": 8080}])[0]["containerPort"],
        "port_name": live_container.get("ports", [{}])[0].get("name", "http1"),
        "traffic": api["spec"].get("traffic", [{"latestRevision": True, "percent": 100}]),
    })
    if requested_sha and "api" in selected and any(not t.get("latestRevision") for t in definition["traffic"]):
        raise RuntimeError("API uses pinned/split traffic; review traffic migration before a new release")
    api_address = "google_cloud_run_v2_service.api[0]"
    if api_address not in state:
        imports.append({"to": api_address, "id": "projects/photointel/locations/us-central1/services/photointel-api"})
    api_policy = lookup(["run", "services", "get-iam-policy", "photointel-api", "--region", config["region"], "--format=json"])
    processing_iam = {}
    for mode in MODES:
        if mode == "migrate":
            continue
        live = lookup(["run", "jobs", "describe", f"photointel-{mode}", "--region", config["region"], "--format=json"], missing=True)
        address = f'google_cloud_run_v2_job.processing["{mode}"]'
        if live is None:
            if address in state:
                raise RuntimeError(f"Managed processing Job {mode} disappeared; investigate before recreating")
            # Do not create unused processors merely to adopt the API.
            continue
        spec = live["spec"]["template"]["spec"]
        task = spec["template"]["spec"]
        if len(task["containers"]) != 1 or task.get("volumes"):
            raise ValueError("Processing sidecars/volumes require explicit modeling")
        if task.get("serviceAccountName") != "photointel-jobs@photointel.iam.gserviceaccount.com":
            raise ValueError("Unexpected processing runtime identity; model its IAM before adoption")
        old = task["containers"][0]
        mode_config = dict(config)
        if requested_sha and "jobs" in selected:
            mode_config["release_git_sha"] = requested_sha
        else:
            mode_config["release_git_sha"] = next((e["value"] for e in old.get("env", []) if e["name"] == "RELEASE_GIT_SHA" and "value" in e), config["release_git_sha"])
        rendered = job(mode_config, mode)["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
        job_image = image_digest("us-central1-docker.pkg.dev/photointel/photointel/api:" + requested_sha, config["region"]) if requested_sha and "jobs" in selected else image_digest(old["image"], config["region"])
        definitions[mode] = container_spec(rendered if "jobs" in selected else old, old, job_image)
        definitions[mode].update({"task_count": spec.get("taskCount", 1), "parallelism": spec.get("parallelism", 1),
            "service_account": task.get("serviceAccountName", "photointel-jobs@photointel.iam.gserviceaccount.com"),
            "max_retries": task.get("maxRetries", 1), "timeout": str(task.get("timeoutSeconds", config["job_timeout_seconds"])) + "s"})
        if address not in state:
            imports.append({"to": address, "id": f"projects/photointel/locations/us-central1/jobs/photointel-{mode}"})
        policy = lookup(["run", "jobs", "get-iam-policy", f"photointel-{mode}", "--region", config["region"], "--format=json"])
        processing_iam.update(invokers(policy, name=mode))
    values = {"enable_api_service": True, "api_definition": definition, "processing_jobs": definitions,
              "api_invokers": invokers(api_policy, name="api"), "processing_invokers": processing_iam}
    for filename, value in (("api-release.auto.tfvars.json", values), ("api-imports.auto.tf.json", {"import": imports})):
        path = ROOT / filename
        path.write_text(json.dumps(value, indent=2) + "\n")
        path.chmod(0o600)
    print(f"API and {len(definitions)} processing Jobs inventoried; {len(imports)} declarative imports; image digests retained")


def verify():
    desired = json.loads((ROOT / "api-release.auto.tfvars.json").read_text())
    api = lookup(["run", "services", "describe", "photointel-api", "--region", "us-central1", "--format=json"])
    if not any(c["type"] == "Ready" and str(c["status"]).lower() == "true" for c in api["status"].get("conditions", [])):
        raise RuntimeError("API not Ready after Terraform Apply")
    actual = api["spec"]["template"]["spec"]["containers"][0]
    if actual["image"] != desired["api_definition"]["image"] or env_spec(actual.get("env", [])) != desired["api_definition"]["env"]:
        # Provider/API may reorder env entries; compare by name.
        if actual["image"] != desired["api_definition"]["image"] or {e["name"]: e for e in env_spec(actual.get("env", []))} != {e["name"]: e for e in desired["api_definition"]["env"]}:
            raise RuntimeError("API image/environment verification failed")
    for mode, expected in desired["processing_jobs"].items():
        live = lookup(["run", "jobs", "describe", f"photointel-{mode}", "--region", "us-central1", "--format=json"])
        task = live["spec"]["template"]["spec"]["template"]["spec"]
        if task["containers"][0]["image"] != expected["image"] or task["serviceAccountName"] != expected["service_account"]:
            raise RuntimeError(f"Processing Job {mode} verification failed")
    print(f"Verified API readiness, image/environment and {len(desired['processing_jobs'])} processing Job images/runtime identities")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "verify"])
    parser.add_argument("--image-sha", default="")
    parser.add_argument("--targets", default="api,jobs")
    args = parser.parse_args()
    if args.action == "prepare":
        from infra.scripts.prepare_workflow_env import read_config
        prepare(read_config(), args.image_sha, args.targets)
    else:
        verify()
