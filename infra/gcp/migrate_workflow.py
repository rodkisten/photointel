#!/usr/bin/env python3
"""Safe GitHub Actions entrypoint for a manually approved Cloud Run migration.

Plan mode only describes the installed migrate Job and prints a local command.
Apply mode requires an explicit empty-database attestation OR a matching,
recent restore receipt downloaded from the project-private GCS staging bucket.
This never reads database credentials or runs SQL on the Actions runner.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from manage import ConfigurationError, validate, verify_backup_receipt

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra/gcp/config.local.json"
SHA_RE = re.compile(r"[a-f0-9]{40}")
BACKUP_SEGMENT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")


class MigrationWorkflowError(ValueError):
    """Unsafe or incomplete migration inputs."""


def check_backup_prefix(prefix: str, project: str) -> str:
    """Allow only an encrypted backup bundle in the project's private staging bucket."""
    required = f"gs://{project}-photointel-build-source/migration-backups/"
    if not prefix.startswith(required):
        raise MigrationWorkflowError(
            "Existing database requires a private gs://PROJECT-photointel-build-source/"
            "migration-backups/NAME prefix"
        )
    suffix = prefix[len(required) :]
    if not BACKUP_SEGMENT_RE.fullmatch(suffix):
        raise MigrationWorkflowError("Backup name must be one safe path segment")
    return prefix


def run_gcloud(args: list[str], project: str, *, capture: bool = False) -> str:
    result = subprocess.run(
        ["gcloud", *args, "--project", project, "--quiet"],
        check=True,
        capture_output=capture,
        text=True,
        timeout=600,
    )
    return result.stdout if capture else ""


def job_spec(image_prefix: str, project: str, region: str) -> str:
    payload = json.loads(
        run_gcloud(
            [
                "run", "jobs", "describe", "photointel-migrate",
                "--region", region, "--format=json",
            ],
            project,
            capture=True,
        )
    )
    try:
        # gcloud Run v1 and v2 responses use different nested template forms.
        if payload.get("kind") == "Job":
            spec = payload["spec"]["template"]["spec"]
            container_spec = spec["template"]["spec"]
        else:
            spec = payload["template"]
            container_spec = spec["template"]
        container = container_spec["containers"][0]
        current_image = container["image"]
        retries = container_spec.get("maxRetries", spec.get("maxRetries", 0))
        service_account = container_spec.get("serviceAccountName") or container_spec.get("serviceAccount")
        args = container["args"]
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise MigrationWorkflowError("Cannot inspect the deployed migration Job") from exc
    if not isinstance(current_image, str) or not current_image.startswith(image_prefix + ":"):
        raise MigrationWorkflowError(
            "Migration Job must use the configured Artifact Registry repository image"
        )
    deployed_sha = current_image[len(image_prefix) + 1 :]
    if not SHA_RE.fullmatch(deployed_sha):
        raise MigrationWorkflowError("Migration Job must use an immutable full Git SHA tag")
    if str(retries) != "0":
        raise MigrationWorkflowError("Migration Job must have maxRetries=0")
    if service_account != f"photointel-migrate@{project}.iam.gserviceaccount.com":
        raise MigrationWorkflowError("Migration Job uses an unexpected service account")
    if len(args) < 3 or args[:3] != ["-m", "photointel.services.task_runner", "migrate"]:
        raise MigrationWorkflowError("Migration Job command does not match the approved runner")
    return deployed_sha


def migration_command(project: str, *, initial_empty: bool, backup: Path | None = None) -> list[str]:
    result = [
        sys.executable, str(ROOT / "infra/gcp/manage.py"), "migrate",
        "--apply", "--authorize-charges", "--confirm-project", project,
    ]
    if initial_empty:
        result.append("--initial-empty-database")
    else:
        assert backup is not None
        result += [
            "--backup-directory", str(backup),
            "--backup-receipt", str(backup / "restore-verification.json"),
        ]
    return result


def apply_migration(
    project: str,
    profile: str,
    empty_attested: bool,
    prefix: str,
) -> None:
    if profile == "initial-empty":
        if not empty_attested:
            raise MigrationWorkflowError(
                "Refusing to migrate: check initial_empty_database only after "
                "independently verifying the Neon database is empty"
            )
        if prefix:
            raise MigrationWorkflowError("Initial-empty mode cannot reference a backup")
        subprocess.run(migration_command(project, initial_empty=True), check=True, timeout=3600)
        return
    if profile != "existing-with-backup":
        raise MigrationWorkflowError(
            "Select migration_database=initial-empty or existing-with-backup for apply"
        )
    if empty_attested:
        raise MigrationWorkflowError(
            "Conflicting migration inputs: an existing database cannot be declared empty"
        )
    prefix = check_backup_prefix(prefix, project)
    # Download only ciphertext + small verification metadata. Temporary files
    # disappear even when receipt verification or the Cloud Run Job fails.
    with tempfile.TemporaryDirectory(prefix="photointel-migration-") as directory:
        dest = Path(directory)
        dest.chmod(0o700)
        for name in ("backup.json", "manifest.enc", "restore-verification.json"):
            run_gcloud(
                ["storage", "cp", f"{prefix}/{name}", str(dest / name)],
                project,
            )
            (dest / name).chmod(0o600)
        verify_backup_receipt(dest, dest / "restore-verification.json")
        subprocess.run(
            migration_command(project, initial_empty=False, backup=dest),
            check=True, timeout=3600,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("plan", "apply"), required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument(
        "--database",
        choices=("unselected", "initial-empty", "existing-with-backup"),
        default="unselected",
    )
    parser.add_argument("--initial-empty-database", choices=("true", "false"), default="false")
    parser.add_argument("--backup-prefix", default="")
    parser.add_argument("--approved-sha", default="")
    parser.add_argument("--config", type=Path, default=CONFIG)
    args = parser.parse_args(argv)
    try:
        if not SHA_RE.fullmatch(args.sha):
            raise MigrationWorkflowError("A full Git release SHA is required")
        config = validate(
            json.loads(args.config.read_text(encoding="utf-8")), production=True
        )
        if config["project_id"] != args.project or config.get("release_git_sha") != args.sha:
            raise MigrationWorkflowError("Project and release SHA must match production config")
        print("🔎 Inspecting deployed Cloud Run migration Job (read-only).", flush=True)
        deployed_sha = job_spec(
            config["image"].rsplit(":", 1)[0], args.project, config["region"]
        )
        print(f"✅ Migration Job is deployed from release SHA {deployed_sha}.", flush=True)
        if args.mode == "plan":
            if args.backup_prefix:
                check_backup_prefix(args.backup_prefix, args.project)
            if args.database == "existing-with-backup" and not args.backup_prefix:
                print("⚠️ Apply to an existing database requires a private GCS backup prefix.")
            print(
                "🧾 PLAN ONLY. No database changes. "
                "Apply executes photointel-migrate once, with --wait, after backup guards."
            )
            print(
                "🛡️ The plan does not verify database emptiness, run SQL, "
                "or certify the restore receipt. Copy the installed Job SHA "
                "into migration_release_sha for apply."
            )
            return 0

        if not SHA_RE.fullmatch(args.approved_sha) or args.approved_sha != deployed_sha:
            raise MigrationWorkflowError(
                "Apply requires migration_release_sha matching the exact installed "
                "migration Job SHA printed by plan"
            )
        print("🛡️ APPLY: validating database profile and recovery evidence.", flush=True)
        apply_migration(
            args.project,
            args.database,
            args.initial_empty_database == "true",
            args.backup_prefix.strip(),
        )
        print("✅ Cloud Run migration Job completed successfully.", flush=True)
        return 0
    except (
        MigrationWorkflowError, ConfigurationError, KeyError, ValueError,
        OSError, json.JSONDecodeError, subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as exc:
        # Do not print command args or secrets; GCS paths are not credentials,
        # but avoiding subprocess repr also prevents accidental leakage.
        if isinstance(exc, subprocess.CalledProcessError):
            message = "Cloud command or migration Job failed; inspect Cloud Run execution logs"
        elif isinstance(exc, subprocess.TimeoutExpired):
            message = "Migration operation timed out; inspect Job status before retrying"
        else:
            message = str(exc)
        print(f"::error::{message}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
