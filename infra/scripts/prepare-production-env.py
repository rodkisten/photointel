#!/usr/bin/env python3
"""Create the private app-only production environment, preserving existing files."""

import os
import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[2]
target = root / ".env.runtime"
if target.exists():
    print(".env.runtime existente preservado.")
    raise SystemExit(0)
lines = []
for line in (root / ".env.runtime.example").read_text().splitlines():
    key = line.partition("=")[0]
    if key in {"BRIDGE_ENROLLMENT_SECRET", "BRIDGE_TOKEN_PEPPER"}:
        line = f"{key}={secrets.token_hex(32)}"
    lines.append(line)
fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as handle:
    handle.write("\n".join(lines) + "\n")
print(".env.runtime 0600 criado; configure Access/R2 antes de iniciar produção.")
