#!/usr/bin/env python3
"""Create a private development configuration without overwriting user values."""
import os
import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[2]
target = root / ".env"
if target.exists():
    print(".env existente preservado; revise valores com .env.example.")
else:
    password = secrets.token_hex(24)
    storage_password = secrets.token_hex(24)
    contents = (root / ".env.example").read_text()
    replacements = {
        "POSTGRES_PASSWORD": password,
        "DATABASE_URL": (
            f"postgresql+asyncpg://photointel:{password}@localhost:5432/photointel"
        ),
        "MINIO_ROOT_PASSWORD": storage_password,
        "STORAGE_SECRET_KEY": storage_password,
        "BRIDGE_ENROLLMENT_SECRET": secrets.token_hex(32),
        "BRIDGE_TOKEN_PEPPER": secrets.token_hex(32),
    }
    lines = []
    for line in contents.splitlines():
        key = line.partition("=")[0]
        lines.append(f"{key}={replacements[key]}" if key in replacements else line)
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    print(".env local criado com modo 0600 e credenciais aleatórias.")
for name in ("processing", "icloud-session", "icloud-downloads", "model-cache"):
    path = root / "var" / name
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
