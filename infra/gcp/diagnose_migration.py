#!/usr/bin/env python3
"""Read-only troubleshooting for one Cloud Run migration execution.

Reads execution/task status and bounded Cloud Logging records; never emits
raw logs unchanged because application tracebacks may contain database URLs,
tokens or environment values. Nothing here executes a migration.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from urllib.parse import quote

from infra.gcp.cloud_cli import run as cloud_run

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra/gcp/config.local.json"
JOB = "photointel-migrate"
EXECUTION = re.compile(r"photointel-migrate-[a-z0-9-]{3,40}$")
PROJECT = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]$")
REGION = re.compile(r"[a-z]+-[a-z]+[0-9]$")
MAX_LOG_LINES = 35

SIGNALS: tuple[tuple[str, str, str], ...] = (
    (
        "permission denied",
        "DATABASE_PERMISSION",
        "Check Neon migration-role permissions on the direct database endpoint.",
    ),
    (
        "insufficientprivilege",
        "DATABASE_PERMISSION",
        "Migration role lacks a required PostgreSQL permission.",
    ),
    (
        "password authentication failed",
        "DATABASE_AUTH",
        "Check the pinned MIGRATION_DATABASE_URL Secret Manager version.",
    ),
    (
        "could not translate host name",
        "DATABASE_DNS",
        "Check direct Neon host DNS and Cloud Run outbound network access.",
    ),
    (
        "connection timed out",
        "DATABASE_NETWORK",
        "Check Neon endpoint availability, timeout and Cloud Run egress.",
    ),
    (
        "connection refused",
        "DATABASE_NETWORK",
        "Verify the Neon direct endpoint, database port and egress path.",
    ),
    (
        "channel_binding",
        "DATABASE_CHANNEL_BINDING",
        "Verify the image uses psycopg async with channel binding support.",
    ),
    (
        "ssl error",
        "DATABASE_TLS",
        "Check system trust anchors, sslmode and the Neon endpoint certificate.",
    ),
    (
        "certificate verify failed",
        "DATABASE_TLS",
        "Check CA validation and host name in the direct Neon connection.",
    ),
    (
        "multiple head",
        "ALEMBIC_HEADS",
        "Review Alembic revision branches; do not stamp the database blindly.",
    ),
    (
        "can't locate revision",
        "ALEMBIC_REVISION",
        "The database references an unknown Alembic revision; inspect history.",
    ),
    (
        "duplicate table",
        "SCHEMA_CONFLICT",
        "An existing table conflicts with the migration; inspect the schema.",
    ),
    (
        "duplicate column",
        "SCHEMA_CONFLICT",
        "An existing column conflicts with the migration; inspect the schema.",
    ),
    (
        "undefinedtable",
        "SCHEMA_ORDER",
        "A migration references a table that does not exist yet.",
    ),
    (
        "modulenotfounderror",
        "MISSING_MODULE",
        "The deployed image is missing a Python module needed by migrations.",
    ),
    (
        "operationalerror",
        "DATABASE_OPERATION",
        "PostgreSQL or the network rejected an operation; inspect the safe excerpts.",
    ),
)

# Redaction is defense-in-depth; log excerpts below are allowlisted structural
# lines rather than arbitrary provider payloads.
DSN = re.compile(r"(?i)(?:postgres(?:ql)?|[a-z0-9+.-]+)://[^\s\"'<>]+")
KV = re.compile(
    r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|token|authorization|"
    r"credential|private[_-]?key)\s*[:=]\s*[^,\s;]+"
)
BEARER = re.compile(r"(?i)\bbearer\s+[^\s]+")
QUERY_SECRET = re.compile(r"(?i)(?:^|[?&])(password|token|key|secret)=[^&\s]+")
SENSITIVE_LINE = re.compile(r"(?i)(password|secret|token|credential|authorization|private.key)\s*[:=]")
TRACE_LINE = re.compile(
    r"^(?:Traceback \(most recent call last\):|During handling of the above|"
    r"The above exception was the direct cause|"
    r"\s*File \"[^\"]+\", line \d+.*|"
    r"\s*[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Failure):.*|"
    r"\s*(?:ERROR|Error|FATAL|PANIC):.*|"
    r"\s*sqlalchemy\.exc\.[A-Za-z]+:.*|"
    r"\s*psycopg\.[A-Za-z_.]+:.*)$"
)


def run_readonly(args: list[str], project: str, *, timeout: int = 50) -> dict[str, Any] | list[Any]:
    result = cloud_run([*args, "--format=json"], project=project, timeout=timeout)
    if result.returncode:
        # Never print provider stderr; gcloud can include sensitive values.
        message = result.stderr.lower()
        if "permission" in message or "denied" in message:
            raise PermissionError("read-only Google Cloud API access denied")
        raise RuntimeError("read-only Google Cloud query failed")
    value = json.loads(result.stdout or "null")
    if not isinstance(value, (dict, list)):
        raise ValueError("Google Cloud returned an unexpected document")
    return value


def clean_execution_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Missing Cloud Run execution name")
    short = value.rsplit("/", 1)[-1]
    if not EXECUTION.fullmatch(short):
        raise ValueError("Invalid migration execution name")
    return short


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def find_execution(
    project: str, region: str, *, requested: str = "", started_after: str = ""
) -> tuple[str, dict[str, Any]]:
    if requested:
        execution = clean_execution_name(requested)
        result = run_readonly(
            ["run", "jobs", "executions", "describe", execution,
             "--region", region], project,
        )
        if not isinstance(result, dict):
            raise ValueError("Invalid execution description")
        return execution, result

    result = run_readonly(
        ["run", "jobs", "executions", "list", "--job", JOB,
         "--region", region, "--limit=15"], project,
    )
    if not isinstance(result, list):
        raise ValueError("Invalid execution list")
    candidates = []
    started = parse_time(started_after) if started_after else None
    if started_after and started is None:
        raise ValueError("Invalid execution start timestamp")
    for item in result:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or (item.get("metadata") or {}).get("name", "")
        try:
            short = clean_execution_name(name)
        except ValueError:
            continue
        when = parse_time(
            item.get("createTime")
            or item.get("metadata", {}).get("creationTimestamp")
            or item.get("status", {}).get("startTime")
        )
        if started:
            if not when or when < started - timedelta(seconds=25):
                continue
            if when > datetime.now(UTC) + timedelta(minutes=2):
                continue
        candidates.append((short, item, when or datetime.min.replace(tzinfo=UTC)))

    candidates.sort(key=lambda record: record[2], reverse=True)
    if not candidates:
        raise ValueError("No matching Cloud Run migration executions were found")
    if started and len(candidates) != 1:
        raise ValueError(
            "Multiple migrations started in this time window; refusing to guess the execution"
        )
    chosen = candidates[0][0]
    described = run_readonly(
        ["run", "jobs", "executions", "describe", chosen, "--region", region],
        project,
    )
    if not isinstance(described, dict):
        raise ValueError("Invalid execution details")
    return chosen, described


def run_logs(project: str, region: str, execution: str) -> list[dict[str, Any]]:
    # Official Cloud Run log schema: resource.type=cloud_run_job,
    # resource.labels.job_name and labels.execution_name.
    filter_text = (
        'resource.type="cloud_run_job" '
        f'AND resource.labels.job_name="{JOB}" '
        f'AND resource.labels.location="{region}" '
        f'AND labels.execution_name="{execution}"'
    )
    result = run_readonly(
        [
            "logging", "read", filter_text, "--freshness=1d",
            "--limit=100", "--order=asc",
        ],
        project,
    )
    if not isinstance(result, list):
        raise ValueError("Unexpected Cloud Logging response")
    return [item for item in result if isinstance(item, dict)]


def classify(entries: list[dict[str, Any]]) -> list[tuple[str, str]]:
    combined = "\n".join(
        str(e.get("textPayload", "")) + "\n" +
        str(e.get("jsonPayload", {}).get("message", ""))
        for e in entries
    ).casefold()
    found: dict[str, str] = {}
    for marker, code, guidance in SIGNALS:
        if marker in combined:
            found[code] = guidance
    return list(found.items())


def safe_excerpt(message: str) -> str | None:
    """Allow only traceback structures; strip URLs, credentials and long tokens."""
    if not isinstance(message, str):
        return None
    message = message.strip("\n").replace("\r", "")
    if len(message) > 1000 or SENSITIVE_LINE.search(message):
        return None
    if not TRACE_LINE.fullmatch(message):
        return None
    message = DSN.sub("[URL REDACTED]", message)
    message = KV.sub(r"\1=[REDACTED]", message)
    message = QUERY_SECRET.sub("[REDACTED QUERY]", message)
    message = BEARER.sub("Bearer [REDACTED]", message)
    return message[:320]


def excerpts(entries: list[dict[str, Any]]) -> list[str]:
    selected: list[str] = []
    for entry in entries:
        obj = entry.get("jsonPayload") or {}
        content = entry.get("textPayload") or (
            obj.get("message") if isinstance(obj, dict) else ""
        )
        if not isinstance(content, str):
            continue
        for line in content.splitlines():
            safe = safe_excerpt(line)
            if safe:
                selected.append(safe)
    return selected[-MAX_LOG_LINES:]


def summary_line(text: str) -> None:
    print(text, flush=True)
    path = __import__("os").environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with Path(path).open("a", encoding="utf-8") as file:
            file.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--execution", default="")
    parser.add_argument("--started-after", default="")
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        project = config["project_id"]
        region = config["region"]
        if args.project != project or not PROJECT.fullmatch(project):
            raise ValueError("Project confirmation does not match the production config")
        if not REGION.fullmatch(region):
            raise ValueError("Invalid region in production config")
        name, execution = find_execution(
            project, region,
            requested=args.execution,
            started_after=args.started_after,
        )
        link = (
            f"https://console.cloud.google.com/run/jobs/executions/details/"
            f"{region}/{name}?project={quote(project)}"
        )
        summary_line("### 🗃️ Cloud Run migration troubleshooting")
        summary_line(f"- **Execution:** `{name}`")
        summary_line(f"- [Open execution details and complete logs]({link})")
        status = execution.get("status", {}) if isinstance(execution.get("status"), dict) else {}
        for label, field in [
            ("Started", "startTime"), ("Finished", "completionTime"),
            ("Successful tasks", "succeededCount"), ("Failed tasks", "failedCount"),
            ("Cancelled tasks", "cancelledCount"),
        ]:
            value = status.get(field) or execution.get(field)
            if isinstance(value, (str, int)) and len(str(value)) < 90:
                summary_line(f"- **{label}:** {value}")
        conditions = status.get("conditions") or execution.get("conditions") or []
        if isinstance(conditions, list):
            for item in conditions[:5]:
                if isinstance(item, dict):
                    typ = str(item.get("type", "unknown"))[:40]
                    value = str(item.get("status", "unknown"))[:20]
                    print(f"🧩 Condition {typ}: {value}")

        try:
            tasks = run_readonly(
                ["run", "jobs", "executions", "tasks", "list",
                 f"--execution={name}", "--region", region, "--limit=10"],
                project,
            )
            if isinstance(tasks, list):
                for task in tasks[:10]:
                    if isinstance(task, dict):
                        item = task.get("status") or {}
                        if not isinstance(item, dict):
                            item = {}
                        exit_code = item.get("exitCode", task.get("exitCode", "unknown"))
                        index = task.get("index", task.get("metadata", {}).get("name", "?"))
                        print(f"🧩 Task {str(index)[:60]}: exit code {str(exit_code)[:25]}")
        except (ValueError, RuntimeError, PermissionError, subprocess.TimeoutExpired):
            summary_line("- Task details unavailable; inspect the Cloud Run execution page.")

        try:
            entries = run_logs(project, region, name)
            summary_line(f"- **Log entries found:** {len(entries)}")
            for code, guidance in classify(entries):
                summary_line(f"- **{code}:** {guidance}")
                print(f"::error title=Migration {code}::{guidance}")
            lines = excerpts(entries)
            if lines:
                print("📜 Redacted traceback excerpts (never raw secret-bearing logs):")
                for line in lines:
                    print("  " + line)
                summary_line("#### 📜 Safe traceback excerpts")
                for line in lines[-12:]:
                    summary_line(f"    {line}")
            else:
                summary_line("- No safe traceback excerpt available. Open the full logs link above.")
        except PermissionError:
            summary_line(
                "- **Logs unavailable (IAM):** deployer needs `roles/logging.viewer`. "
                "Run GCP Bootstrap apply, then retry `migrate → diagnose`."
            )
            print("::warning title=Cloud Logging IAM::Missing read permission; grant roles/logging.viewer to the deployer.")
        except (ValueError, RuntimeError, subprocess.TimeoutExpired):
            summary_line(
                "- Cloud Logging query failed or timed out; the execution link above "
                "contains the authoritative logs."
            )
        summary_line("**Next:** correct the identified failure, then inspect migration status before retrying. Never blindly repeat a partially applied migration.")
        return 0
    except (OSError, ValueError, KeyError, PermissionError, RuntimeError, subprocess.TimeoutExpired) as exc:
        # Do not print subprocess output or provider-generated exceptions.
        print(f"::warning title=Migration diagnosis unavailable::{type(exc).__name__}: check Cloud Run Job executions and IAM.")
        summary_line("### 🗃️ Migration diagnosis unavailable")
        summary_line("- Open [Cloud Run Jobs](https://console.cloud.google.com/run/jobs) and select photointel-migrate.")
        summary_line("- Check execution history, task exit codes and full logs. No migration was triggered by this diagnostic.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
