# 🔐 PhotoIntel SSH Gateway

> 📒 **Registro da implantação real:** [SETUP-DEBIAN-VM.md](./SETUP-DEBIAN-VM.md) documenta os comandos executados na VM Debian, resultados confirmados e pendências.

Private SSH/SFTP bridge for the Manage CodeMirror workspace.

## Security model

- Run this process as a dedicated unprivileged user, **not root**.
- Bind on `127.0.0.1:8789` only. Expose through a private Cloudflare Tunnel with an authenticated origin; never forward the port directly to the public Internet.
- The Cloudflare Manage Worker authenticates the user via Access. The gateway separately requires the `X-Terminal-Gateway-Secret` shared secret. Do not expose the gateway secret to browser clients.
- VM SSH targets are configured server-side. The gateway validates SSH server public key fingerprints; do not disable host-key verification.
- Use a dedicated, passphrase-protected or narrowly scoped SSH key (with a secure agent or key-file permissions). Restrict the target Unix account and filesystem permissions.
- SFTP read/write is limited to UTF-8 regular files up to 1 MiB; writes require the SHA-256 version previously read and use OpenSSH POSIX rename.
- **Important:** the current conditional-write check is not a transactional lock across multiple independent writers. A concurrent modification between the version check and rename is still possible. Do not treat this as a full concurrency guarantee.
- The gateway intentionally does not offer arbitrary SSH hosts, arbitrary shell commands via HTTP, or browser-provided SSH credentials.

## Debian installation

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv openssh-client
sudo useradd --system --create-home --shell /usr/sbin/nologin photointel-ssh || true
sudo install -d -o photointel-ssh -g photointel-ssh -m 0700 /opt/photointel-ssh
sudo cp server.py requirements.txt /opt/photointel-ssh/
sudo python3 -m venv /opt/photointel-ssh/.venv
sudo /opt/photointel-ssh/.venv/bin/pip install -r /opt/photointel-ssh/requirements.txt
sudo chown -R photointel-ssh:photointel-ssh /opt/photointel-ssh
```

Create a dedicated SSH private key and an environment file outside the repository. Example `/etc/photointel-ssh.env` (permissions `0600`, root-owned):

```dotenv
MANAGE_TERMINAL_GATEWAY_SECRET=REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARS
MANAGE_TERMINAL_VMS=[{"id":"debian","label":"Debian VM","host":"REPLACE_HOST","port":22,"username":"REPLACE_USER","hostKeySha256":"SHA256:REPLACE_WITH_VERIFIED_FINGERPRINT"}]
SSH_PRIVATE_KEY_PATH=/opt/photointel-ssh/id_ed25519
PORT=8789
```

Verify the SSH host fingerprint **out of band** before setting `hostKeySha256`. The same target catalog and secret must be configured in the Manage Worker. Set `MANAGE_TERMINAL_GATEWAY_URL` to the HTTPS tunnel origin. Do not use the VM's raw public IP as the browser-facing gateway URL.

Copy `photointel-ssh.service` to `/etc/systemd/system/`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now photointel-ssh
sudo systemctl status photointel-ssh
curl --fail http://127.0.0.1:8789/health
```

## HTTP contract

- `GET /health`: non-sensitive process health (should be protected by tunnel policy)
- `POST /files`: authenticated `list`, `read`, `write` requests, with `targetId`, absolute `path`, and for writes `content` and `version`
- `GET /ws`: authenticated WebSocket upgrade with a signed, 30-second, single-use ticket in `X-Terminal-Ticket`

## Operational caveats

The gateway is code-complete as an initial prototype, but has **not** been deployed to a VM or verified end-to-end. Cloudflare Tunnel routing, Manage Worker WebSocket forwarding, secret provisioning, key distribution, lockfile updates, and CI validation remain to be completed before calling this production-ready.
