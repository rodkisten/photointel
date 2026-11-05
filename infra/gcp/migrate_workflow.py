#!/usr/bin/env python3
"""Execute Alembic directly on Neon from a WIF-authenticated GitHub runner.

- No Cloud Run Job, revision pin, image build or broad deployer secret access.
- MIGRATION_DATABASE_URL is fetched from Secret Manager using the isolated
  photointel-migrate identity impersonated by photointel-deployer.
- Read-only plan/diagnose check the database schema and current Alembic revision.
- Apply is opt-in and verifies a genuinely empty database or a restore receipt.
- Raw connection URLs, secrets, SQL and unfiltered exceptions are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from infra.gcp.manage import ConfigurationError, validate, verify_backup_receipt
from infra.gcp.cloud_cli import run as cloud_run

ROOT = Path(__file__).resolve().parents[2]
# This migration environment intentionally does not install the API runtime.
# Load its SQLAlchemy-only connection policy by a verified source file without
# rewriting sys.path or importing application startup / GPU modules.
APP_SRC = ROOT / "apps/api/src"
DB_POLICY = APP_SRC / "photointel/db_connection.py"
if not DB_POLICY.is_file():
    raise RuntimeError("PhotoIntel source tree is incomplete: apps/api/src/photointel/db_connection.py")
CONFIG = ROOT / "infra/gcp/config.local.json"
SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
SECRET_NAME = re.compile(r"[a-z][a-z0-9-]{0,254}")
SECRET_VERSION = re.compile(r"[1-9][0-9]*")
ALEMBIC_FILE = ROOT / "infra/migrations/alembic.ini"
HINTS = (
    ("password authentication failed", "NEON_AUTH", "Check the pinned migration secret in Secret Manager."),
    ("channel_binding", "NEON_CHANNEL_BINDING", "Use psycopg with SCRAM channel binding; inspect the Neon URL."),
    ("certificate verify failed", "NEON_CA", "Server certificate could not be verified. Check the CA bundle and Neon hostname."),
    ("root certificate file", "NEON_CA_FILE", "The PostgreSQL CA file is unavailable to libpq."),
    ("hostname mismatch", "NEON_HOSTNAME", "The Neon hostname does not match the server certificate."),
    ("does not match the server certificate", "NEON_HOSTNAME", "The Neon hostname does not match the server certificate."),
    ("ssl error", "NEON_TLS", "Inspect the CA bundle, Neon hostname and TLS handshake."),
    ("certificate", "NEON_TLS", "Check the endpoint host, CA trust and TLS verification."),
    ("permission denied", "NEON_PERMISSION", "Check migration role privileges on the direct Neon database."),
    ("connection timed out", "NEON_TIMEOUT", "Check direct Neon endpoint reachability from GitHub Actions."),
    ("could not translate host name", "NEON_DNS", "Check Neon hostname and DNS."),
    ("duplicate table", "SCHEMA_CONFLICT", "Inspect existing objects and Alembic version before retrying."),
    ("duplicate column", "SCHEMA_CONFLICT", "Inspect existing columns and Alembic history."),
    ("can't locate revision", "ALEMBIC_REVISION", "Review the database revision against the repo migration history."),
    ("multiple head", "ALEMBIC_HEADS", "Resolve Alembic branches before applying."),
)


class MigrationError(ValueError):
    """Safe error with no credential-bearing provider content."""


@dataclass(frozen=True)
class Status:
    revision: str
    user_tables: int


def gcloud(args: list[str], *, project: str, impersonate: bool = False) -> bytes:
    account = (f"photointel-migrate@{project}.iam.gserviceaccount.com"
               if impersonate else None)
    try:
        result = cloud_run(args, project=project, impersonate=account,
                           text=False, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MigrationError("Google Cloud credential retrieval unavailable") from None
    if result.returncode:
        if impersonate:
            # Categorize provider errors without logging stderr, which may
            # include credentials or request details.
            details = result.stderr.decode("utf-8", errors="replace").casefold()
            if (
                "getaccesstoken" in details
                or "iam.serviceaccounts" in details
                or "impersonat" in details
            ):
                raise MigrationError(
                    "NEON_IAM: deployer cannot impersonate photointel-migrate. "
                    "Run Setup GCP → apply once to grant Token Creator on that "
                    "service account. Then retry migrate → plan."
                )
            if "secretmanager" in details or "secret" in details:
                raise MigrationError(
                    "NEON_SECRET: the pinned migration secret version is unavailable "
                    "to photointel-migrate. Verify Secret Manager version and IAM."
                )
            raise MigrationError(
                "NEON_CREDENTIALS: impersonation or pinned secret access failed. "
                "Run Setup GCP → apply and verify the migration secret version."
            )
        raise MigrationError("Private backup retrieval failed; verify IAM and GCS prefix")
    return result.stdout



def trusted_ca_bundle() -> Path:
    """A concrete, current CA bundle for both libpq and Alembic.

    The bundled libpq in psycopg_binary does not necessarily resolve the same
    OpenSSL trust paths as Python, so sslrootcert=system can fail on a runner
    even when Python HTTPS certificate validation succeeds.
    """
    try:
        import certifi

        candidate = Path(certifi.where())
    except ImportError:
        raise MigrationError(
            "Missing certifi CA bundle in the isolated migration environment"
        ) from None
    if not candidate.is_file() or candidate.stat().st_size < 1000:
        raise MigrationError("Trusted CA bundle is missing or empty")
    return candidate


def migration_tls_url(url: str) -> str:
    """Replace only the default libpq trust-store selector, never weaken TLS."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"postgresql", "postgres", "postgresql+psycopg", "postgresql+asyncpg"}:
            raise MigrationError("Migration secret must be a PostgreSQL URL")
        query_items = parse_qsl(parsed.query, keep_blank_values=True)
        query = dict(query_items)
        # Explicit custom CA settings are intentionally preserved.
        if not query.get("sslrootcert") or query["sslrootcert"] == "system":
            query["sslrootcert"] = str(trusted_ca_bundle())
        return urlunsplit(parsed._replace(query=urlencode(query)))
    except MigrationError:
        raise
    except (ValueError, OSError):
        raise MigrationError(
            "Invalid migration TLS URL encoding; check the secret format without logging it"
        ) from None


def migration_secret(config: dict[str, Any]) -> str:
    secret = config["secrets"]["MIGRATION_DATABASE_URL"]
    name = str(secret["name"])
    version = str(secret["version"])
    if not SECRET_NAME.fullmatch(name) or not SECRET_VERSION.fullmatch(version):
        raise MigrationError("Migration secret name or version is invalid")
    raw = gcloud(
        ["secrets", "versions", "access", version, "--secret", name],
        project=config["project_id"],
        impersonate=True,
    )
    try:
        url = raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        raise MigrationError("Migration secret is not a UTF-8 PostgreSQL URL") from None
    if not url or "\n" in url or "\r" in url:
        raise MigrationError("Migration secret URL is missing or contains newlines")
    return migration_tls_url(url)


def connection_profile(url: str) -> tuple[str, dict[str, Any]]:
    # Exact same TLS and channel-binding policy used by the API/Alembic runtime.
    import importlib.util
    spec = importlib.util.spec_from_file_location("photointel_migration_db_policy", DB_POLICY)
    if not spec or not spec.loader:
        raise MigrationError("Cannot load isolated database connection policy")
    db_policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(db_policy)
    database_connection_options = db_policy.database_connection_options

    @dataclass
    class Options:
        database_url: str = url
        migration_database_url: str = url
        database_pool_mode: str = "direct"
        database_require_tls: bool = True
        database_tls_ca_file: Path | None = None
        database_pool_size: int = 1
        database_max_overflow: int = 0
        database_pool_timeout_seconds: int = 15

    try:
        resolved, args = database_connection_options(Options(), migration=True)
    except (ValueError, TypeError):
        raise MigrationError("Migration secret must use a supported TLS PostgreSQL URL") from None
    if "-pooler." in (resolved.host or ""):
        raise MigrationError("Migration secret must use Neon's DIRECT endpoint, not the pooler")
    if resolved.drivername != "postgresql+psycopg":
        # Use psycopg3 for consistent SCRAM/SNI handling. It supports asyncpg URLs
        # after removing driver metadata; SQLAlchemy validates query options above.
        resolved = resolved.set(drivername="postgresql+psycopg")
        query = dict(resolved.query)
        query["sslmode"] = "verify-full"
        query.setdefault("sslrootcert", "system")
        resolved = resolved.set(query=query)
        args = {"connect_timeout": 15}
    if resolved.query.get("sslmode") != "verify-full":
        raise MigrationError("Migration connection must verify TLS and hostname")
    conninfo = resolved.set(drivername="postgresql").render_as_string(hide_password=False)
    return conninfo, args


def inspect_database(conninfo: str, args: dict[str, Any]) -> Status:
    import psycopg

    try:
        with psycopg.connect(conninfo, **args) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                    "AND table_name <> 'alembic_version'"
                )
                tables = int(cur.fetchone()[0])
                cur.execute("SELECT to_regclass('public.alembic_version')")
                exists = cur.fetchone()[0]
                revision = "base"
                if exists:
                    cur.execute("SELECT version_num FROM public.alembic_version")
                    revisions = [str(row[0]) for row in cur.fetchall()]
                    revision = ",".join(revisions) if revisions else "base"
                conn.rollback()
    except Exception as exc:
        raise MigrationError(
            "Cannot inspect Neon directly (" + classify_error(str(exc))[0] + "). "
            + classify_error(str(exc))[1]
        ) from None
    if not re.fullmatch(r"[a-zA-Z0-9_,.-]{1,160}", revision):
        raise MigrationError("Alembic revision contains unexpected metadata")
    return Status(revision=revision, user_tables=tables)


def classify_error(text: str) -> tuple[str, str]:
    lowered = text.casefold()
    for marker, code, hint in HINTS:
        if marker in lowered:
            return code, hint
    return "MIGRATION_ERROR", "Review sanitized Alembic traceback and database revision."


def backup_prefix(prefix: str, project: str) -> str:
    root = f"gs://{project}-photointel-build-source/migration-backups/"
    if not prefix.startswith(root) or not SEGMENT.fullmatch(prefix[len(root):]):
        raise MigrationError("Backup must be in the project's private migration-backups/NAME prefix")
    return prefix


def resolve_backup(project: str, prefix: str) -> str:
    if prefix:
        return backup_prefix(prefix, project)
    root = f"gs://{project}-photointel-build-source/migration-backups/"
    try:
        listing = gcloud(
            ["storage", "ls", root + "*/restore-verification.json"],
            project=project,
        ).decode("utf-8")
    except (MigrationError, UnicodeDecodeError):
        raise MigrationError("No readable private backup receipts; supply a verified prefix") from None
    options = {
        line.strip().rsplit("/", 1)[0] for line in listing.splitlines()
        if line.strip().startswith(root) and line.strip().endswith("/restore-verification.json")
    }
    options = {backup_prefix(candidate, project) for candidate in options}
    if len(options) != 1:
        raise MigrationError(
            f"Found {len(options)} backup receipts; exactly one is required for auto-selection"
        )
    return next(iter(options))


def validate_backup(project: str, prefix: str, work: Path) -> None:
    source = resolve_backup(project, prefix)
    work.chmod(0o700)
    for name in ("backup.json", "manifest.enc", "restore-verification.json"):
        # Use --destination flag? gcloud storage cp supports source and target as args.
        result = cloud_run(
            ["storage", "cp", f"{source}/{name}", str(work / name)],
            project=project, text=False, timeout=180,
        )
        if result.returncode:
            raise MigrationError("Required private backup metadata could not be downloaded")
        (work / name).chmod(0o600)
    verify_backup_receipt(work, work / "restore-verification.json")
    print("✅ Verified backup receipt, encrypted manifest and restore evidence.", flush=True)


def run_alembic(mode: str, url: str) -> None:
    environment = os.environ.copy()
    # No application / cloud credentials are passed to Alembic beyond what
    # the runner already has; only the pinned direct migration URL is needed.
    environment.update({
        "MIGRATION_DATABASE_URL": url,
        "DATABASE_URL": url,
        "APP_ENV": "production",
        "DATABASE_REQUIRE_TLS": "true",
        "DATABASE_POOL_MODE": "direct",
        "PYTHONPATH": str(ROOT / "apps/api/src"),
        "PYTHONUNBUFFERED": "1",
    })
    command = [
        sys.executable, "-m", "alembic", "-c", str(ALEMBIC_FILE),
        *(["upgrade", "head"] if mode == "apply" else ["current", "-v"]),
    ]
    print("🗃️ Alembic: " + ("upgrade head" if mode == "apply" else "current"), flush=True)
    result = subprocess.run(
        command, cwd=ROOT, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, errors="replace", timeout=2700, check=False,
    )
    # Never forward SQL logs or tracebacks raw; URLs and passwords may be present.
    # Print only known revision transitions, with allowlisted syntax.
    for line in (result.stdout + "\n" + result.stderr).splitlines():
        matched = re.search(
            r"(?:Running upgrade|Running downgrade)\s+"
            r"([a-zA-Z0-9_<>,.\- ]{1,130})",
            line,
        )
        if matched:
            print("  ↳ " + matched.group(0)[:145], flush=True)
    if result.returncode:
        code, hint = classify_error(result.stderr + "\n" + result.stdout)
        print(f"::error title=Neon {code}::{hint}", flush=True)
        raise MigrationError(f"Alembic exited with code {result.returncode}; {code}. {hint}")
    print("✅ Alembic completed successfully.", flush=True)


def summary(text: str) -> None:
    print(text, flush=True)
    dest = os.environ.get("GITHUB_STEP_SUMMARY")
    if dest:
        with Path(dest).open("a", encoding="utf-8") as output:
            output.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("plan", "apply", "diagnose", "verify"), required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument(
        "--database",
        choices=("unselected", "initial-empty", "existing-with-backup"),
        default="unselected",
    )
    parser.add_argument("--backup-prefix", default="")
    parser.add_argument("--config", type=Path, default=CONFIG)
    opts = parser.parse_args(argv)
    try:
        config = validate(
            json.loads(opts.config.read_text(encoding="utf-8")), production=True
        )
        if config["project_id"] != opts.project:
            raise MigrationError("Project mismatch; refusing to read another secret")
        secret = config["secrets"]["MIGRATION_DATABASE_URL"]
        summary(
            "### 🗃️ Neon migrations\n"
            f"- Mode: **{opts.mode}** | Project: **{opts.project}**\n"
            f"- Secret version: **{secret['name']}:{secret['version']}**"
        )
        url = migration_secret(config)
        conninfo, args = connection_profile(url)
        before = inspect_database(conninfo, args)
        summary(f"- Alembic before: **{before.revision}**")
        summary(f"- Application tables in public: **{before.user_tables}**")
        if opts.mode == "verify":
            # Automated deployment gate. Never run upgrades or migrations.
            from alembic.config import Config
            from alembic.script import ScriptDirectory

            heads = set(ScriptDirectory.from_config(Config(str(ALEMBIC_FILE))).get_heads())
            actual = set(before.revision.split(","))
            if not heads or actual != heads or before.user_tables == 0:
                raise MigrationError(
                    "Neon schema does not match the checked-out Alembic head. "
                    "Run Migrate Neon plan and apply with verified recovery evidence."
                )
            summary("✅ Database matches repository Alembic head (read-only).")
            return 0
        if opts.mode != "apply":
            run_alembic(opts.mode, url)
            summary("✅ Read-only inspection complete. No migrations executed.")
            return 0
        if opts.database == "initial-empty":
            if before.user_tables != 0 or before.revision != "base":
                raise MigrationError(
                    "Database is NOT empty. Refusing initial-empty migration; "
                    "inspect revisions and use verified recovery evidence if appropriate."
                )
            if opts.backup_prefix:
                raise MigrationError("initial-empty must not supply a backup prefix")
        elif opts.database == "existing-with-backup":
            with tempfile.TemporaryDirectory(prefix="photointel-backup-") as directory:
                validate_backup(opts.project, opts.backup_prefix, Path(directory))
        else:
            raise MigrationError("Select initial-empty or existing-with-backup for apply")
        run_alembic("apply", url)
        after = inspect_database(conninfo, args)
        summary(f"- Alembic after: **{after.revision}**")
        summary("✅ Neon migration completed directly from GitHub Actions.")
        return 0
    except (MigrationError, ConfigurationError, KeyError, ValueError,
            OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        if isinstance(exc, subprocess.TimeoutExpired):
            message = "Alembic timed out; check Neon revision before another apply"
        elif isinstance(exc, (MigrationError, ConfigurationError)):
            # ConfigurationError raised by trusted local validation code.
            message = str(exc)
        else:
            message = f"Migration prerequisites failed ({type(exc).__name__})"
        summary(f"❌ {message}")
        print(f"::error title=Neon migration::{message}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
