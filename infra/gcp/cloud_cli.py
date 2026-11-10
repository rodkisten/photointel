#!/usr/bin/env python3
"""The single Google Cloud CLI transport for PhotoIntel infrastructure.

All Python, Bash and Node infrastructure callers should build and execute
GCloud commands through this module. Business-specific validation remains in
the caller. Do not import application services here: it must work in Cloud
Shell, a Cloud Build CLI image, GitHub WIF and the terminal container.

Safety:
* explicit project, never an implicit active gcloud project;
* a single normalized --project / --quiet, no shell interpolation;
* no automatic interactive authentication, credential refresh or IAM mutation;
* no raw provider stderr or secret contents in exceptions / CLI errors;
* arguments remain lists, and binary secret input/output is supported;
* a full-width, highlighted, redacted command preview goes to stderr only.
"""
from __future__ import annotations

import argparse
import os
import re
import shlex
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from typing import Sequence

PROJECT_PATTERN = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
ALLOWED_ACTION = re.compile(r"^[a-z][a-z0-9-]*$")
PERMISSION = re.compile(
    r"\b(?:compute|iam|artifactregistry|serviceusage|secretmanager|run|cloudbuild|logging|storage|cloudscheduler)"
    r"\.[A-Za-z]+\.[A-Za-z]+\b"
)

# These flags can contain credentials directly, or embed key=value pairs.
# Mask the entire value, even if the value happens to be harmless.
SENSITIVE_FLAG = re.compile(
    r"(?:^|[-_])(?:password|passwd|token|secret|credential|credentials|"
    r"private[-_]?key|api[-_]?key|auth[-_]?header|authorization|"
    r"env[-_]?vars|env[-_]?vars[-_]?file|set[-_]?secrets|update[-_]?secrets|"
    r"headers|data|payload|body)(?:$|[-_])",
    re.IGNORECASE,
)
SENSITIVE_ASSIGNMENT = re.compile(
    r"(?:^|[^A-Z0-9_])(?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|PASSWD|"
    r"PRIVATE_KEY|API_KEY|CREDENTIALS?|AUTHORIZATION)\s*=",
    re.IGNORECASE,
)
HIGHLIGHT = re.compile(
    r"(?<!\S)gcloud(?=\s|$)|"
    r"(?<!\S)(?:run|services|jobs|secrets|versions|create|update|describe|list|"
    r"add|iam|artifacts|config|builds|auth|scheduler|projects)(?=\s|$)|"
    r"--[a-z][a-z0-9-]*|<redacted>", re.I
)


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


def _safe_preview_args(invocation: Sequence[str]) -> list[str]:
    """Redact sensitive flag values, without changing real subprocess arguments.

    No security guarantee is possible for arbitrary user-provided positional
    parameters. Never put credentials in argv; pass them using stdin or a secret
    store. This function is defense in depth for common Cloud CLI flags.
    """
    safe: list[str] = []
    i = 0
    while i < len(invocation):
        value = invocation[i]
        # Multiline/control characters must not break terminal panel boundaries.
        display = "".join(
            char if char >= " " and char != "\x7f" else f"\\x{ord(char):02x}"
            for char in value
        )
        if value.startswith("--"):
            name, separator, _ = value.partition("=")
            if SENSITIVE_FLAG.search(name[2:]):
                if separator:
                    safe.append(name + "=<redacted>")
                    i += 1
                    continue
                safe.append(name)
                if i + 1 < len(invocation) and not invocation[i + 1].startswith("--"):
                    safe.append("<redacted>")
                    i += 2
                    continue
                i += 1
                continue
        if SENSITIVE_ASSIGNMENT.search(value):
            safe.append("<redacted>")
        else:
            safe.append(display)
        i += 1
    return safe


def _highlight_line(line: str, *, enabled: bool) -> str:
    if not enabled:
        return line
    reset = "\033[0m"

    def colorize(match: re.Match[str]) -> str:
        word = match.group()
        if word == "<redacted>":
            color = "\033[1;31m"
        elif word.lower() == "gcloud":
            color = "\033[1;36m"
        elif word.startswith("--"):
            color = "\033[1;35m"
        else:
            color = "\033[1;33m"
        return color + word + reset

    return HIGHLIGHT.sub(colorize, line)


def print_running_command(invocation: Sequence[str]) -> None:
    """Draw a full-width terminal panel without altering stdout or commands."""
    # A single stream write avoids output from concurrent calls interleaving
    # character by character. stderr keeps stdout safe for JSON or secret bytes.
    stream = sys.stderr
    width = max(28, shutil.get_terminal_size(fallback=(100, 24)).columns)
    inner_width = width - 4  # '│ ' + content + ' │'
    shell_command = " ".join(shlex.quote(item) for item in _safe_preview_args(invocation))
    wrapped = textwrap.wrap(
        shell_command,
        width=inner_width,
        break_long_words=True,
        break_on_hyphens=False,
    ) or [""]
    colors = stream.isatty() and "NO_COLOR" not in os.environ and os.environ.get("TERM") != "dumb"
    title = "> running command:"
    if colors:
        title = "\033[1;33m" + title + "\033[0m"

    def panel_line(raw: str, colored: str | None = None) -> str:
        # Measure the uncolored text, not ANSI escape sequences.
        return "│ " + (colored if colored is not None else raw) + " " * max(0, inner_width - len(raw)) + " │"

    lines = ["┌" + "─" * (width - 2) + "┐", panel_line("> running command:", title), panel_line("")]
    lines.extend(panel_line(raw, _highlight_line(raw, enabled=colors)) for raw in wrapped)
    lines.append("└" + "─" * (width - 2) + "┘")
    stream.write("\n".join(lines) + "\n")
    stream.flush()


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

    Returns CompletedProcess for callers that need to inspect a failed command,
    including private stderr used for classified recovery decisions. Callers
    must never print its raw stderr.
    """
    if timeout < 1 or timeout > 3600:
        raise ValueError("GCP command timeout must be between 1 and 3600 seconds")
    invocation = command(args, project=project, binary=binary, quiet=quiet, impersonate=impersonate)
    print_running_command(invocation)
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
        print_running_command(full)
        process = subprocess.run(
            full,
            stdin=sys.stdin.buffer,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=opts.timeout,
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
