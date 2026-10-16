#!/usr/bin/env python3
"""Validate the real developer stack and export only synthetic counts and health."""

import argparse
import hashlib
import json
import os
import stat
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "reports" / "compose-validation"
BASE = "http://localhost:5173"
VARIANTS = {"thumbnail_small", "thumbnail_medium", "preview_large"}
SERVICES = {"postgres", "minio", "api", "worker", "ingestion", "frontend"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def get(path: str) -> tuple[bytes, Any]:
    require(path.startswith("/") and not path.startswith("//"), "local_path_required")
    with urlopen(BASE + path, timeout=5) as response:
        require(response.status == 200, "http_success_required")
        payload = response.read(2 * 1024 * 1024 + 1)
        require(len(payload) <= 2 * 1024 * 1024, "response_exceeds_validation_limit")
        return payload, response.headers


def get_json(path: str) -> Any:
    body, _ = get(path)
    return json.loads(body)


def container_health() -> dict[str, dict[str, Any]]:
    process = subprocess.run(
        ["bash", "infra/scripts/compose.sh", "ps", "--all", "--format", "json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    output = process.stdout.strip()
    if not output:
        return {}
    rows = (
        json.loads(output)
        if output.startswith("[")
        else [json.loads(line) for line in output.splitlines()]
    )
    return {
        row["Service"]: {
            "state": row.get("State"),
            "health": row.get("Health"),
            "exit_code": row.get("ExitCode"),
        }
        for row in rows
    }


def configuration() -> dict[str, Any]:
    target = ROOT / ".env"
    values = dict(
        line.split("=", 1)
        for line in target.read_text().splitlines()
        if line and not line.startswith("#") and "=" in line
    )
    require(stat.S_IMODE(target.stat().st_mode) == 0o600, "env_permissions_not_private")
    for key, expected in {
        "APP_ENV": "development",
        "AUTH_MODE": "local",
        "GPU_ENABLED": "false",
        "ICLOUD_ENABLED": "false",
        "INFERENCE_BACKEND": "modal",
        "STORAGE_BACKEND": "s3",
        "STORAGE_BUCKET": "photointel-private",
    }.items():
        require(values.get(key) == expected, "unsafe_or_unexpected_validation_settings")
    for key in (
        "POSTGRES_PASSWORD",
        "MINIO_ROOT_PASSWORD",
        "BRIDGE_ENROLLMENT_SECRET",
        "BRIDGE_TOKEN_PEPPER",
    ):
        require(len(values.get(key, "")) >= 32, "missing_generated_credential")
        require("GENERATE_" not in values[key], "placeholder_credential")
    return {
        "environment_file_mode": "0600",
        "gpu_enabled": False,
        "icloud_enabled": False,
        "inference_called": False,
        "storage_backend": "real_private_s3",
        "credentials": "generated_locally_never_exported",
    }


def wait_ready(expected: int) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            health = container_health()
            if any(
                health.get(service, {}).get("health") != "healthy" for service in SERVICES
            ):
                time.sleep(2)
                continue
            get("/health/live")
            get("/health/ready")
            statistics = get_json("/v1/system/statistics")
            require(statistics["failed_jobs"] == 0, "failed_jobs_detected")
            jobs = statistics["job_counts"]
            settled = not any(
                jobs.get(status, 0)
                for status in ("queued", "preparing", "running", "retrying")
            )
            if statistics["total_assets"] == expected and settled:
                require(
                    statistics["processed_assets"] == expected, "assets_not_processed"
                )
                return health, statistics
        except (URLError, TimeoutError, ConnectionError, subprocess.SubprocessError):
            pass
        time.sleep(2)
    raise AssertionError("stack_did_not_become_healthy_and_settled_within_240_seconds")


def snapshot(expected: int) -> dict[str, Any]:
    from photointel.storage import object_key

    health, statistics = wait_ready(expected)
    index, _ = get("/")
    require(b'<div id="root"></div>' in index, "built_frontend_not_served")
    page = get_json("/v1/assets?limit=200")
    assets = page["items"]
    require(page["next_cursor"] is None, "unexpected_catalog_pagination")
    require(len(assets) == expected, "unexpected_gallery_count")
    require(len({asset["id"] for asset in assets}) == expected, "duplicate_asset_ids")
    libraries = get_json("/v1/libraries")["items"]
    require(
        all(library["source_type"] == "fixture" for library in libraries),
        "non_fixture_library_detected",
    )
    require(
        all(asset["library_id"] in {row["id"] for row in libraries} for asset in assets),
        "asset_not_from_fixture_library",
    )
    capabilities = get_json("/v1/system/capabilities")
    for name in ("gpu_inference", "joytag", "semantic_search", "icloud_ingestion"):
        require(
            capabilities[name]["state"] == "not_configured", "external_service_enabled"
        )
    records = []
    media_bytes = 0
    resource_count = 0
    assertion_count = 0
    private_media_status = None
    for asset in sorted(assets, key=lambda row: row["id"]):
        detail = get_json(f"/v1/assets/{asset['id']}")
        resources = detail["resources"]
        require(
            {resource["resource_type"] for resource in resources} == VARIANTS,
            "expected_three_public_derivatives_only",
        )
        tags = detail["tags"]
        require(not detail["inference_runs"], "unexpected_ai_inference")
        require(any(tag["origin"] == "import" for tag in tags), "synthetic_tag_missing")
        assertion_count += len(tags)
        persisted = []
        for resource in sorted(resources, key=lambda row: row["resource_type"]):
            require(
                resource["status"] in {"available", "completed"}, "media_not_available"
            )
            require("object_key" not in resource, "private_object_key_exposed")
            media_url = resource["media_url"]
            require(
                not urlsplit(media_url).netloc, "persistent_external_media_url_exposed"
            )
            body, headers = get(media_url)
            require(headers.get_content_type().startswith("image/"), "invalid_media_type")
            require(
                "no-store" in headers.get("Cache-Control", ""), "media_cache_not_private"
            )
            require(len(body) > 100, "empty_thumbnail")
            if private_media_status is None:
                extension = {
                    "image/webp": "webp",
                    "image/jpeg": "jpg",
                    "image/png": "png",
                }[headers.get_content_type()]
                key = object_key(
                    asset["id"],
                    resource["revision"],
                    resource["resource_type"],
                    extension,
                )
                try:
                    with urlopen(
                        f"http://localhost:9000/photointel-private/{key}", timeout=5
                    ):
                        raise AssertionError("media_allows_unauthenticated_object_get")
                except HTTPError as error:
                    require(error.code == 403, "unexpected_private_media_status")
                    private_media_status = error.code
            media_bytes += len(body)
            resource_count += 1
            persisted.append(
                [resource["id"], resource["revision"], hashlib.sha256(body).hexdigest()]
            )
        records.append([asset["id"], asset["content_revision"], persisted, tags])
    # An unsigned S3 list request must fail even on the isolated development host.
    try:
        with urlopen("http://localhost:9000/photointel-private?list-type=2", timeout=5):
            raise AssertionError("bucket_allows_unauthenticated_listing")
    except HTTPError as error:
        require(error.code == 403, "unexpected_private_bucket_status")
    return {
        "containers": health,
        "asset_count": expected,
        "resource_count": resource_count,
        "tag_assertion_count": assertion_count,
        "job_counts": statistics["job_counts"],
        "media_bytes_verified": media_bytes,
        "catalog_and_media_fingerprint": fingerprint(records),
        "private_bucket_unsigned_list_status": 403,
        "private_media_unsigned_get_status": private_media_status,
        "gpu_enabled": False,
        "icloud_enabled": False,
        "source": "synthetic_fixture_only",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--phase",
        required=True,
        choices=(
            "configuration",
            "startup",
            "seeded",
            "repeated",
            "restarted",
            "final-health",
        ),
    )
    parser.add_argument("--expected-assets", type=int, default=0, choices=range(201))
    parser.add_argument("--compare", choices=("seeded",))
    args = parser.parse_args()
    REPORTS.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "phase": args.phase,
        "source_commit": os.environ.get("GITHUB_SHA", "local"),
        "recorded_at": datetime.now(UTC).isoformat(),
        "status": "failed",
    }
    exit_code = 0
    try:
        if args.phase == "configuration":
            report.update(configuration())
        elif args.phase == "final-health":
            report["containers"] = container_health()
        else:
            report.update(snapshot(args.expected_assets))
            if args.compare:
                baseline = json.loads((REPORTS / f"{args.compare}.json").read_text())
                for key in (
                    "asset_count",
                    "resource_count",
                    "tag_assertion_count",
                    "job_counts",
                    "catalog_and_media_fingerprint",
                ):
                    require(report[key] == baseline[key], f"persisted_{key}_changed")
                report["compared_to"] = args.compare
        report["status"] = "passed"
    except Exception as error:
        # Never export raw subprocess output, exception bodies, URLs, or environment.
        report["error_type"] = type(error).__name__
        if isinstance(error, AssertionError):
            report["check"] = str(error)
        exit_code = 1
    (REPORTS / f"{args.phase}.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Compose validation {args.phase}: {report['status']}")
    if "check" in report:
        print(report["check"])
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
