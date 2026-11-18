#!/usr/bin/env bash
set -Eeuo pipefail
# Bootstrap only: intentionally does not install authorized_keys, publish a tunnel,
# open firewall ports, or claim that SSH connectivity was tested.
[[ ${EUID} -eq 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
APP=/opt/photointel-ssh
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
echo '🔐 Installing PhotoIntel SSH gateway (loopback only)'
apt-get update
apt-get install -y python3 python3-venv openssh-client curl ca-certificates
id photointel-ssh >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin photointel-ssh
install -d -o photointel-ssh -g photointel-ssh -m 0700 "$APP"
install -o photointel-ssh -g photointel-ssh -m 0644 "$SRC/server.py" "$APP/server.py"
install -o photointel-ssh -g photointel-ssh -m 0644 "$SRC/requirements.txt" "$APP/requirements.txt"
if [[ ! -x "$APP/.venv/bin/python" ]]; then
  python3 -m venv "$APP/.venv"
fi
"$APP/.venv/bin/pip" install -r "$APP/requirements.txt"
if [[ ! -f "$APP/id_ed25519" ]]; then
  runuser -u photointel-ssh -- ssh-keygen -q -t ed25519 -N '' -f "$APP/id_ed25519"
fi
chmod 0600 "$APP/id_ed25519"
chown photointel-ssh:photointel-ssh "$APP/id_ed25519"
if [[ ! -e /etc/photointel-ssh.env ]]; then
  SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  cat >/etc/photointel-ssh.env <<EOF
MANAGE_TERMINAL_GATEWAY_SECRET=$SECRET
MANAGE_TERMINAL_VMS=[]
SSH_PRIVATE_KEY_PATH=$APP/id_ed25519
PORT=8789
EOF
  chmod 0600 /etc/photointel-ssh.env
  echo '🟡 /etc/photointel-ssh.env created. Configure MANAGE_TERMINAL_VMS after verifying the SSH host key.'
else
  echo '🟢 Existing gateway secrets preserved'
fi
install -m 0644 "$SRC/photointel-ssh.service" /etc/systemd/system/photointel-ssh.service
systemctl daemon-reload
echo
echo '🔑 Add this PUBLIC key to rod@194.61.238.98 ~/.ssh/authorized_keys (after verifying access):'
cat "$APP/id_ed25519.pub"
echo
echo '🔎 Verify host fingerprint independently, then set MANAGE_TERMINAL_VMS:'
echo '  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256'
echo '  Example target: [{"id":"debian","label":"Debian VM","host":"127.0.0.1","port":22,"username":"rod","hostKeySha256":"SHA256:VERIFIED_FINGERPRINT"}]'
echo
echo '🧪 Once configured: sudo systemctl enable --now photointel-ssh'
echo '🧪 Then: curl --fail http://127.0.0.1:8789/health'
echo '☁️ Configure a Cloudflare Tunnel route to http://127.0.0.1:8789 separately.'
