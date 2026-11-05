"""PhotoIntel infrastructure administration package.

Run with python -m infra.<module> from the repository, or install the
distribution to use the named console entrypoints. No sys.path mutation.
"""
from __future__ import annotations

import os
from pathlib import Path


def repository_root(module_file: str | Path) -> Path:
    """Find an explicit checkout for administrative tools, never site-packages.

    The pure photointel-gcloud transport intentionally does not need this.
    Build/provision commands do need a checkout containing the resource files.
    """
    override = os.environ.get("PHOTOINTEL_REPO_ROOT")
    if override:
        candidate = Path(override).expanduser().resolve()
        if not (candidate / "pyproject.toml").is_file() or not (
            candidate / "infra/gcp/cloud_cli.py"
        ).is_file():
            raise RuntimeError("PHOTOINTEL_REPO_ROOT is not a PhotoIntel checkout")
        return candidate

    folder = Path.cwd().resolve()
    for candidate in (folder, *folder.parents, Path(module_file).resolve().parents[2]):
        if (candidate / "pyproject.toml").is_file() and (
            candidate / "infra/gcp/cloud_cli.py"
        ).is_file():
            return candidate
    raise RuntimeError(
        "Administrative commands require a PhotoIntel checkout. "
        "Run from its directory or set PHOTOINTEL_REPO_ROOT."
    )
