"""Adopt existing PhotoIntel Cloudflare infrastructure, keeping code in Wrangler.

Private state stores the adopted desired metadata, not credential material.
Resource JSON uses variable expressions, never templates built from API values.
The pinned provider schema is authoritative for supported writable attributes.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from infra.scripts.cloudflare_setup import client
from infra.scripts.prepare_workflow_env import read_config, secret_value

ROOT = Path(__file__).resolve().parent / "environments/cloudflare"
TYPES = {
    "domains": "cloudflare_workers_custom_domain",
    "applications": "cloudflare_zero_trust_access_application",
    "policies": "cloudflare_zero_trust_access_policy",
    "databases": "cloudflare_d1_database",
    "buckets": "cloudflare_r2_bucket",
    "crons": "cloudflare_workers_cron_trigger",
}
WORKERS = {"photos.migos.club": "photointel", "photos-manage.migos.club": "photointel-manage", "photos-hooks.migos.club": "photointel-manage"}


def terraform(*args):
    result = subprocess.run(["terraform", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("Cloudflare Terraform metadata read failed")
    return json.loads(result.stdout)


def supported_metadata(schema: dict, value: dict) -> dict:
    attributes = schema["block"]["attributes"]
    # SCIM credentials must never be adopted into state, even if API echoes them.
    if value.get("scim_config"):
        raise ValueError("SCIM configuration requires a separate secret-safe migration")
    return {key: item for key, item in value.items() if key in attributes
            and (attributes[key].get("optional") or attributes[key].get("required"))
            and item is not None and key not in {"scim_config"}}


def snapshot(api, config: dict) -> dict:
    account = api.account
    result = {key: {} for key in TYPES}
    domains = api.pages(api.base + "/workers/domains")
    for hostname, service in WORKERS.items():
        matches = [d for d in domains if d["hostname"] == hostname]
        if len(matches) != 1 or matches[0]["service"] != service:
            raise ValueError(f"Expected existing {hostname} on {service}; refusing to replace routing")
        result["domains"][hostname] = {**matches[0], "account_id": account}
    for worker in sorted(set(WORKERS.values())):
        schedules = api.get(api.base + f"/workers/scripts/{worker}/schedules")
        if isinstance(schedules, dict):
            schedules = schedules.get("schedules", [])
        result["crons"][worker] = {"id": worker, "script_name": worker, "account_id": account,
                                   "schedules": [{"cron": s["cron"]} for s in schedules]}
    apps = api.pages(api.base + "/access/apps")
    for app in apps:
        # The separate account app named photointel on migos.club is NOT ours.
        hostname = app.get("domain", "").split("/")[0]
        if hostname not in {"photos.migos.club", "photos-manage.migos.club"}:
            continue
        if app.get("type") != "self_hosted":
            raise ValueError("Unexpected Access application type")
        value = {**app, "account_id": account}
        policies = api.pages(api.base + f"/access/apps/{app['id']}/policies")
        value["policies"] = [{"id": p["id"], "precedence": p.get("precedence", i + 1)} for i, p in enumerate(policies)]
        for policy in policies:
            # GET also accepts existing non-reusable policy IDs; preserve IDs.
            result["policies"][policy["id"]] = {**api.get(api.base + f"/access/policies/{policy['id']}"), "account_id": account}
        result["applications"][app["id"]] = value
    protected = {app["domain"].split("/")[0] for app in result["applications"].values()}
    if protected != {"photos.migos.club", "photos-manage.migos.club"}:
        raise ValueError("Expected Access protection missing; adopt it explicitly before publishing")
    if any(a.get("domain", "").split("/")[0] == "photos-hooks.migos.club" for a in apps):
        raise ValueError("Webhooks hostname must remain outside Access")
    databases = api.pages(api.base + "/d1/database?name=photointel-manage")
    matching = [d for d in databases if d["name"] == "photointel-manage"]
    if len(matching) != 1:
        raise ValueError("Existing Manage D1 database must be unique; no automatic creation")
    result["databases"]["photointel-manage"] = {**matching[0], "id": matching[0]["uuid"], "account_id": account}
    bucket_name = config["storage_bucket"]
    bucket = api.get(api.base + "/r2/buckets/" + bucket_name)
    result["buckets"][bucket_name] = {**bucket, "name": bucket_name, "id": bucket_name, "account_id": account}
    return result


def generated_configuration(inventory: dict, schemas: dict, state: set[str], *, imports=True) -> tuple[dict, dict]:
    definitions, resources, adoptions = {}, {}, []
    for group, resource_type in TYPES.items():
        definitions[group] = {}
        for key, value in inventory[group].items():
            definitions[group][key] = supported_metadata(schemas[resource_type], value)
            address = f'{resource_type}.{group}[{json.dumps(key)}]'
            if imports and address not in state:
                identifier = value["id"]
                if group == "buckets":
                    identifier = value["name"] + "/" + (value.get("jurisdiction") or "default")
                adoptions.append({"to": address, "id": value["account_id"] + "/" + identifier})
        keys = set().union(*(set(value) for value in definitions[group].values())) if definitions[group] else set()
        keys |= {key for key, attr in schemas[resource_type]["block"]["attributes"].items() if attr.get("required")}
        body = {key: '${lookup(each.value, "' + key + '", null)}' for key in sorted(keys)}
        body.update({"for_each": "${var.cf_inventory." + group + "}", "lifecycle": {"prevent_destroy": True}})
        if group == "applications":
            body["depends_on"] = ["cloudflare_zero_trust_access_policy.policies"]
        resources[resource_type] = {group: body}
    # Keep import IDs separately from writable attributes for subsequent runs.
    definitions["_ids"] = {group: {key: value["id"] for key, value in items.items()} for group, items in inventory.items() if group in TYPES}
    return {"resource": resources, "import": adoptions}, {"cf_inventory": definitions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "verify", "fixture"])
    args = parser.parse_args()
    if args.action == "fixture":
        # Only for CI's mocked provider test; no GCP/Cloudflare credentials.
        inventory = {key: {} for key in TYPES}
        account = "a" * 32
        inventory["domains"]["photos.migos.club"] = {"id": "d" * 32, "account_id": account, "hostname": "photos.migos.club", "service": "photointel", "zone_id": "b" * 32}
        inventory["policies"]["policy"] = {"id": "00000000-0000-4000-8000-000000000001", "account_id": account, "name": "allow", "decision": "allow", "include": [{"email": {"email": "test@example.com"}}]}
        inventory["applications"]["app"] = {"id": "00000000-0000-4000-8000-000000000002", "account_id": account, "domain": "photos.migos.club", "type": "self_hosted", "name": "photointel-web", "session_duration": "24h", "policies": [{"id": "00000000-0000-4000-8000-000000000001", "precedence": 1}]}
        inventory["databases"]["photointel-manage"] = {"id": "00000000-0000-4000-8000-000000000003", "account_id": account, "name": "photointel-manage"}
        inventory["buckets"]["photointel"] = {"id": "photointel", "account_id": account, "name": "photointel", "jurisdiction": "default"}
        inventory["crons"]["photointel-manage"] = {"id": "photointel-manage", "account_id": account, "script_name": "photointel-manage", "schedules": [{"cron": "*/2 * * * *"}]}
        schemas = terraform("providers", "schema", "-json")["provider_schemas"]["registry.terraform.io/cloudflare/cloudflare"]["resource_schemas"]
        declarations, variables = generated_configuration(inventory, schemas, set(), imports=False)
        (ROOT / "adoption.auto.tf.json").write_text(json.dumps(declarations))
        (ROOT / "inventory.auto.tfvars.json").write_text(json.dumps(variables))
        return
    config = read_config()
    api = client(config)
    token = secret_value(config, "CLOUDFLARE_API_TOKEN")
    if "\n" in token or "\r" in token:
        raise ValueError("Invalid Cloudflare credential format")
    # Runner-only environment; never write the token into Terraform inputs/state.
    with open(os.environ["GITHUB_ENV"], "a") as handle:
        handle.write("CLOUDFLARE_API_TOKEN=" + token + "\n")
    live = snapshot(api, config)
    if args.action == "verify":
        wanted = json.loads((ROOT / "inventory.auto.tfvars.json").read_text())["cf_inventory"]
        for group in TYPES:
            for key, expected in wanted[group].items():
                if key not in live[group] or any(live[group][key].get(field) != value for field, value in expected.items()):
                    raise RuntimeError(f"Cloudflare {group} verification failed for adopted resource")
        print("Verified three Worker domains, Access settings/policies, Manage D1, R2 and cron triggers")
        return
    outputs = terraform("output", "-json")
    prior = outputs.get("cloudflare_inventory", {}).get("value")
    if prior:
        # Preserve adopted desired metadata instead of adopting dashboard drift.
        for group in TYPES:
            if set(prior[group]) != set(live[group]):
                raise ValueError(f"Cloudflare {group} inventory changed; review before changing ownership")
            for key, value in prior[group].items():
                live[group][key] = {**value, "id": prior["_ids"][group][key]}
    for application in live["applications"].values():
        host = application.get("domain", "").split("/")[0]
        if "/" in application.get("domain", ""):
            continue
        configured = config.get("access_allowed_emails") if host == "photos.migos.club" else None
        if host == "photos-manage.migos.club":
            raw = config.get("extra_environment", {}).get("MANAGE_ACCESS_ALLOWED_EMAILS")
            configured = json.loads(raw) if raw else None
        if configured is not None:
            if not isinstance(configured, list) or not configured or any(not isinstance(email, str) or "@" not in email or "\n" in email for email in configured):
                raise ValueError("Access email allowlist must be explicit and nonempty")
            for reference in application.get("policies", []):
                policy = live["policies"].get(reference["id"])
                if policy and policy.get("name") == "photointel-allowed-emails" and policy.get("decision") == "allow":
                    policy["include"] = [{"email": {"email": email}} for email in sorted(set(email.casefold() for email in configured))]
    provider = terraform("providers", "schema", "-json")["provider_schemas"]["registry.terraform.io/cloudflare/cloudflare"]
    state = set(subprocess.run(["terraform", "state", "list"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines())
    declarations, variables = generated_configuration(live, provider["resource_schemas"], state)
    for filename, contents in (("adoption.auto.tf.json", declarations), ("inventory.auto.tfvars.json", variables)):
        path = ROOT / filename
        path.write_text(json.dumps(contents, indent=2) + "\n")
        path.chmod(0o600)
    print(f"Cloudflare inventory ready: {len(declarations['import'])} declarative imports; no code or secret payload managed")


if __name__ == "__main__":
    main()
