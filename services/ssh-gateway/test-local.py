#!/usr/bin/env python3
"""Read-only end-to-end SFTP smoke test against the loopback gateway.

Run on the Debian VM: sudo python3 test-local.py
Reads the gateway secret locally, never prints it and never writes remote files.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ENV_FILE = pathlib.Path("/etc/photointel-ssh.env")
BASE = "http://127.0.0.1:8789"

def read_env():
    values = {}
    for line in ENV_FILE.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values

def main():
    if not ENV_FILE.is_file():
        raise RuntimeError("Missing gateway environment file")
    env = read_env()
    secret = env.get("MANAGE_TERMINAL_GATEWAY_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("Gateway secret not configured")
    targets = json.loads(env.get("MANAGE_TERMINAL_VMS", "[]"))
    if not targets:
        raise RuntimeError("No SSH targets configured")
    target_id = targets[0]["id"]

    with urllib.request.urlopen(BASE + "/health", timeout=8) as response:
        health = json.load(response)
    if health.get("ok") is not True or health.get("targets", 0) < 1:
        raise RuntimeError("Health response invalid")
    print("✅ Gateway HTTP health: OK")

    def post(operation, path):
        payload = json.dumps({
            "operation": operation, "targetId": target_id, "path": path,
        }).encode("utf-8")
        request = urllib.request.Request(
            BASE + "/files", data=payload, method="POST",
            headers={"Content-Type": "application/json",
                     "X-Terminal-Gateway-Secret": secret},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            # Avoid printing headers or the authentication secret.
            detail = exc.read(2048).decode("utf-8", "replace")
            raise RuntimeError(f"{operation} {path}: HTTP {exc.code}: {detail}") from None

    listed = post("list", "/home/rod")
    if not isinstance(listed.get("entries"), list):
        raise RuntimeError("SFTP list returned invalid response")
    print(f"✅ SFTP directory listing: {len(listed['entries'])} entries")

    read = post("read", "/etc/hostname")
    if not isinstance(read.get("content"), str) or len(read.get("version", "")) != 64:
        raise RuntimeError("SFTP read returned invalid content/version")
    print("✅ SFTP file read and SHA-256 version: OK")

    print("🎉 Read-only gateway smoke tests passed")
    print("⚠️ WebSocket PTY, writes, conflict handling and Cloudflare tunnel are not tested")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"❌ {exc}", file=sys.stderr)
        sys.exit(1)
