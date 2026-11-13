"""Publish code/assets/bindings without reconciling Terraform-owned triggers."""
import os
import re
import subprocess
from pathlib import Path


def publish_version(config: Path, *, cwd: Path, env: dict[str, str]) -> None:
    suffix = env.get("GITHUB_RUN_ID", "local") + "-" + env.get("GITHUB_RUN_ATTEMPT", "1")
    tag = "release-" + suffix
    if not re.fullmatch(r"[A-Za-z0-9-]{1,63}", tag):
        raise ValueError("Invalid Worker version tag")
    # versions upload/deploy do not apply routes, domains or cron triggers.
    for args in (
        ["versions", "upload", "--config", str(config), "--tag", tag, "--keep-vars"],
        ["versions", "deploy", "--config", str(config), "--version-tag", tag, "--yes"],
    ):
        result = subprocess.run(["npx", "--yes", "wrangler@4", *args], cwd=cwd, env=env,
                                capture_output=True, text=True, timeout=300, check=False)
        if result.returncode:
            raise RuntimeError("Worker version publication failed; inspect Cloudflare version/deployment status")
    print("Worker code/assets/bindings published; Terraform-owned domains and triggers preserved")
