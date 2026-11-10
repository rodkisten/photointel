#!/usr/bin/env python3
"""Create a private development configuration without overwriting user values."""

import argparse
import base64
import json
import os
import re
import secrets
import tempfile
import sys
from urllib.parse import urlsplit
from pathlib import Path


def codespaces_settings() -> dict[str, str]:
    if os.environ.get("CODESPACES") != "true":
        return {}
    name = os.environ.get("CODESPACE_NAME", "")
    domain = os.environ.get("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev")
    host = f"{name}-5173.{domain}"
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if not re.fullmatch(label, name) or len(host) > 253 or any(
        not re.fullmatch(label, part) for part in host.split(".")
    ):
        raise SystemExit("Variáveis de hostname do Codespaces inválidas.")
    origin = f"https://{host}"
    return {
        "FRONTEND_ORIGIN": origin,
        "API_ORIGIN": origin,
        "CORS_ORIGINS": json.dumps([origin]),
    }


def replace_settings(contents: str, replacements: dict[str, str]) -> str:
    lines = []
    remaining = dict(replacements)
    for line in contents.splitlines():
        key = line.partition("=")[0]
        lines.append(f"{key}={replacements[key]}" if key in replacements else line)
        remaining.pop(key, None)
    lines.extend(f"{key}={value}" for key, value in remaining.items())
    return "\n".join(lines) + "\n"


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--codespaces-origin", action="store_true")
parser.add_argument(
    "--force-github", action="store_true",
    help="Fetch current production GCP_CONFIG_ENV from GitHub and refresh non-secret GPU settings",
)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
target = root / ".env"
origins = codespaces_settings()
if args.codespaces_origin and not origins:
    raise SystemExit("A atualização de origem exige uma sessão Codespaces.")
if target.exists():
    if args.codespaces_origin:
        if target.is_symlink():
            raise SystemExit("O arquivo .env deve ser um arquivo local, sem symlink.")
        contents = replace_settings(target.read_text(), origins)
        with tempfile.NamedTemporaryFile(
            mode="w", dir=root, prefix=".env.origin-", delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(contents)
        try:
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        print("Origens Codespaces atualizadas; demais configurações preservadas.")
    else:
        print(".env existente preservado; revise valores com .env.example.")
else:
    password = secrets.token_hex(24)
    storage_password = secrets.token_hex(24)
    app_password = secrets.token_hex(24)
    contents = (root / ".env.example").read_text()
    replacements = {
        "POSTGRES_PASSWORD": password,
        "POSTGRES_APP_PASSWORD": app_password,
        "APP_DATABASE_URL": (
            f"postgresql+asyncpg://photointel_app:{app_password}@postgres:5432/photointel"
        ),
        "DATABASE_URL": (
            f"postgresql+asyncpg://photointel:{password}@localhost:5432/photointel"
        ),
        "MINIO_ROOT_PASSWORD": storage_password,
        "STORAGE_SECRET_KEY": storage_password,
        "BRIDGE_ENROLLMENT_SECRET": secrets.token_hex(32),
        "BRIDGE_TOKEN_PEPPER": secrets.token_hex(32),
        "ICLOUD_SESSION_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
    }
    replacements.update(origins)
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(replace_settings(contents, replacements))
    print(".env local criado com modo 0600 e credenciais aleatórias.")
    if origins:
        print("Origem HTTPS do Codespaces configurada; mantenha as portas privadas.")
if args.force_github:
    # Reuse the GPU CLI transport (installs/locates gh and reads the production
    # environment variable, without running deploy, billing or GCP mutations).
    sys.path.insert(0, str(root))
    from gpu import SetupError, get_github_config, parse_config

    try:
        github_raw = get_github_config(dry_run=False)
        github_values = parse_config(github_raw)
    except SetupError as exc:
        raise SystemExit(f"[setup] GitHub config unavailable: {exc}") from None

    # Only public inference fields can be copied into the local dev .env.
    # GCP_CONFIG_ENV holds Secret Manager names/versions, not secret values.
    remote = {
        key: github_values.get(f"EXTRA_ENVIRONMENT__{key}", "")
        for key in ("MODAL_ENDPOINT", "JOYTAG_MODEL_REVISION", "SIGLIP_MODEL_REVISION")
    }
    replacements = {key: value for key, value in remote.items() if value}
    if "MODAL_ENDPOINT" in replacements:
        parsed = urlsplit(replacements["MODAL_ENDPOINT"])
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
        ):
            raise SystemExit("[setup] Invalid Modal endpoint in GCP_CONFIG_ENV")
    for key in ("JOYTAG_MODEL_REVISION", "SIGLIP_MODEL_REVISION"):
        if key in replacements and not re.fullmatch(r"[0-9a-fA-F]{40}", replacements[key]):
            raise SystemExit(f"[setup] Invalid 40-character model SHA: {key}")
    if target.is_symlink():
        raise SystemExit("[setup] Refusing to update a symlinked .env")
    if replacements:
        original = target.read_text(encoding="utf-8")
        updated = replace_settings(original, replacements)
        if updated != original:
            import datetime as dt

            backup = root / f".env.backup-github-{dt.datetime.now(dt.UTC):%Y%m%d-%H%M%S%f}"
            backup_fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(backup_fd, "w", encoding="utf-8") as stream:
                stream.write(original)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=root,
                prefix=".env.github-", delete=False,
            ) as handle:
                temporary = Path(handle.name)
                handle.write(updated)
            try:
                os.chmod(temporary, 0o600)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            print("[setup] GitHub synchronized public fields: " + ", ".join(sorted(replacements)))
            print(f"[setup] Previous .env privately backed up to {backup.name}")
        else:
            print("[setup] Local .env public GPU values already match GitHub")
    else:
        print("[setup] GitHub GCP_CONFIG_ENV cached; no public model fields to copy into .env")
    print("[setup] GPU_ENABLED and all private credentials left unchanged.")

for name in ("processing", "icloud-session", "icloud-downloads", "model-cache"):
    path = root / "var" / name
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
