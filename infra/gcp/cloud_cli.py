#!/usr/bin/env python3
"""The single Google Cloud CLI transport for PhotoIntel infrastructure.

All Python, Bash and Node infrastructure callers should build and execute
gcloud commands through this module. Business-specific validation remains in
the caller. Do not import application services here: it must work in Cloud
Shell, a Cloud Build CLI image, GitHub WIF and the terminal container.

Safety:
* explicit project, never an implicit active gcloud project;
* a single normalized --project / --quiet, no shell interpolation;
* no automatic interactive authentication, credential refresh or IAM mutation;
* no raw provider stderr or secret contents in exceptions / CLI errors;
* arguments remain lists, and binary secret input/output is supported.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Sequence

PROJECT_PATTERN = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
ALLOWED_ACTION = re.compile(r"^[a-z][a-z0-9-]*$")
PERMISSION = re.compile(r"\b(?:compute|iam|artifactregistry|serviceusage|secretmanager|run|cloudbuild|logging|storage|cloudscheduler)\.[A-Za-z]+\.[A-Za-z]+\b")

@dataclass(frozen=True)
class CloudFailure:
    code: str
    permissions: tuple[str, ...] = ()


def classify(stderr: str | bytes) -> CloudFailure:
    """Classify stderr; never return or print unfiltered provider text."""
    value = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else (stderr or "")
    lower = value.casefold()
    denied = any(marker in lower for marker in (
        "permission_denied", "permission denied", "does not have permission",
        "required permission", "forbidden", "403", "access denied",
    ))
    missing = any(marker in lower for marker in (
        "not_found", "not found", "does not exist", "was not found", "404",
    ))
    unauthorized = any(marker in lower for marker in (
        "unauthenticated", "invalid_grant", "no active account", "login required",
    ))
    code = "PERMISSION_DENIED" if denied else "NOT_FOUND" if missing else (
        "UNAUTHENTICATED" if unauthorized else "PROVIDER_ERROR"
    )
    return CloudFailure(code, tuple(sorted(set(PERMISSION.findall(value))))[:8])


def command(
    args: Sequence[str],
    *,
    project: str | None = None,
    binary: str = "gcloud",
    quiet: bool = True,
    impersonate: str | None = None,
) -> list[str]:
    """Normalize all gcloud flags, refusing conflicting project scope."""
    items = list(args)
    if not items or any(not isinstance(x, str) or "\x00" in x for x in items):
        raise ValueError("gcloud arguments must be nonempty strings")
    clean: list[str] = []
    specified: list[str] = []
    i = 0
    while i < len(items):
        arg = items[i]
        if arg == "--project":
            if i + 1 >= len(items):
                raise ValueError("--project requires a value")
            specified.append(items[i + 1])
            i += 2
            continue
        if arg.startswith("--project="):
            specified.append(arg.partition("=")[2])
            i += 1
            continue
        if arg == "--quiet":
            i += 1
            continue
        clean.append(arg)
        i += 1
    selected = project or (specified[0] if specified else None)
    if selected is None:
        raise ValueError("Explicit GCP project is required")
    if not PROJECT_PATTERN.fullmatch(selected):
        raise ValueError("Invalid GCP project")
    if any(x != selected for x in specified):
        raise ValueError("Conflicting GCP projects are forbidden")
    if impersonate is not None and not re.fullmatch(
        r"[a-z][a-z0-9-]{2,70}@[a-z][a-z0-9-]{4,60}\.iam\.gserviceaccount\.com",
        impersonate,
    ):
        raise ValueError("Invalid impersonation service account")
    if not isinstance(binary, str) or not binary or "\x00" in binary:
        raise ValueError("Invalid gcloud executable")
    output = [binary, *clean, "--project=" + selected]
    if quiet:
        output.append("--quiet")
    if impersonate:
        if any(x.startswith("--impersonate-service-account") for x in clean):
            raise ValueError("Impersonation is already configured in command")
        output.append("--impersonate-service-account=" + impersonate)
    return output


def run(
    args: Sequence[str],
    *,
    project: str | None = None,
    binary: str = "gcloud",
    quiet: bool = True,
    impersonate: str | None = None,
    timeout: int = 120,
    capture_output: bool = True,
    text: bool = True,
    input: str | bytes | None = None,
    env: dict[str, str] | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess:
    """Execute through subprocess without shell=True.

    Returns the standard CompletedProcess for existing callers that need to
    inspect a failed command, including a *private* stderr used for classified
    recovery decisions. Callers must not print its raw stderr.
    """
    if timeout < 1 or timeout > 3600:
        raise ValueError("GCP command timeout must be between 1 and 3600 seconds")
    invocation = command(args, project=project, binary=binary, quiet=quiet, impersonate=impersonate)
    completed = subprocess.run(
        invocation,
        input=input,
        capture_output=capture_output,
        text=text,
        check=False,
        timeout=timeout,
        env=env,
    )
    if check and completed.returncode:
        failure = classify(completed.stderr if capture_output else "")
        raise CloudCommandError(invocation[1:4], failure, completed.returncode)
    return completed


class CloudCommandError(RuntimeError):
    def __init__(self, action: Sequence[str], failure: CloudFailure, returncode: int):
        self.reason = failure.code
        self.permissions = failure.permissions
        self.returncode = returncode
        # Do not expose command arguments (e.g. --secret, --data-file) here.
        safe_action = " ".join(x for x in action[:3] if ALLOWED_ACTION.fullmatch(x))
        label = safe_action or "request"
        hint = " (" + ", ".join(failure.permissions) + ")" if failure.permissions else ""
        super().__init__(f"GCP {label}: {failure.code}{hint}")


def main(argv: list[str] | None = None) -> int:
    """CLI bridge for Bash and Node. Forwards stdout, never provider stderr."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--binary", default="gcloud")
    parser.add_argument("args", nargs=argparse.REMAINDER)
    opts = parser.parse_args(argv)
    args = opts.args[1:] if opts.args[:1] == ["--"] else opts.args
    if not args:
        parser.error("gcloud command is required after --")
    # A user-facing CLI must never dump potentially sensitive provider stderr.
    try:
        full = command(args, project=opts.project, binary=opts.binary)
        process = subprocess.run(
            full, stdin=sys.stdin.buffer,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, timeout=opts.timeout,
        )
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        reason = "TIMEOUT" if isinstance(error, subprocess.TimeoutExpired) else "EXECUTION_ERROR"
        print("CLOUD_CLI_ERROR " + reason, file=sys.stderr)
        return 1
    if process.returncode:
        info = classify(process.stderr)
        print("CLOUD_CLI_ERROR " + info.code, file=sys.stderr)
        return process.returncode if 1 <= process.returncode <= 125 else 1
    # Stdout may deliberately contain Secret Manager values: only pass it to
    # the requesting process/pipe; never mirror into logs or error messages.
    sys.stdout.buffer.write(process.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
