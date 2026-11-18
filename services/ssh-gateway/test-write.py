#!/usr/bin/env python3
"""Isolated SFTP write/conflict smoke test. Creates and removes one test file in /home/rod."""
import hashlib
import json
import pathlib
import secrets
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8789"
HOME = pathlib.Path("/home/rod")
PREFIX = ".photointel-sftp-smoke-"

def env():
    values = {}
    for line in pathlib.Path("/etc/photointel-ssh.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values

def main():
    config = env()
    secret = config["MANAGE_TERMINAL_GATEWAY_SECRET"]
    target = json.loads(config["MANAGE_TERMINAL_VMS"])[0]["id"]
    if len(secret) < 32:
        raise RuntimeError("Invalid gateway secret")

    def api(operation, path, **extra):
        request = urllib.request.Request(
            BASE + "/files",
            data=json.dumps(dict(operation=operation, targetId=target, path=path, **extra)).encode(),
            headers={"Content-Type": "application/json", "X-Terminal-Gateway-Secret": secret},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode())

    name = PREFIX + secrets.token_hex(10) + ".txt"
    path = HOME / name
    original = "PhotoIntel SFTP smoke test\n"
    updated = "PhotoIntel SFTP smoke test: updated\n"
    try:
        # Test file is created locally, exclusively and with restrictive permissions.
        with path.open("x", encoding="utf-8") as handle:
            handle.write(original)
        path.chmod(0o600)
        status, result = api("read", str(path))
        assert status == 200 and result["content"] == original, f"Initial read failed: {status}"
        old_version = result["version"]
        assert old_version == hashlib.sha256(original.encode()).hexdigest()
        print("✅ Initial SFTP read and SHA-256: OK")

        status, result = api("write", str(path), content=updated, version=old_version)
        assert status == 200, f"SFTP write failed: {status} {result}"
        assert result["version"] == hashlib.sha256(updated.encode()).hexdigest()
        assert path.read_text() == updated
        print("✅ Conditional SFTP write and content integrity: OK")

        status, result = api("write", str(path), content="SHOULD NEVER REPLACE\n", version=old_version)
        assert status == 409, f"Expected 409 for stale version, got {status}"
        assert path.read_text() == updated
        print("✅ Stale version rejected with HTTP 409: OK")

        status, result = api("read", str(path))
        assert status == 200 and result["content"] == updated
        print("🎉 SFTP write/conflict smoke tests passed")
    finally:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            print(f"⚠️ Cleanup failed for {path.name}: {exc}", file=sys.stderr)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"❌ {exc}", file=sys.stderr)
        sys.exit(1)
