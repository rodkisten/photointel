#!/usr/bin/env python3
"""Convert GitHub dotenv config to GCP JSON and log a safe, redacted preview.

Only partial string values are shown in logs. Full values are written to the
private deployment config and, for WIF identifiers, to GitHub step outputs.
"""

from __future__ import annotations

import json
import os
import re
from io import StringIO
from typing import Any

from infra import repository_root
from infra.gcp.manage import REQUIRED_SECRETS, SECRET_FIELDS, WORKFLOW_SECRET_FIELDS

ROOT = repository_root(__file__)
CONFIG_PATH = ROOT / "infra/gcp/config.local.json"
REQUIRED_WIF = (
    "GCP_WORKLOAD_IDENTITY_PROVIDER",
    "GCP_DEPLOY_SERVICE_ACCOUNT",
)
OPTIONAL_BOOTSTRAP_WIF = (
    "GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER",
    "GCP_BOOTSTRAP_SERVICE_ACCOUNT",
)
PROVIDER_PATTERN = re.compile(
    r"projects/[0-9]+/locations/global/workloadIdentityPools/"
    r"[A-Za-z0-9_-]+/providers/[A-Za-z0-9_-]+"
)
SA_PATTERN = re.compile(
    r"[a-z][a-z0-9-]*@[a-z][a-z0-9.-]*\.iam\.gserviceaccount\.com"
)
SECRET_NAME_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,254}")
SECRET_VERSION_PATTERN = re.compile(r"[1-9][0-9]{0,9}")
ENV_PART_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]*")


def fail(message: str) -> None:
    raise SystemExit("Configuration error: " + message)


def checked_dotenv() -> dict[str, str]:
    from dotenv import dotenv_values  # Installed by the composite action for legacy input.

    raw = os.environ.get("GCP_CONFIG_ENV", "")
    if not raw.strip():
        fail("GCP_CONFIG_ENV is missing or empty; configure a production Environment secret")
    entries = dotenv_values(stream=StringIO(raw), interpolate=False)
    values: dict[str, str] = {}
    for key, value in entries.items():
        if value is None:
            fail(f"Environment key without value: {key}")
        if key in values:
            fail(f"Duplicate environment key: {key}")
        values[key] = value
    return values


def nested_insert(config: dict[str, Any], path: list[str], value: Any, key: str) -> None:
    current = config
    for part in path[:-1]:
        if part not in current:
            current[part] = {}
        if not isinstance(current[part], dict):
            fail(f"Conflicting nested configuration key: {key}")
        current = current[part]
    if path[-1] in current:
        fail(f"Duplicate configuration key: {key}")
    current[path[-1]] = value


def typed_environment_value(value: str) -> Any:
    """Infer JSON scalar/container types; explicit quoted strings remain strings."""
    if value.startswith("json:"):
        try:
            return json.loads(value[5:])
        except json.JSONDecodeError:
            fail("Invalid json: environment value")
    if value.startswith(('"', "'")) and value.endswith(value[0]) and len(value) >= 2:
        return value[1:-1]
    if value in {"true", "false", "null"} or value.startswith(("[", "{")):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            fail("Invalid structured environment value")
    if re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", value):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass
    return value


def compact_secret_reference(key: str, value: str, prefix: str) -> tuple[str, dict[str, str]] | None:
    """Parse explicit or inferred Secret Manager references without fetching values."""
    if key.startswith("WORKFLOW_SECRET__"):
        target = key.removeprefix("WORKFLOW_SECRET__")
    elif key.startswith("SECRET__"):
        target = key.removeprefix("SECRET__")
        reference = value
    elif value.startswith("secret://"):
        target = key
        reference = value.removeprefix("secret://")
    else:
        return None
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", target):
        fail(f"Invalid compact secret variable: {key}")
    if "@" in reference:
        name, version = reference.rsplit("@", 1)
    else:
        name, version = reference, "latest"
    if not name:
        name = prefix + target.lower().replace("_", "-")
    if not SECRET_NAME_PATTERN.fullmatch(name):
        fail(f"Invalid compact secret name for {key}")
    if not (SECRET_VERSION_PATTERN.fullmatch(version) or version == "latest"):
        fail(f"Invalid compact secret version for {key}")
    return target, {"name": name, "version": version}


def decode_config(entries: dict[str, str]) -> dict[str, Any]:
    config: dict[str, Any] = {}
    prefix = entries.get("SECRET_NAME_PREFIX", "photointel-")
    if prefix and not prefix.endswith("-"):
        prefix += "-"
    for key, raw_value in entries.items():
        if key == "SECRET_NAME_PREFIX":
            continue
        compact = compact_secret_reference(key, raw_value, prefix)
        if compact:
            target, reference = compact
            scope = "workflow_secrets" if key.startswith("WORKFLOW_SECRET__") else "secrets"
            nested_insert(config, [scope, target], reference, key)
            continue
        if key.startswith("CF__") and key.count("__") == 1:
            field = key[4:]
            if not re.fullmatch(r"[A-Z][A-Z0-9_]*", field):
                fail(f"Invalid Cloudflare environment variable: {key}")
            nested_insert(config, ["cloudflare_environment", field], typed_environment_value(raw_value), key)
            continue
        if key.startswith("ENV__") and key.count("__") == 1:
            nested_insert(config, ["extra_environment", key[5:]], typed_environment_value(raw_value), key)
            continue
        if key in REQUIRED_WIF + OPTIONAL_BOOTSTRAP_WIF:
            continue  # WIF authentication metadata is not application configuration
        segments = key.split("__")
        if not all(ENV_PART_PATTERN.fullmatch(item) for item in segments):
            fail(f"Invalid .env key: {key}")
        root = segments[0].lower()
        if root in {"secrets", "workflow_secrets"}:
            if (
                len(segments) != 3
                or not re.fullmatch(r"[A-Z][A-Z0-9_]*", segments[1])
                or segments[2].upper() not in {"NAME", "VERSION"}
            ):
                fail(f"Expected {root.upper()}__UPPERCASE_KEY__NAME/VERSION: {key}")
            path = [root, segments[1], segments[2].lower()]
        elif root == "extra_environment" and len(segments) == 2:
            path = ["extra_environment", segments[1]]
        else:
            path = [item.lower() for item in segments]

        if raw_value.startswith("json:"):
            try:
                value = json.loads(raw_value[5:])
            except json.JSONDecodeError:
                fail(f"Invalid JSON literal for {key}")
        else:
            value = raw_value
        nested_insert(config, path, value, key)
    return config


def normalize_legacy_notification_fields(config: dict[str, Any]) -> dict[str, Any]:
    """Accept Telegram, Firebase and public Manage Sentry fields as dotenv keys.

    Top-level fields (decoded to lowercase) or the explicit EXTRA_ENVIRONMENT__
    prefix are supported. Canonical values live in extra_environment.
    """
    extras = config.setdefault("extra_environment", {})
    if not isinstance(extras, dict):
        return config
    for field in ("TELEGRAM_NOTIFICATION_API_TOKEN", "TELEGRAM_NOTIFICATION_URL",
                  "TELEGRAM_NOTIFICATION_CHAT_ID", "MANAGE_SENTRY_DSN",
                  "FCM_PROJECT_ID", "FCM_JOB_EVENTS_ENABLED"):
        # Dotenv's top-level names are lowercased by decode_config. JSON may
        # provide either spelling. The prefixed env key wins if both are set.
        for root_key in (field.lower(), field):
            if root_key not in config:
                continue
            raw = config.pop(root_key)
            if field not in extras or not extras[field]:
                extras[field] = raw
    for legacy in ("telegram_job_events_enabled", "TELEGRAM_JOB_EVENTS_ENABLED"):
        config.pop(legacy, None)
    if "TELEGRAM_JOB_EVENTS_ENABLED" in extras:
        extras.pop("TELEGRAM_JOB_EVENTS_ENABLED")
        print("::notice::TELEGRAM_JOB_EVENTS_ENABLED is computed from the token and destination.")
    return config


def validate_references(config: dict[str, Any]) -> None:
    references = config.get("secrets")
    if not isinstance(references, dict):
        fail("Missing SECRETS__*__NAME and SECRETS__*__VERSION entries")
    missing = REQUIRED_SECRETS - references.keys()
    unknown = references.keys() - SECRET_FIELDS
    if missing:
        fail("Missing required Secret Manager references: " + ", ".join(sorted(missing)))
    if unknown:
        fail("Unknown Secret Manager reference keys: " + ", ".join(sorted(unknown)))

    workflow_refs = config.get("workflow_secrets", {})
    if not isinstance(workflow_refs, dict) or set(workflow_refs) - WORKFLOW_SECRET_FIELDS:
        fail("Unknown workflow Secret Manager reference key")
    for key, ref in sorted({**references, **workflow_refs}.items()):
        if not isinstance(ref, dict) or set(ref.keys()) != {"name", "version"}:
            fail(f"Invalid Secret Manager reference for {key}: expected NAME and VERSION")
        name = ref["name"]
        version = ref["version"]
        if not isinstance(name, str) or not SECRET_NAME_PATTERN.fullmatch(name):
            fail(
                f"Invalid Secret Manager NAME for {key}: use the short secret ID "
                "(lowercase letters, numbers, hyphens), not a resource path"
            )
        if not isinstance(version, str) or not (SECRET_VERSION_PATTERN.fullmatch(version) or version == "latest"):
            fail(
                f"Invalid Secret Manager VERSION for {key}: use 1, 2, ... "
                "without the json: prefix or latest"
            )


def wif_metadata(entries: dict[str, str]) -> tuple[str, str]:
    missing = [name for name in REQUIRED_WIF if not entries.get(name)]
    if missing:
        fail("Missing Workload Identity entries in GCP_CONFIG_ENV: " + ", ".join(missing))
    provider = entries["GCP_WORKLOAD_IDENTITY_PROVIDER"]
    service_account = entries["GCP_DEPLOY_SERVICE_ACCOUNT"]
    if not PROVIDER_PATTERN.fullmatch(provider):
        fail("Invalid GCP_WORKLOAD_IDENTITY_PROVIDER resource name")
    if not SA_PATTERN.fullmatch(service_account):
        fail("Invalid GCP_DEPLOY_SERVICE_ACCOUNT email")
    admin_provider = entries.get("GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER", "")
    admin_account = entries.get("GCP_BOOTSTRAP_SERVICE_ACCOUNT", "")
    if bool(admin_provider) != bool(admin_account):
        fail("Bootstrap WIF provider and service account must be configured together")
    if admin_provider and (
        not PROVIDER_PATTERN.fullmatch(admin_provider)
        or not SA_PATTERN.fullmatch(admin_account)
        or (admin_provider, admin_account) == (provider, service_account)
    ):
        fail("Invalid or insufficiently separated bootstrap WIF identity")
    return provider, service_account


def bootstrap_wif() -> tuple[str, str] | None:
    config, entries = read_input()
    provider = entries.get("GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER", "")
    account = entries.get("GCP_BOOTSTRAP_SERVICE_ACCOUNT", "")
    return (provider, account) if provider and account else None


def write_outputs(provider: str, service_account: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return  # supports local validation with no GitHub Actions runner
    with open(output_path, "a", encoding="utf-8") as output:
        output.write(f"workload_identity_provider={provider}\n")
        output.write(f"service_account={service_account}\n")
        # Bootstrap uses a distinct privileged identity from the same input.
        entries = bootstrap_wif()
        if entries is not None:
            output.write(f"bootstrap_workload_identity_provider={entries[0]}\n")
            output.write(f"bootstrap_service_account={entries[1]}\n")


def redact_string(value: str) -> str:
    """Reveal a small prefix/suffix, never the complete original string."""
    if not value:
        return "<empty>"
    if len(value) < 8:
        return "***"
    if len(value) < 24:
        return f"{value[:3]}...{value[-3:]}"
    return f"{value[:6]}...{value[-6:]}"


def redact_preview(value: Any, path: tuple[str, ...] = ()) -> Any:
    """Mask every string recursively, including strings in JSON arrays.

    Secret Manager version numbers are non-sensitive identifiers and are shown
    completely to aid troubleshooting. Integers, booleans and nulls retain type.
    """
    if isinstance(value, dict):
        return {key: redact_preview(item, path + (key,)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_preview(item, path) for item in value]
    if isinstance(value, str):
        # A short prefix/suffix still reveals part of an inline credential.
        # Never echo even a fragment of secrets in Actions logs.
        if path and re.search(r"TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|SECRET", path[-1], re.I):
            if path[-1] not in {"version", "name"}:
                return "<redacted>"
        if len(path) == 3 and path[0] == "secrets" and path[-1] == "version":
            return value
        return redact_string(value)
    return value


def print_redacted_summary(config: dict[str, Any], provider: str, service_account: str) -> None:
    """Only the masked representation is sent to GitHub Actions stdout."""
    provider_parts = provider.split("/")
    service_account_project = service_account.split("@", 1)[1].split(".", 1)[0]
    preview = {
        "deployment_config": redact_preview(config),
        "github_workload_identity": {
            "provider": redact_string(provider),
            "project_number": redact_string(provider_parts[1]),
            "pool_id": redact_string(provider_parts[5]),
            "provider_id": redact_string(provider_parts[7]),
            "service_account": redact_string(service_account),
            "service_account_project": redact_string(service_account_project),
        },
    }
    print("\n=== REDACTED CONFIGURATION PREVIEW ===")
    print(json.dumps(preview, ensure_ascii=False, indent=2))
    print("=== END REDACTED CONFIGURATION PREVIEW ===")


def read_input() -> tuple[dict[str, Any], dict[str, str]]:
    raw = os.environ.get("GCP_CONFIG_ENV", "").strip()
    if not raw:
        fail("GCP_CONFIG_ENV is missing; configure one production Environment variable")
    if raw.startswith("{"):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            fail("Invalid GCP_CONFIG_ENV JSON")
        if not isinstance(payload, dict):
            fail("GCP_CONFIG_ENV JSON must be an object")
        entries = {key: payload.pop(key, "") for key in REQUIRED_WIF + OPTIONAL_BOOTSTRAP_WIF}
        if any(not isinstance(item, str) for item in entries.values()):
            fail("WIF values in GCP_CONFIG_ENV JSON must be strings")
        return normalize_legacy_notification_fields(payload), entries
    entries = checked_dotenv()
    return normalize_legacy_notification_fields(decode_config(entries)), entries


def main() -> None:
    config, entries = read_input()
    validate_references(config)
    provider, service_account = wif_metadata(entries)

    for key in ("project_id", "region", "repository"):
        if not isinstance(config.get(key), str) or not config[key].strip():
            fail(f"Missing or invalid configuration field: {key}")
    project_confirmation = os.environ.get("CONFIRM_PROJECT", "")
    if config["project_id"] != project_confirmation:
        fail("Project confirmation mismatch")
    sha = os.environ.get("RELEASE_SHA", "")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        fail("Invalid release SHA")

    config["release_git_sha"] = sha
    config["image"] = (
        f"{config['region']}-docker.pkg.dev/{config['project_id']}/"
        f"{config['repository']}/api:{sha}"
    )
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CONFIG_PATH.chmod(0o600)
    write_outputs(provider, service_account)
    print(f"Configuration converted successfully ({len(config['secrets'])} Secret Manager references validated).")
    print_redacted_summary(config, provider, service_account)


if __name__ == "__main__":
    main()
