#!/usr/bin/env python3
"""Sincroniza o Modal do .env com GCP Secret Manager e GitHub Actions.

Uso (na raiz do repositório photointel):
    python3 gpu.py --repair-env
    python3 gpu.py --dry-run
    python3 gpu.py
    python3 gpu.py --enable-gpu --deploy

Se GCP_CONFIG_ENV não existir localmente, baixa via gh e salva em
.env.gcp-config-env (0600). Mantém cache sincronizado com a fonte de verdade.
Localiza gh/gcloud fora do PATH ou instala via repositórios apt oficiais em
Debian/Ubuntu, quando ausentes
e houver privilégios root ou sudo não interativo. Não autentica, habilita APIs,
altera billing ou inicia um deploy sem --deploy.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Sequence
from urllib.parse import urlsplit

REPO = "rodkisten/photointel"
PROJECT = "photointel"
ENVIRONMENT = "production"
ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
CONFIG_CACHE = ROOT / ".env.gcp-config-env"  # Guardado no gitignore (.env.*)

# Somente as seis entradas realmente exigidas pela integração.
REQUIRED = (
    "MODAL_ENDPOINT",
    "MODAL_TOKEN",
    "MODAL_PROXY_KEY",
    "MODAL_PROXY_SECRET",
    "JOYTAG_MODEL_REVISION",
    "SIGLIP_MODEL_REVISION",
)
SECRET_NAMES = ("MODAL_TOKEN", "MODAL_PROXY_KEY", "MODAL_PROXY_SECRET")
SHA40 = re.compile(r"[0-9a-fA-F]{40}\Z")
ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$")


class SetupError(RuntimeError):
    pass


def exec_cmd(args: Sequence[str], *, stdin: str | None = None,
             allow_error: bool = False, timeout: int = 300,
             clean_github_auth: bool = False) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if clean_github_auth:
        # Tokens injected by Codespaces override the user's saved gh login.
        env.pop("GH_TOKEN", None)
        env.pop("GITHUB_TOKEN", None)
    env.update({
        "CLOUDSDK_CORE_DISABLE_PROMPTS": "1",
        "GH_PROMPT_DISABLED": "1",
        "GIT_TERMINAL_PROMPT": "0",
    })
    env.pop("GH_DEBUG", None)
    env.pop("GIT_TRACE", None)
    result = subprocess.run(
        list(args), input=stdin, text=True, capture_output=True,
        timeout=timeout, env=env, check=False,
    )
    if result.returncode and not allow_error:
        # Não mostramos os argumentos nem stdout: alguns carregam credenciais.
        raise SetupError(f"Falhou {Path(args[0]).name}. Confira autenticação, permissões e configurações.")
    return result


def privileged() -> list[str]:
    if os.geteuid() == 0:
        return []
    if shutil.which("sudo") and subprocess.run(
        ["sudo", "-n", "true"], capture_output=True, check=False,
    ).returncode == 0:
        return ["sudo", "-n"]
    raise SetupError(
        "CLI ausente e sem sudo não interativo. Instale manualmente gh/gcloud "
        "ou habilite sudo no Codespaces."
    )


def admin_cmd(prefix: Sequence[str], args: Sequence[str], *, stdin: str | None = None) -> None:
    command = [*prefix, *args]
    result = exec_cmd(command, stdin=stdin, allow_error=True, timeout=900)
    if result.returncode:
        raise SetupError(
            "Instalação da CLI falhou; confira permissões, repositórios APT e rede."
        )


def install_cli(program: str) -> None:
    if sys.platform != "linux" or not shutil.which("apt-get"):
        raise SetupError(f"{program} ausente: instalação automática disponível apenas em Debian/Ubuntu.")
    sudo = privileged()
    print(f"📦 {program} ausente. Instalando silenciosamente via APT oficial...", flush=True)
    base = [*sudo, "env", "DEBIAN_FRONTEND=noninteractive"]
    apt = [*base, "apt-get", "-o", "Dpkg::Use-Pty=0"]
    admin_cmd(sudo, ["mkdir", "-p", "/etc/apt/keyrings", "/usr/share/keyrings", "/etc/apt/sources.list.d"])
    admin_cmd(apt, ["update", "-qq"])
    admin_cmd(apt, ["install", "-y", "-qq", "ca-certificates", "gnupg", "curl"])

    if program == "gh":
        url = "https://cli.github.com/packages/githubcli-archive-keyring.gpg"
        key_target = "/etc/apt/keyrings/githubcli-archive-keyring.gpg"
        repo_target = "/etc/apt/sources.list.d/github-cli.list"
        arch = exec_cmd(["dpkg", "--print-architecture"]).stdout.strip()
        repo_line = (
            f"deb [arch={arch} signed-by={key_target}] "
            "https://cli.github.com/packages stable main\n"
        )
    elif program == "gcloud":
        url = "https://packages.cloud.google.com/apt/doc/apt-key.gpg"
        key_target = "/usr/share/keyrings/cloud.google.gpg"
        repo_target = "/etc/apt/sources.list.d/google-cloud-sdk.list"
        repo_line = (
            f"deb [signed-by={key_target}] "
            "https://packages.cloud.google.com/apt cloud-sdk main\n"
        )
    else:
        raise SetupError(f"Instalador desconhecido: {program}")

    with urllib.request.urlopen(url, timeout=40) as response:
        key_bytes = response.read(512 * 1024 + 1)
    if len(key_bytes) > 512 * 1024:
        raise SetupError("Chave APT inesperadamente grande")
    if program == "gcloud":
        decoded = subprocess.run(
            ["gpg", "--batch", "--yes", "--dearmor"],
            input=key_bytes, capture_output=True, check=False,
        )
        if decoded.returncode:
            raise SetupError("Não foi possível validar/decodificar a chave APT do Google")
        key_bytes = decoded.stdout
    # Para chaves binárias, passe bytes sem convertê-los para texto.
    process = subprocess.run(
        [*sudo, "tee", key_target], input=key_bytes, capture_output=True, timeout=60,
    )
    if process.returncode:
        raise SetupError("Não foi possível instalar a chave APT")
    admin_cmd(sudo, ["chmod", "a+r", key_target])
    admin_cmd(sudo, ["tee", repo_target], stdin=repo_line)
    admin_cmd(apt, ["update", "-qq"])
    admin_cmd(apt, ["install", "-y", "-qq", "gh" if program == "gh" else "google-cloud-cli"])
    if not shutil.which(program):
        raise SetupError(f"{program} instalado, mas ainda fora do PATH. Abra outro terminal.")
    print(f"✅ {program} instalado", flush=True)


def ensure_cli(program: str) -> None:
    """Localiza CLIs instaladas fora do PATH e instala quando necessário.

    Somente diretórios de executáveis são adicionados ao PATH; nunca valores
    de variáveis, tokens ou conteúdos do GCP_CONFIG_ENV.
    """
    if shutil.which(program):
        return
    for directory in (
        "/usr/local/bin",
        "/usr/bin",
        "/opt/homebrew/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        str(Path.home() / "google-cloud-sdk/bin"),
        "/opt/google-cloud-sdk/bin",
    ):
        executable = Path(directory) / program
        if executable.is_file() and os.access(executable, os.X_OK):
            os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
            print(f"✅ {program} localizado e incluído no PATH: {directory}")
            return
    install_cli(program)


def run_gcloud(args: Sequence[str], *, stdin: str | None = None,
               allow_error: bool = False) -> subprocess.CompletedProcess[str]:
    """Executa `gcloud <args> --project=photointel --quiet` com instalação sob demanda."""
    ensure_cli("gcloud")
    return exec_cmd(
        ["gcloud", *args, f"--project={PROJECT}", "--quiet"],
        stdin=stdin, allow_error=allow_error,
    )


def run_gh(args: Sequence[str], *, stdin: str | None = None,
           allow_error: bool = False) -> subprocess.CompletedProcess[str]:
    """Execute gh, retrying saved user auth if Codespaces integration is denied."""
    ensure_cli("gh")
    command = ["gh", *args]
    result = exec_cmd(command, stdin=stdin, allow_error=True)
    denied = (
        result.returncode != 0
        and ("resource not accessible by integration" in result.stderr.casefold()
             or "http 403" in result.stderr.casefold())
    )
    if denied and args and args[0] in {"variable", "workflow"}:
        # Only retry a denied request; never prompt, print tokens or change login.
        personal = exec_cmd(
            command, stdin=stdin, allow_error=True, clean_github_auth=True,
        )
        if personal.returncode == 0:
            return personal
    if result.returncode and not allow_error:
        if denied:
            raise SetupError(
                "GitHub Codespaces token lacks permission for the production Environment. "
                "Authenticate personally with: "
                "env -u GH_TOKEN -u GITHUB_TOKEN gh auth login -h github.com --web -s repo"
            )
        raise SetupError("Falha ao executar gh. Confira autenticação e permissões.")
    return result


def verified_model_revisions() -> dict[str, str]:
    """Read immutable revisions already checked by gpu.checkpoints (no network or GPU)."""
    report = ROOT / "reports/model-evidence.json"
    if not report.is_file() or report.is_symlink():
        raise SetupError(
            "Relatório de modelos ausente. Execute "
            "'uv run python -m gpu.checkpoints' e tente novamente."
        )
    try:
        data = json.loads(report.read_text(encoding="utf-8"))
        models = data["models"]
        mapping: dict[str, str] = {}
        expected = {
            "fancyfeast/joytag": "JOYTAG_MODEL_REVISION",
            "google/siglip2-base-patch16-224": "SIGLIP_MODEL_REVISION",
        }
        for item in models:
            model_id = item.get("model_id")
            if model_id in expected:
                key = expected[model_id]
                revision = item.get("revision")
                if key in mapping or not isinstance(revision, str) or not SHA40.fullmatch(revision):
                    raise ValueError("Duplicate model ID or invalid immutable revision")
                mapping[key] = revision
        if set(mapping) != set(expected.values()):
            raise ValueError("Missing expected model revisions")
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        raise SetupError("Relatório de modelos inválido; execute novamente 'uv run python -m gpu.checkpoints'") from exc
    return mapping


def repair_model_revisions() -> None:
    """Repair invalid/missing SHA fields only; keep all other .env values unchanged."""
    import tempfile

    if not ENV_PATH.is_file() or ENV_PATH.is_symlink():
        raise SetupError(".env não encontrado ou não é um arquivo local regular")
    revisions = verified_model_revisions()
    original = ENV_PATH.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)
    output: list[str] = []
    seen: set[str] = set()
    repaired: list[str] = []

    for line in lines:
        match = ENV_ASSIGNMENT.fullmatch(line.rstrip("\r\n"))
        if not match or match.group(1) not in revisions:
            output.append(line)
            continue
        key, value = match.groups()
        if key in seen:
            raise SetupError(f".env contém a variável duplicada: {key}")
        seen.add(key)
        current = value.strip().strip(chr(39) + chr(34))
        if SHA40.fullmatch(current):
            output.append(line)
            continue
        output.append(f"{key}={revisions[key]}\n")
        repaired.append(key)

    for key, revision in revisions.items():
        if key not in seen:
            output.append(f"{key}={revision}\n")
            repaired.append(key)
    if not repaired:
        print("✅ Revisões dos modelos já são SHAs válidos; .env preservado.")
        return

    os.umask(0o077)
    backup = ROOT / f".env.backup-model-revisions-{dt.datetime.now(dt.UTC):%Y%m%d-%H%M%S%f}"
    backup_fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(backup_fd, "w", encoding="utf-8") as file:
        file.write(original)
    fd, temporary = tempfile.mkstemp(prefix=".env.models-", dir=ROOT)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.writelines(output)
        os.replace(temporary, ENV_PATH)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print("✅ Revisões corrigidas a partir de reports/model-evidence.json: " + ", ".join(repaired))
    print(f"🔐 Backup privado: {backup.name}")
    print("ℹ️ Outras variáveis e tokens foram preservados. Nenhum deploy iniciado.")


def read_env() -> dict[str, str]:
    if not ENV_PATH.is_file():
        raise SetupError(f"Não encontrei {ENV_PATH}. Execute na raiz do photointel.")
    result: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        match = ENV_ASSIGNMENT.fullmatch(line)
        if not match:
            continue
        key, value = match.groups()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        result[key] = value
    missing = [key for key in REQUIRED if not result.get(key)]
    if missing:
        raise SetupError(".env sem: " + ", ".join(missing))
    parsed = urlsplit(result["MODAL_ENDPOINT"])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise SetupError("MODAL_ENDPOINT precisa ser uma URL HTTPS válida")
    if not result["MODAL_PROXY_KEY"].startswith("wk-"):
        raise SetupError("MODAL_PROXY_KEY deve começar com wk-")
    if not result["MODAL_PROXY_SECRET"].startswith("ws-"):
        raise SetupError("MODAL_PROXY_SECRET deve começar com ws-")
    if len(result["MODAL_TOKEN"]) < 32:
        raise SetupError("MODAL_TOKEN tem menos de 32 caracteres")
    for key in ("JOYTAG_MODEL_REVISION", "SIGLIP_MODEL_REVISION"):
        if not SHA40.fullmatch(result[key]):
            raise SetupError(f"{key} deve conter SHA hexadecimal de 40 caracteres")
    return result


def parse_config(raw: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = ENV_ASSIGNMENT.fullmatch(line)
        if not match:
            raise SetupError("GCP_CONFIG_ENV contém linha inválida; preserve e corrija antes de continuar")
        key, value = match.groups()
        if key in result:
            raise SetupError(f"GCP_CONFIG_ENV contém variável duplicada: {key}")
        result[key] = value.strip()
    if result.get("PROJECT_ID") != PROJECT:
        raise SetupError("GCP_CONFIG_ENV não aponta para o projeto photointel")
    return result


def write_private(path: Path, content: str) -> None:
    """Grava atomica e privadamente, sem exibir o conteúdo no terminal."""
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".gcp-config-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def get_github_config(*, dry_run: bool) -> str:
    """Obtém GCP_CONFIG_ENV via gh e coloca arquivo local sob caminho estável.

    O GitHub é a fonte de verdade. Mesmo que haja cache local, recupera a versão
    atual antes da escrita remota para evitar aplicar sobre configuração antiga.
    """
    base = ["-R", REPO, "-e", ENVIRONMENT]
    result = run_gh([
        "variable", "get", "GCP_CONFIG_ENV", *base,
        "--json", "value", "--jq", ".value",
    ], allow_error=True)
    if result.returncode:
        if ("resource not accessible by integration" in result.stderr.casefold()
                or "http 403" in result.stderr.casefold()):
            raise SetupError(
                "HTTP 403: token automático do Codespaces não tem acesso à variável "
                "GCP_CONFIG_ENV do GitHub Environment production. Execute "
                "'env -u GH_TOKEN -u GITHUB_TOKEN gh auth login -h github.com --web -s repo' "
                "e tente novamente. Para token fine-grained, habilite Environments: read "
                "(write também é necessário para o deploy)."
            )
        raise SetupError(
            "GCP_CONFIG_ENV não pôde ser lida via gh. Verifique a autenticação pessoal, "
            "a existência da variável no ambiente production e suas permissões. "
            "Nenhuma configuração remota foi modificada."
        )
    raw = result.stdout.rstrip("\n") + "\n"
    if not raw.strip():
        raise SetupError("GCP_CONFIG_ENV existe, mas está vazia no GitHub")
    parse_config(raw)
    cached = CONFIG_CACHE.read_text(encoding="utf-8") if CONFIG_CACHE.is_file() else None
    if cached != raw:
        if not dry_run:
            write_private(CONFIG_CACHE, raw)
            print(f"✅ GCP_CONFIG_ENV obtida via gh e salva em {CONFIG_CACHE}")
        else:
            print(f"🔎 GCP_CONFIG_ENV disponível no GitHub (cache seria salvo em {CONFIG_CACHE})")
    else:
        print(f"✅ GCP_CONFIG_ENV local já atualizada em {CONFIG_CACHE}")
    # Caminho de arquivo, não PATH (que é reservado para executáveis).
    os.environ["GCP_CONFIG_ENV_PATH"] = str(CONFIG_CACHE)
    os.environ["GCP_CONFIG_ENV"] = raw
    return raw


def patch_config(raw: str, patch: dict[str, str]) -> str:
    updated: list[str] = []
    done: set[str] = set()
    for line in raw.splitlines():
        match = ENV_ASSIGNMENT.fullmatch(line)
        if match and match.group(1) in patch:
            key = match.group(1)
            updated.append(f"{key}={patch[key]}")
            done.add(key)
        else:
            updated.append(line)
    updated.extend(f"{key}={value}" for key, value in patch.items() if key not in done)
    return "\n".join(updated).rstrip() + "\n"


def secret_exists(name: str) -> bool:
    result = run_gcloud(["secrets", "describe", name, "--format=json"], allow_error=True)
    if result.returncode == 0:
        return True
    message = result.stderr.lower()
    if any(part in message for part in ("not_found", "not found", "404")):
        return False
    raise SetupError(f"Não foi possível consultar Secret Manager ({name}); confira IAM e autenticação")


def sync_secret(key: str, value: str, name: str, *, dry_run: bool) -> str | None:
    exists = secret_exists(name)
    if dry_run:
        print(f"  • {key}: {'nova versão' if exists else 'criar Secret e versão'}")
        return None
    if not exists:
        run_gcloud(["secrets", "create", name, "--replication-policy=automatic", "--format=none"])
    for service in ("photointel-api", "photointel-jobs"):
        run_gcloud([
            "secrets", "add-iam-policy-binding", name,
            "--member", f"serviceAccount:{service}@{PROJECT}.iam.gserviceaccount.com",
            "--role", "roles/secretmanager.secretAccessor", "--format=none",
        ])
    # Uma nova versão preserva a anterior e permite rollback. O valor vai por stdin.
    result = run_gcloud(
        ["secrets", "versions", "add", name, "--data-file=-", "--format=json"],
        stdin=value,
    )
    try:
        version = str(json.loads(result.stdout)["name"]).rsplit("/", 1)[-1]
    except (KeyError, TypeError, ValueError) as exc:
        raise SetupError(f"Resposta de versão inesperada do Secret Manager: {name}") from exc
    if not version.isdigit():
        raise SetupError(f"Versão não numérica retornada para {name}")
    print(f"✅ {key} sincronizado (versão {version})")
    return version


def main() -> None:
    parser = argparse.ArgumentParser(description="Sincronizar Modal → GCP / GitHub Actions")
    parser.add_argument("--dry-run", action="store_true", help="Validar sem modificar GCP/GitHub")
    parser.add_argument("--repair-env", action="store_true", help="Reparar somente SHAs inválidos no .env usando o relatório local, sem deploy")
    parser.add_argument("--enable-gpu", action="store_true", help="Configurar GPU_ENABLED=true")
    parser.add_argument("--deploy", action="store_true", help="Disparar release manual do Cloud Run")
    args = parser.parse_args()
    if args.dry_run and args.deploy:
        parser.error("--dry-run não pode ser combinado com --deploy")
    if args.repair_env:
        if args.dry_run or args.deploy or args.enable_gpu:
            parser.error("--repair-env deve ser usado sozinho")
        repair_model_revisions()
        return

    data = read_env()
    ensure_cli("gh")
    ensure_cli("gcloud")
    # A autenticação nunca é criada automaticamente: depende do operador.
    if run_gh(["auth", "status"], allow_error=True).returncode:
        raise SetupError("GitHub CLI sem login; execute: gh auth login")
    active = run_gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])
    if not active.stdout.strip():
        raise SetupError("gcloud sem conta ativa; execute: gcloud auth login --no-launch-browser")

    base_args = ["-R", REPO, "-e", ENVIRONMENT]
    original = get_github_config(dry_run=args.dry_run)
    existing = parse_config(original)

    patch = {
        "ENABLE_GPU": "json:true" if args.enable_gpu else "json:false",
        "EXTRA_ENVIRONMENT__MODAL_ENDPOINT": data["MODAL_ENDPOINT"],
        "EXTRA_ENVIRONMENT__JOYTAG_MODEL_REVISION": data["JOYTAG_MODEL_REVISION"],
        "EXTRA_ENVIRONMENT__SIGLIP_MODEL_REVISION": data["SIGLIP_MODEL_REVISION"],
        "EXTRA_ENVIRONMENT__MAX_GPU_CONCURRENCY": "1",
        "EXTRA_ENVIRONMENT__BATCH_SIZE": "1",
        "EXTRA_ENVIRONMENT__GPU_MAX_ASSETS_PER_RUN": "1",
        "EXTRA_ENVIRONMENT__GPU_MAX_COST_PER_RUN": "1",
        "EXTRA_ENVIRONMENT__GPU_DAILY_BUDGET": "2",
        "EXTRA_ENVIRONMENT__GPU_MONTHLY_BUDGET": "10",
    }
    print(f"🔎 Projeto: {PROJECT} / GitHub: {REPO} / ambiente: {ENVIRONMENT}")
    print(f"📁 Configuração local: {CONFIG_CACHE}")
    for key in SECRET_NAMES:
        name_key = f"SECRETS__{key}__NAME"
        name = existing.get(name_key, f"photointel-{key.lower().replace('_', '-')}")
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,254}", name):
            raise SetupError(f"Nome de Secret Manager inválido: {key}")
        version = sync_secret(key, data[key], name, dry_run=args.dry_run)
        patch[name_key] = name
        if version is not None:
            patch[f"SECRETS__{key}__VERSION"] = version
    if args.dry_run:
        print("✅ Prévia concluída: nenhum secret/configuração alterado")
        return

    # Backup local protegido contra `git add`; .env.* já está no .gitignore.
    timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%d-%H%M%S")
    backup = ROOT / f".env.gcp-config-backup.{timestamp}"
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as target:
        target.write(original.rstrip() + "\n")
    print(f"🔐 Backup de GCP_CONFIG_ENV: {backup.name}")

    updated = patch_config(original, patch)
    run_gh(["variable", "set", "GCP_CONFIG_ENV", *base_args], stdin=updated)
    write_private(CONFIG_CACHE, updated)
    os.environ["GCP_CONFIG_ENV"] = updated
    print(f"✅ GCP_CONFIG_ENV atualizado no GitHub e em {CONFIG_CACHE}")
    print("⛔ GPU configurada como " + ("ATIVA" if args.enable_gpu else "DESATIVADA"))
    if args.deploy:
        run_gh(["workflow", "run", "gcp-deploy.yml", "-R", REPO,
                "-r", "main", "-f", "action=release"])
        print("🚀 Release solicitado. Acompanhe em GitHub Actions; não significa deploy concluído.")
    else:
        print("ℹ️ Nenhum deploy iniciado. Para publicar, use --deploy quando estiver pronto.")


if __name__ == "__main__":
    try:
        main()
    except (SetupError, subprocess.TimeoutExpired, OSError) as exc:
        print(f"❌ {exc}", file=sys.stderr)
        raise SystemExit(1) from None