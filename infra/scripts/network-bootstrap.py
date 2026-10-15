#!/usr/bin/env python3
"""One explicit network bootstrap; public evidence and private local setup only.

The caller obtains environment permission before invoking this script. Credentials
and environment contents are never printed. Independent stages run in parallel;
failed external references are recorded without hiding successful installations.
"""

import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = Path("/tmp/model-research")
RESEARCH.mkdir(parents=True, exist_ok=True, mode=0o700)
ENVIRONMENT = dict(
    os.environ,
    UV_CACHE_DIR="/tmp/photointel-uv-cache",
    npm_config_cache="/tmp/photointel-npm-cache",
)


def command_stage(name: str, command: list[str], timeout: int = 1200) -> dict[str, Any]:
    started = time.monotonic()
    log = RESEARCH / f"{name}.log"
    try:
        with log.open("w") as handle:
            result = subprocess.run(
                command,
                cwd=ROOT,
                env=ENVIRONMENT,
                stdout=handle,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        status = "passed" if result.returncode == 0 else "failed"
        return {
            "stage": name,
            "status": status,
            "exit_code": result.returncode,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "log": str(log),
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "stage": name,
            "status": "failed",
            "error_type": type(error).__name__,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "log": str(log),
        }


def fetch(url: str, filename: str) -> dict[str, Any]:
    result: dict[str, Any] = {"url": url, "file": str(RESEARCH / filename)}
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": "PhotoIntel-reference/1"}
        )
        with urllib.request.urlopen(request, timeout=45) as response:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                return dict(result, status="failed", error_type="reference_too_large")
            (RESEARCH / filename).write_bytes(data)
            return dict(
                result, status="passed", http_status=response.status, bytes=len(data)
            )
    except urllib.error.HTTPError as error:
        return dict(result, status="failed", http_status=error.code)
    except (OSError, urllib.error.URLError) as error:
        return dict(result, status="failed", error_type=type(error).__name__)


def model_stage(model: str, label: str) -> list[dict[str, Any]]:
    metadata = fetch(
        f"https://huggingface.co/api/models/{model}", f"{label}-metadata.json"
    )
    results = [metadata]
    if metadata["status"] != "passed":
        return results
    payload = json.loads(Path(metadata["file"]).read_text())
    revision = payload.get("sha")
    if not isinstance(revision, str) or len(revision) != 40:
        return results + [
            {"stage": label, "status": "failed", "error_type": "missing_revision"}
        ]
    (RESEARCH / f"{label}-revision.txt").write_text(revision + "\n")
    available = {entry["rfilename"] for entry in payload.get("siblings", [])}
    for filename in (
        "config.json",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "README.md",
        "LICENSE",
        "LICENSE.txt",
        "top_tags.txt",
    ):
        if filename in available:
            results.append(
                fetch(
                    f"https://huggingface.co/{model}/resolve/{revision}/{filename}",
                    f"{label}-{filename.replace('/', '_')}",
                )
            )
    return results


def python_stage() -> list[dict[str, Any]]:
    uv = shutil.which("uv")
    if not uv:
        return [
            {"stage": "uv-sync", "status": "failed", "error_type": "uv_not_installed"}
        ]
    results = [command_stage("uv-sync", [uv, "sync", "--group", "ingest"])]
    if results[0]["status"] == "passed":
        help_result = command_stage(
            "icloudpd-help", [uv, "run", "--no-sync", "icloudpd", "--help"], timeout=60
        )
        results.append(help_result)
        if help_result["status"] == "passed":
            shutil.copy(RESEARCH / "icloudpd-help.log", RESEARCH / "icloudpd-help.txt")
        inspect_code = (
            "import importlib.metadata,json,pathlib,shutil; "
            "d=importlib.metadata.distribution('icloudpd'); "
            "p=pathlib.Path('/tmp/model-research'); "
            "(p/'icloudpd-installed.json').write_text("
            "json.dumps({'version':d.version})); "
            "files=[f for f in d.files if str(f).startswith('icloudpd/') "
            "and str(f).endswith('.py')]; "
            "[(p/'icloudpd-source'/str(f)).parent.mkdir(parents=True,exist_ok=True) "
            "or shutil.copy(d.locate_file(f),p/'icloudpd-source'/str(f)) for f in files]"
        )
        results.append(
            command_stage(
                "icloudpd-source",
                [uv, "run", "--no-sync", "python", "-c", inspect_code],
                timeout=60,
            )
        )
    return results


def node_stage() -> list[dict[str, Any]]:
    npm = shutil.which("npm")
    if not npm:
        return [
            {
                "stage": "npm-install",
                "status": "failed",
                "error_type": "npm_not_installed",
            }
        ]
    results = [command_stage("npm-install", [npm, "--prefix", "apps/web", "install"])]
    if results[0]["status"] == "passed":
        chromium = shutil.which("chromium") or shutil.which("chromium-browser")
        if chromium:
            results.append(command_stage("system-chromium", [chromium, "--version"]))
            (RESEARCH / "chromium-executable.txt").write_text(chromium + "\n")
        else:
            results.append(
                command_stage(
                    "playwright-chromium",
                    [
                        npm,
                        "exec",
                        "--prefix",
                        "apps/web",
                        "--",
                        "playwright",
                        "install",
                        "chromium",
                    ],
                )
            )
    return results


def docker_stage() -> list[dict[str, Any]]:
    # Check only the managed daemon, preserving registry/proxy configuration.
    docker = shutil.which("docker")
    if not docker:
        return [
            {
                "stage": "docker-info",
                "status": "failed",
                "error_type": "docker_not_installed",
            }
        ]
    check = command_stage(
        "docker-info",
        [
            "env",
            "-u",
            "DOCKER_HOST",
            "-u",
            "DOCKER_CONTEXT",
            "-u",
            "DOCKER_TLS",
            "-u",
            "DOCKER_TLS_VERIFY",
            "-u",
            "DOCKER_CERT_PATH",
            docker,
            "--host=unix:///var/run/docker.sock",
            "info",
            "--format",
            "{{.ServerVersion}}",
        ],
        timeout=30,
    )
    results = [check]
    if check["status"] == "passed":
        results.append(
            command_stage("setup-env", [sys.executable, "infra/scripts/setup-env.py"])
        )
        results.append(
            command_stage(
                "base-services",
                [
                    "bash",
                    "infra/scripts/compose.sh",
                    "up",
                    "-d",
                    "postgres",
                    "minio",
                    "bucket",
                    "permissions",
                ],
            )
        )
        if results[-1]["status"] == "passed":
            results.append(
                command_stage(
                    "base-services-status",
                    [
                        "bash",
                        "infra/scripts/compose.sh",
                        "ps",
                        "--format",
                        "json",
                    ],
                    timeout=30,
                )
            )
    return results


def reference_stage() -> list[dict[str, Any]]:
    references = [
        ("https://pypi.org/pypi/icloudpd/1.32.3/json", "icloudpd-1.32.3-pypi.json"),
        (
            "https://raw.githubusercontent.com/icloud-photos-downloader/"
            "icloud_photos_downloader/v1.32.3/README.md",
            "icloudpd-1.32.3-README.md",
        ),
        ("https://pyto.readthedocs.io/en/latest/", "pyto-index.html"),
        (
            "https://pyto.readthedocs.io/en/latest/objective_c.html",
            "pyto-objective-c.html",
        ),
        ("https://pyto.readthedocs.io/en/latest/keychain.html", "pyto-keychain.html"),
        (
            "https://rubicon-objc.readthedocs.io/en/latest/reference/",
            "rubicon-reference.html",
        ),
        (
            "https://huggingface.co/docs/transformers/model_doc/siglip2",
            "siglip2-transformers.html",
        ),
        ("https://modal.com/docs/reference/modal.asgi_app", "modal-asgi-app.html"),
        ("https://modal.com/docs/reference/modal.Cls", "modal-cls.html"),
    ]
    for item in (
        "phasset",
        "phphotolibrary",
        "phassetextendedmetadata",
        "phassetchangerequest",
    ):
        references.append(
            (
                "https://developer.apple.com/tutorials/data/documentation/"
                f"photos/{item}.json",
                f"apple-{item}.json",
            )
        )
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        return list(executor.map(lambda value: fetch(*value), references))


def main() -> int:
    started = datetime.now(UTC).isoformat()
    tasks = {
        "python": python_stage,
        "node": node_stage,
        "docker": docker_stage,
        "joytag": lambda: model_stage("fancyfeast/joytag", "joytag"),
        "siglip2": lambda: model_stage("google/siglip2-base-patch16-224", "siglip2"),
        "references": reference_stage,
    }
    results: dict[str, Any] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        futures = {executor.submit(task): name for name, task in tasks.items()}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                results[name] = future.result()
            except Exception as error:
                results[name] = [
                    {
                        "stage": name,
                        "status": "failed",
                        "error_type": type(error).__name__,
                    }
                ]
            passed = sum(item.get("status") == "passed" for item in results[name])
            print(f"{name}: {passed}/{len(results[name])} stages passed", flush=True)
            (RESEARCH / "bootstrap-report.json").write_text(
                json.dumps(
                    {
                        "started_at": started,
                        "updated_at": datetime.now(UTC).isoformat(),
                        "results": results,
                    },
                    indent=2,
                )
                + "\n"
            )
    required = [
        *results.get("python", []),
        *results.get("node", []),
        *results.get("docker", []),
    ]
    passed = required and all(item.get("status") == "passed" for item in required)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
