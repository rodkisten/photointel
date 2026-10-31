#!/usr/bin/env python3
"""Prepare and run interactive iCloud setup from an authenticated repository terminal."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SECRETS = frozenset({"DATABASE_URL", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY",
                             "ICLOUD_SESSION_KEY", "BRIDGE_TOKEN_PEPPER"})
REQUIRED = RUNTIME_SECRETS
CLOUD_CLI = "gcloud"
SDK_VERSION = "591.0.0"
SDK_ARCHIVES = {
    "x86_64": ("x86_64", "8b8c1be16284f7072359de05d31fe5ce52b6052fb295404a62a54b7d03ec4326"),
    "aarch64": ("arm", "c134c741f7232131e2556d77991bc8eaeb70054cfad426e06c533b3586ab69e6"),
}


def _known_sdk_binaries() -> tuple[Path, ...]:
    """Locations used by the official Cloud SDK image and prior installs."""
    return (
        Path("/usr/lib/google-cloud-sdk/bin/gcloud"),
        Path("/opt/google-cloud-sdk/bin/gcloud"),
        Path.home() / "google-cloud-sdk" / "bin" / "gcloud",
        Path.home() / ".cache" / "photointel" / ("gcloud-" + SDK_VERSION)
        / "google-cloud-sdk" / "bin" / "gcloud",
    )


def ensure_gcloud() -> str:
    installed = shutil.which("gcloud")
    if installed:
        return installed
    # A login shell may reset PATH even though the official image has gcloud.
    # Reuse a working installation before attempting any network download.
    for binary in _known_sdk_binaries():
        if binary.is_file() and os.access(binary, os.X_OK):
            probe = subprocess.run([str(binary), "--version"], capture_output=True,
                                   check=False, timeout=20)
            if probe.returncode == 0:
                return str(binary)
    if platform.system() != "Linux" or platform.machine() not in SDK_ARCHIVES:
        raise SetupError("Instale gcloud neste sistema antes de executar o setup")
    cache = Path.home() / ".cache" / "photointel"
    package = cache / ("gcloud-" + SDK_VERSION)
    binary = package / "google-cloud-sdk" / "bin" / "gcloud"
    if binary.is_file():
        return str(binary)
    if package.exists():
        raise SetupError("Instalação gcloud incompleta no cache PhotoIntel")
    arch, expected_hash = SDK_ARCHIVES[platform.machine()]
    url = ("https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/"
           f"google-cloud-cli-linux-{arch}.tar.gz")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gcloud-install-", dir=cache) as temporary:
        directory = Path(temporary)
        archive = directory / "sdk.tar.gz"
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(url, timeout=60) as source, archive.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > 128 * 1024 * 1024:
                    raise SetupError("Pacote gcloud excedeu o limite esperado")
                digest.update(chunk)
                target.write(chunk)
        if digest.hexdigest() != expected_hash:
            raise SetupError("Checksum do pacote oficial gcloud não confere")
        with tarfile.open(archive) as sdk:
            sdk.extractall(directory / "unpacked", filter="data")
        (directory / "unpacked").rename(package)
    subprocess.run([str(binary), "--version"], capture_output=True, check=True)
    return str(binary)


def ensure_user_login(project: str, *, interactive: bool) -> None:
    active = gcloud(["auth", "list", "--filter=status:ACTIVE",
                     "--format=value(account)"], project).strip()
    if active and not active.endswith(".gserviceaccount.com"):
        return
    if not interactive or not sys.stdin.isatty():
        raise SetupError("Abra o setup em um terminal para entrar na sua conta Google")
    print("Primeiro uso: entre na sua conta Google com acesso ao projeto PhotoIntel.")
    subprocess.run([CLOUD_CLI, "auth", "login", "--no-launch-browser"], check=True)


class SetupError(RuntimeError):
    pass


def gcloud(arguments: list[str], project: str) -> str:
    result = subprocess.run(
        [CLOUD_CLI, *arguments, "--project", project, "--quiet"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise SetupError(
            "Sem acesso à configuração/secret do worker. No terminal, execute "
            f"{CLOUD_CLI} auth login --no-launch-browser e repita com sua conta administradora."
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
    global CLOUD_CLI
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
    try:
        CLOUD_CLI = ensure_gcloud()
        ensure_user_login(arguments.project, interactive=arguments.action == "setup")
        # Install only code first; credentials are fetched afterwards and never
        # exposed to dependency installation, command arguments or files.
        uv = uv_command()
        installer_environment = dict(os.environ, UV_CONCURRENT_BUILDS="1",
                                     UV_CONCURRENT_DOWNLOADS="2",
                                     UV_CONCURRENT_INSTALLS="1")
        # UV_COMPILE_BYTECODE acts like --compile-bytecode, even when it is
        # present with the value "0". Avoid conflicting positive/negative
        # flags: uv already disables compilation by default.
        installer_environment.pop("UV_COMPILE_BYTECODE", None)
        subprocess.run(
            [uv, "sync", "--frozen", "--no-dev", "--group", "ingest"],
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
