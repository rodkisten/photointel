#!/usr/bin/env python3
"""Select only affected PhotoIntel CI jobs. Safe fallback: all jobs."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

JOBS = ("python", "frontend", "integration", "containers", "security")
SHARED = ("scripts/ci/", ".github/actions/", ".github/workflows/ci.yml")


def select(files: list[str], scope: str = "auto") -> set[str]:
    if scope == "all":
        return set(JOBS)
    if scope in JOBS:
        return {scope}
    if scope != "auto":
        raise ValueError(f"Unknown CI scope: {scope}")
    selected: set[str] = set()
    for path in files:
        if path == "*" or path.startswith(SHARED) or path in {"Makefile", ".env.example"}:
            return set(JOBS)
        if path.startswith(("apps/api/", "gpu/", "bridges/", "packages/python/", "tests/")) or path in ("pyproject.toml", "uv.lock"):
            selected.add("python")
        if path.startswith(("apps/web/", "apps/manage/", "packages/ui/", "packages/frontend/")):
            selected.add("frontend")
        if path.startswith(("infra/migrations/", "infra/scripts/", "tests/integration/", "apps/api/", "infra/docker/minio.")):
            selected.add("integration")
        if path.startswith(("infra/docker/", "apps/api/", "apps/web/")) or path == "cloudbuild.yaml":
            selected.add("containers")
        if path.startswith(("apps/", "gpu/", "bridges/", "packages/", "infra/docker/")) or path in ("pyproject.toml", "uv.lock"):
            selected.add("security")
    return selected


def changed_files(base: str, head: str) -> list[str]:
    if not base or set(base) == {"0"}:
        return ["*"]
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "-z", f"{base}...{head}"],
            capture_output=True, check=True,
        )
    except subprocess.CalledProcessError:
        return ["*"]
    return [path.decode() for path in result.stdout.split(b"\0") if path]


def main() -> None:
    scope = os.environ.get("SCOPE", "auto")
    files = changed_files(os.environ.get("BASE_SHA", ""), os.environ.get("HEAD_SHA", "HEAD")) if scope == "auto" else []
    selected = select(files, scope)
    print("Changed files:", *files, sep="\n  ")
    print("Selected jobs:", ", ".join(sorted(selected)) or "(none)")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for name in JOBS:
            output.write(f"{name}={'true' if name in selected else 'false'}\n")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        summary.write("### 🧭 Contexto da CI\n\n")
        summary.write(f"Modo: `{scope}`\n\n")
        summary.write("Jobs: " + (", ".join(sorted(selected)) or "nenhum") + "\n")


if __name__ == "__main__":
    main()
