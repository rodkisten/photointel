"""Unified, non-destructive PhotoIntel diagnostics and deployment entrypoint."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / ".photointel-reports"
REDACT = re.compile(r"(?i)(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s,]+")


def run(args: list[str], *, log: Path | None = None) -> int:
    print("$ " + " ".join(args), flush=True)
    with subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True,
                          errors="replace", bufsize=1) as process:
        assert process.stdout is not None
        with log.open("w", encoding="utf-8") if log else open(os.devnull, "w") as output:
            for line in process.stdout:
                safe = REDACT.sub(r"\1=[REDACTED]", line)
                print(safe, end="", flush=True)
                output.write(safe)
        return process.wait()


def test() -> int:
    REPORTS.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log = REPORTS / f"tests-{stamp}.log"
    print(f"🧪 Running full Python test discovery. Log: {log}")
    code = run([sys.executable, "-m", "unittest", "discover",
                "-s", "infra/gcp/tests", "-p", "test_*.py", "-v"], log=log)
    log.chmod(0o600)
    lines = log.read_text(encoding="utf-8").splitlines()
    failures = [line for line in lines if line.startswith(("FAIL:", "ERROR:", "FAILED ", "Ran "))]
    print("\n".join(failures) or "No unittest summary found")
    print(f"📋 Complete report: {log}")
    print("Copy from the file in the Codespaces editor; OSC 52 clipboard support varies.")
    return code


def doctor() -> int:
    print("🩺 PhotoIntel doctor (read-only)")
    failed = False
    for tool in ("python3", "git", "gh", "gcloud", "node", "npm"):
        path = shutil.which(tool)
        print(f"{'✅' if path else '⚠️'} {tool}: {path or 'not installed'}")
        failed |= path is None
    path = ROOT / "infra/gcp/config.local.json"
    if path.exists():
        try:
            cfg = json.loads(path.read_text(encoding="utf-8"))
            for key in ("project_id", "region", "repository"):
                print(f"{key}: {cfg.get(key, '<missing>')}")
            if cfg.get("project_id") != "photointel":
                failed = True
        except (OSError, ValueError) as exc:
            print(f"⚠️ Invalid local config: {type(exc).__name__}")
            failed = True
    else:
        print("ℹ️ Local config missing; deploy.sh can resolve its other sources")
    return int(failed)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PhotoIntel unified orchestration")
    parser.add_argument("command", choices=("doctor", "test", "deploy"))
    parser.add_argument("--all", action="store_true", help="Deploy all stages")
    parser.add_argument("--yes", action="store_true", help="Explicitly approve production changes")
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return doctor()
    if args.command == "test":
        return test()
    if not args.all:
        parser.error("deploy requires --all")
    if not args.yes:
        parser.error("deploy requires --yes (explicit production approval)")
    if test():
        print("⛔ Tests failed; production deployment blocked")
        return 1
    return run(["bash", str(ROOT / "deploy.sh"), "all", "--yes", "--no-tmux"])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
