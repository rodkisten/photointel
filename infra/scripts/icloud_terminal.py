#!/usr/bin/env python3
"""Prepare and run interactive iCloud setup from an authenticated repository terminal."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SECRETS = frozenset({"DATABASE_URL", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY",
                             "ICLOUD_SESSION_KEY", "BRIDGE_TOKEN_PEPPER"})
REQUIRED = RUNTIME_SECRETS


class SetupError(RuntimeError):
    pass


def gcloud(arguments: list[str], project: str) -> str:
    result = subprocess.run(
        ["gcloud", *arguments, "--project", project, "--quiet"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise SetupError(
            "Sem acesso à configuração/secret do worker. No terminal, execute "
            "gcloud auth login --no-launch-browser com sua conta administradora e repita."
        )
    return result.stdout


def runtime_environment(project: str, region: str) -> dict[str, str]:
    document = json.loads(gcloud(
        ["run", "jobs", "describe", "photointel-worker", "--region", region,
         "--format=json"], project,
    ))
    container = document["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    environment: dict[str, str] = {}
    for entry in container.get("env", []):
        name = entry["name"]
        if "value" in entry:
            environment[name] = str(entry["value"])
        elif name in RUNTIME_SECRETS:
            ref = entry.get("valueFrom", {}).get("secretKeyRef", {})
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,254}", ref.get("name", "")):
                raise SetupError("Referência de secret inválida no worker")
            if not re.fullmatch(r"[1-9][0-9]*", ref.get("key", "")):
                raise SetupError("O worker precisa usar versões numéricas de secrets")
            environment[name] = gcloud(
                ["secrets", "versions", "access", ref["key"], "--secret", ref["name"]],
                project,
            ).strip()
    if any(not environment.get(key) for key in REQUIRED):
        raise SetupError("O worker não contém todas as referências necessárias à sessão")
    if environment.get("ICLOUD_SESSION_BACKEND") != "encrypted_object":
        raise SetupError("Configure ICLOUD_SESSION_BACKEND=encrypted_object no worker")
    environment.update(ICLOUD_ENABLED="false", GPU_ENABLED="false")
    # Use the terminal's trust store, not a container-specific path on another OS.
    ca_file = ssl.get_default_verify_paths().cafile
    if ca_file and Path(ca_file).is_file():
        environment["DATABASE_TLS_CA_FILE"] = ca_file
    elif not Path(environment.get("DATABASE_TLS_CA_FILE", "")).is_file():
        environment.pop("DATABASE_TLS_CA_FILE", None)
    return environment


def uv_command() -> str:
    installed = shutil.which("uv")
    if installed:
        return installed
    directory = Path.home() / ".cache" / "photointel" / "setup-tools"
    binary_directory = directory / ("Scripts" if os.name == "nt" else "bin")
    executable = binary_directory / ("uv.exe" if os.name == "nt" else "uv")
    if not executable.is_file():
        venv.EnvBuilder(with_pip=True).create(directory)
        python = binary_directory / ("python.exe" if os.name == "nt" else "python")
        subprocess.run([str(python), "-m", "pip", "install", "uv==0.12.23"], check=True)
    return str(executable)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "setup", "verify", "status", "test"))
    parser.add_argument("--account")
    parser.add_argument("--library")
    parser.add_argument("--project", default="photointel")
    parser.add_argument("--region", default="us-central1")
    arguments = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", arguments.project):
        parser.error("Projeto inválido")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", arguments.region):
        parser.error("Região inválida")
    if arguments.account and not re.fullmatch(r"[^\s@]+@[^\s@]+", arguments.account):
        parser.error("Informe um e-mail Apple válido")
    if arguments.action == "setup" and not sys.stdin.isatty():
        parser.error("Abra um terminal SSH/Codespaces; Actions não recebe senha/2FA")
    if not shutil.which("gcloud"):
        parser.error("Use um terminal com gcloud instalado, como a VM PhotoIntel")
    try:
        # Install only code first; credentials are fetched afterwards and never
        # exposed to dependency installation, command arguments or files.
        uv = uv_command()
        installer_environment = dict(os.environ, UV_CONCURRENT_BUILDS="1",
                                     UV_CONCURRENT_DOWNLOADS="2",
                                     UV_CONCURRENT_INSTALLS="1", UV_COMPILE_BYTECODE="0")
        subprocess.run(
            [uv, "sync", "--frozen", "--no-dev", "--group", "ingest",
             "--no-compile-bytecode"],
            cwd=ROOT, env=installer_environment, check=True,
        )
        runtime = runtime_environment(arguments.project, arguments.region)
        if arguments.action == "prepare":
            print("Dependências e referências prontas. Nenhum login Apple iniciado.")
            return 0
        # Secret values exist only in this process and the operation child.
        child_environment = dict(os.environ, **runtime)
        with tempfile.TemporaryDirectory(prefix="photointel-icloud-report-") as temporary:
            report = Path(temporary) / "result.json"
            operation = ["setup" if arguments.action == "setup" else arguments.action,
                         "--result-file", str(report)]
            if arguments.account:
                operation += ["--account", arguments.account]
            if arguments.library:
                operation += ["--library", arguments.library]
            # Catch import/config validation errors too: Pydantic tracebacks can
            # otherwise include credentials before the CLI's main() is reached.
            bootstrap = (
                "import runpy,sys\n"
                "try:\n"
                " runpy.run_module('photointel.services.icloud_admin',run_name='__main__')\n"
                "except Exception as e:\n"
                " print('Setup indisponível: '+type(e).__name__);sys.exit(1)\n"
            )
            result = subprocess.run(
                [uv, "run", "--no-sync", "python", "-c", bootstrap, *operation],
                cwd=ROOT, env=child_environment, check=False,
            )
            if result.returncode:
                return result.returncode
            if arguments.action == "setup":
                evidence = json.loads(report.read_text(encoding="utf-8"))
                if not evidence.get("session_published"):
                    raise SetupError("Login local não comprova publicação no Cloud Run")
                print("Sessão publicada e relida. Nenhuma ingestão ou GPU iniciada.")
        return 0
    except SetupError as exc:
        print(str(exc), file=sys.stderr)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print("Preparação não concluída: " + type(exc).__name__, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
