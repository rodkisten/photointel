"""Private SSH/SFTP gateway for PhotoIntel Manage. Python 3.12+."""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import pathlib
import secrets
import time
from contextlib import asynccontextmanager

import asyncssh
from aiohttp import web, WSMsgType

LOG = logging.getLogger("photointel.ssh")
MAX_FILE = 1024 * 1024
MAX_SESSIONS = 3
SESSIONS = asyncio.Semaphore(MAX_SESSIONS)
TICKETS: dict[str, int] = {}
TARGETS = {}
SECRET = ""
SSH_KEY = ""

def fail(status, message):
    raise web.HTTPException(reason=message, status=status)

def error(status, message):
    return web.json_response({"message": message}, status=status)

def require_gateway(request):
    provided = request.headers.get("X-Terminal-Gateway-Secret", "")
    if not hmac.compare_digest(provided.encode(), SECRET.encode()):
        raise web.HTTPForbidden(text="Gateway authentication required")

def decode_ticket(value):
    try:
        payload, signature = value.split(".")
        expected = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        if not hmac.compare_digest(expected, actual):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if (data.get("v") != 1 or data.get("aud") != "rod-manage-terminal"
            or not isinstance(data.get("exp"), int) or data["exp"] < time.time()
            or data["exp"] > time.time() + 45
            or not isinstance(data.get("sub"), str) or not data["sub"]
            or data.get("targetId") not in TARGETS
            or not isinstance(data.get("jti"), str)):
            return None
        now = int(time.time())
        for key, expiry in list(TICKETS.items()):
            if expiry < now:
                TICKETS.pop(key, None)
        if data["jti"] in TICKETS:
            return None
        TICKETS[data["jti"]] = data["exp"]
        return data
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None

class PinnedSSHClient(asyncssh.SSHClient):
    def __init__(self, fingerprint):
        self.fingerprint = fingerprint

    def validate_host_public_key(self, host, addr, port, key):
        return hmac.compare_digest(key.get_fingerprint("sha256"), self.fingerprint)

@asynccontextmanager
async def ssh(target_id):
    target = TARGETS[target_id]
    connection = await asyncssh.connect(
        target["host"], port=target["port"], username=target["username"],
        client_keys=[SSH_KEY], known_hosts=None,
        client_factory=lambda: PinnedSSHClient(target["hostKeySha256"]),
        login_timeout=12, keepalive_interval=15, keepalive_count_max=2,
    )
    try:
        yield connection
    finally:
        connection.close()
        await connection.wait_closed()

def safe_path(path):
    if (not isinstance(path, str) or not path.startswith("/") or len(path) > 2048
        or "\\x00" in path or any(ord(c) < 32 for c in path)
        or any(part in (".", "..") for part in path.split("/"))):
        raise ValueError("Invalid absolute path")
    return path

async def file_api(request):
    require_gateway(request)
    if request.content_length and request.content_length > 2 * MAX_FILE:
        return error(413, "Request too large")
    try:
        data = await request.json()
        operation, target_id, path = data["operation"], data["targetId"], safe_path(data["path"])
        if target_id not in TARGETS or operation not in ("list", "read", "write"):
            return error(400, "Invalid operation or target")
        async with ssh(target_id) as conn:
            async with conn.start_sftp_client() as sftp:
                if operation == "list":
                    names = await sftp.listdir(path)
                    if len(names) > 1000:
                        return error(413, "Directory too large")
                    entries = []
                    for name in names:
                        if name in (".", ".."):
                            continue
                        attrs = await sftp.lstat(str(pathlib.PurePosixPath(path) / name))
                        entries.append({"name": name, "kind": "directory" if attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY else "file"})
                    return web.json_response({"entries": entries})
                attrs = await sftp.lstat(path)
                if attrs.type != asyncssh.FILEXFER_TYPE_REGULAR:
                    return error(400, "Not a regular file")
                if attrs.size is None or attrs.size > MAX_FILE:
                    return error(413, "File too large")
                async with sftp.open(path, "rb") as handle:
                    original = await handle.read(MAX_FILE + 1)
                if len(original) > MAX_FILE:
                    return error(413, "File too large")
                version = hashlib.sha256(original).hexdigest()
                if operation == "read":
                    try:
                        content = original.decode("utf-8")
                    except UnicodeDecodeError:
                        return error(415, "Only UTF-8 text files supported")
                    return web.json_response({"content": content, "version": version})
                if not isinstance(data.get("content"), str) or data.get("version") != version:
                    return error(409, "Remote file changed; reload before saving")
                content = data["content"].encode("utf-8")
                if len(content) > MAX_FILE:
                    return error(413, "File too large")
                # Exclusive temporary file, same directory, followed by atomic rename.
                temp = str(pathlib.PurePosixPath(path).parent / (".rod-" + secrets.token_hex(12)))
                try:
                    async with sftp.open(temp, "xb") as handle:
                        await handle.write(content)
                    if attrs.permissions is not None:
                        await sftp.chmod(temp, attrs.permissions & 0o777)
                    # SFTP rename semantics vary. posix_rename requires OpenSSH extension.
                    await sftp.posix_rename(temp, path)
                finally:
                    try:
                        await sftp.remove(temp)
                    except asyncssh.SFTPError:
                        pass
                return web.json_response({"version": hashlib.sha256(content).hexdigest()})
    except (KeyError, TypeError, ValueError):
        return error(400, "Invalid request")
    except (asyncssh.PermissionDenied, asyncssh.SFTPPermissionDenied):
        return error(403, "Permission denied")
    except (asyncssh.SFTPNoSuchFile, FileNotFoundError):
        return error(404, "File not found")
    except (asyncssh.Error, OSError):
        LOG.exception("SFTP operation failed")
        return error(503, "SSH/SFTP unavailable")

async def websocket(request):
    require_gateway(request)
    ticket = decode_ticket(request.headers.get("X-Terminal-Ticket", ""))
    if not ticket:
        return error(401, "Invalid or reused ticket")
    if SESSIONS.locked():
        return error(429, "Too many terminal sessions")
    await SESSIONS.acquire()
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=16384)
    try:
        async with ssh(ticket["targetId"]) as conn:
            process = await conn.create_process(term_type="xterm-256color", term_size=(80, 24))
            await ws.prepare(request)
            async def pump():
                async for chunk in process.stdout:
                    await ws.send_json({"type": "stdout", "data": chunk})
                if not ws.closed:
                    await ws.send_json({"type": "exit", "code": process.exit_status})
                    await ws.close()
            task = asyncio.create_task(pump())
            try:
                async for message in ws:
                    if message.type != WSMsgType.TEXT:
                        break
                    try:
                        frame = json.loads(message.data)
                        kind = frame.get("type")
                        if kind == "stdin" and isinstance(frame.get("data"), str) and len(frame["data"].encode()) <= 8192:
                            process.stdin.write(frame["data"])
                        elif kind == "resize" and type(frame.get("cols")) is int and type(frame.get("rows")) is int and 20 <= frame["cols"] <= 500 and 5 <= frame["rows"] <= 200:
                            process.change_terminal_size(frame["cols"], frame["rows"])
                        elif kind == "ping":
                            await ws.send_json({"type": "pong"})
                        else:
                            await ws.close(code=1002)
                    except (ValueError, TypeError):
                        await ws.close(code=1002)
            finally:
                task.cancel()
                process.close()
                await asyncio.gather(task, return_exceptions=True)
        return ws
    except (asyncssh.Error, OSError):
        LOG.exception("SSH session failed")
        if ws.prepared:
            await ws.close(code=1011)
            return ws
        return error(503, "SSH unavailable")
    finally:
        SESSIONS.release()

async def health(request):
    return web.json_response({"ok": True, "targets": len(TARGETS)})

def create_app():
    global TARGETS, SECRET, SSH_KEY
    SECRET = os.environ.get("MANAGE_TERMINAL_GATEWAY_SECRET", "")
    SSH_KEY = os.environ.get("SSH_PRIVATE_KEY_PATH", "")
    if len(SECRET) < 32 or not SSH_KEY or not os.path.isfile(SSH_KEY):
        raise RuntimeError("Gateway secret and SSH private key file are required")
    raw = json.loads(os.environ.get("MANAGE_TERMINAL_VMS", "[]"))
    if not isinstance(raw, list) or not raw:
        raise RuntimeError("Configure at least one SSH target")
    for target in raw:
        if (not isinstance(target, dict) or not all(k in target for k in
            ("id", "host", "port", "username", "hostKeySha256"))
            or not isinstance(target["hostKeySha256"], str)
            or not target["hostKeySha256"].startswith("SHA256:")):
            raise RuntimeError("Invalid target configuration")
        TARGETS[target["id"]] = target
    app = web.Application(client_max_size=2 * MAX_FILE)
    app.router.add_get("/health", health)
    app.router.add_post("/files", file_api)
    app.router.add_get("/ws", websocket)
    return app

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(create_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "8789")))
