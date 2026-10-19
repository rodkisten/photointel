#!/usr/bin/env python3
"""Scan Git history and trackable source, excluding ignored local credentials.

Requires a separately installed Gitleaks binary. Reports redact matched values;
source bytes and temporary files never become public CI artifacts automatically.
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitleaks-binary", default="gitleaks")
    parser.add_argument("--output", type=Path, default=ROOT / "var/security")
    args = parser.parse_args()
    binary = shutil.which(args.gitleaks_binary)
    if binary is None:
        parser.error("Install Gitleaks and verify its published release checksum first")
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    common = [
        binary,
        "--config",
        str(ROOT / ".gitleaks.toml"),
        "--redact=100",
        "--report-format",
        "json",
        "--no-banner",
    ]
    history = subprocess.run(
        [*common, "--report-path", str(output / "history.json"), "git", str(ROOT)],
        cwd=ROOT,
        check=False,
    )
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    ).split(b"\0")
    copied = 0
    with tempfile.TemporaryDirectory(prefix="photointel-source-scan-") as temporary:
        source = Path(temporary)
        for name in sorted(set(names)):
            if not name:
                continue
            relative = Path(os.fsdecode(name))
            original = ROOT / relative
            if original.is_symlink() or not original.is_file():
                continue
            target = source / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            target.chmod(0o600)
            copied += 1
        working = subprocess.run(
            [*common, "--report-path", str(output / "source.json"), "dir", str(source)],
            cwd=ROOT,
            check=False,
        )
    for report in output.glob("*.json"):
        report.chmod(0o600)
    print(
        json.dumps(
            {
                "history_exit_code": history.returncode,
                "source_exit_code": working.returncode,
                "source_files": copied,
                "scope": "Git history and trackable source; ignored files excluded",
                "matched_values": "redacted",
            }
        )
    )
    return max(history.returncode, working.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
