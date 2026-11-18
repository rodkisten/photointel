#!/usr/bin/env python3
"""One-shot loopback WebSocket/PTY smoke test. No remote files are modified."""
import asyncio
import base64
import hashlib
import hmac
import json
import pathlib
import secrets
import sys
import time

import aiohttp


def read_config():
    config = {}
    for line in pathlib.Path("/etc/photointel-ssh.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip().strip('"').strip("'")
    return config


def b64url(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def ticket(secret, target):
    payload = b64url(json.dumps({
        "v": 1, "targetId": target, "sub": "local-smoke-test",
        "aud": "rod-manage-terminal", "exp": int(time.time()) + 30,
        "jti": secrets.token_hex(16),
    }, separators=(",", ":")).encode())
    signature = b64url(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    return payload + "." + signature


async def main():
    config = read_config()
    secret = config["MANAGE_TERMINAL_GATEWAY_SECRET"]
    if len(secret) < 32:
        raise RuntimeError("Gateway secret missing")
    target = json.loads(config["MANAGE_TERMINAL_VMS"])[0]["id"]
    headers = {
        "X-Terminal-Gateway-Secret": secret,
        "X-Terminal-Ticket": ticket(secret, target),
    }
    marker = "PHOTOINTEL_PTY_" + secrets.token_hex(6)
    timeout = aiohttp.ClientTimeout(total=25, sock_connect=10)
    async with aiohttp.ClientSession(timeout=timeout) as client:
        async with client.ws_connect(
            "http://127.0.0.1:8789/ws", headers=headers,
            heartbeat=10, max_msg_size=16384,
        ) as ws:
            print("✅ Signed WebSocket ticket accepted")
            await ws.send_json({"type": "resize", "cols": 100, "rows": 30})
            await ws.send_json({"type": "stdin", "data": f"printf '{marker}\\n'; whoami; exit\\n"})
            output = ""
            deadline = asyncio.get_running_loop().time() + 15
            while asyncio.get_running_loop().time() < deadline:
                remaining = deadline - asyncio.get_running_loop().time()
                msg = await asyncio.wait_for(ws.receive(), timeout=remaining)
                if msg.type == aiohttp.WSMsgType.TEXT:
                    frame = json.loads(msg.data)
                    if frame.get("type") == "stdout":
                        output += frame.get("data", "")
                        if marker in output and "rod" in output:
                            print("✅ Interactive PTY stdin/stdout: OK")
                            break
                    elif frame.get("type") == "exit":
                        break
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                    break
            else:
                raise RuntimeError("PTY did not produce expected output")
            if marker not in output or "rod" not in output:
                raise RuntimeError("PTY output missing marker or username")
            print("🎉 Local WebSocket PTY smoke test passed")
    print("⚠️ Cloudflare Worker forwarding and browser integration remain untested")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"❌ {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
