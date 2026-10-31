#!/bin/bash
# Metadata contains only non-secret settings and Secret Manager references.
set -euo pipefail
umask 077
meta() { curl --fail --silent --show-error --retry 5 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
cfg="$(meta instance/attributes/terminal-config)"
project="$(meta project/project-id)"
minutes="$(jq -er '.max_minutes' <<< "$cfg")"
# Arm before package/network operations; setup failures must still shut down.
cat > /etc/systemd/system/terminal-deadline.service <<'UNIT'
[Unit]
Description=Stop terminal VM at session deadline
[Service]
Type=oneshot
ExecStart=/sbin/shutdown -h now
UNIT
cat > /etc/systemd/system/terminal-deadline.timer <<UNIT
[Unit]
Description=Maximum terminal VM uptime
[Timer]
OnBootSec=${minutes}min
Unit=terminal-deadline.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now terminal-deadline.timer
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends docker.io curl jq ca-certificates gnupg
systemctl enable --now docker
if ! command -v tailscale >/dev/null; then
  curl -fsSL --retry 5 https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL --retry 5 https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y tailscale
fi
systemctl enable --now tailscaled
# Keep the host's conventional SSH server off the public interface.
mkdir -p /etc/ssh/sshd_config.d
printf 'ListenAddress 127.0.0.1\nPasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-terminal.conf
systemctl restart ssh || true
install -d -m 0700 /run/terminal
trap 'rm -f /run/terminal/*' EXIT
access_token="$(meta instance/service-accounts/default/token | jq -er .access_token)"
secret() {
  local name version
  name="$(jq -er --arg key "$1" '.oauth[$key].name' <<< "$cfg")"
  version="$(jq -er --arg key "$1" '.oauth[$key].version' <<< "$cfg")"
  curl -fsS --retry 5 -H "Authorization: Bearer $access_token" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$name/versions/$version:access" \
    | jq -er .payload.data | base64 -d
}
if ! tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null; then
  secret TS_OAUTH_CLIENT_ID > /run/terminal/client
  secret TS_OAUTH_SECRET > /run/terminal/secret
  curl -fsS --retry 5 -X POST https://api.tailscale.com/api/v2/oauth/token \
    --data-urlencode client_id@/run/terminal/client --data-urlencode client_secret@/run/terminal/secret \
    --data grant_type=client_credentials > /run/terminal/oauth
  jq -er '.access_token | "Authorization: Bearer " + .' /run/terminal/oauth > /run/terminal/header
  jq -n --arg tag "$(jq -er .tag <<< "$cfg")" \
    '{capabilities:{devices:{create:{reusable:false,ephemeral:false,preauthorized:true,tags:[$tag]}}},expirySeconds:600}' > /run/terminal/request
  curl -fsS --retry 5 -X POST -H @/run/terminal/header -H 'Content-Type: application/json' \
    --data-binary @/run/terminal/request https://api.tailscale.com/api/v2/tailnet/-/keys \
    | jq -er .key > /run/terminal/key
  tailscale up --auth-key=file:/run/terminal/key --ssh --accept-dns=false \
    --hostname="$(jq -er .name <<< "$cfg")" --advertise-tags="$(jq -er .tag <<< "$cfg")"
else
  tailscale set --ssh --accept-dns=false
fi
image="$(jq -er .image <<< "$cfg")"
registry="${image%%/*}"
printf '%s' "$access_token" | docker --config /run/terminal/docker login -u oauth2accesstoken --password-stdin "https://$registry"
docker --config /run/terminal/docker pull "$image"
install -d -o 1000 -g 1000 -m 0700 /var/lib/terminal/home
# The container uses bridge networking, no privileged mode and no host Docker socket.
docker rm -f photointel-terminal 2>/dev/null || true
docker run -d --name photointel-terminal --restart unless-stopped \
  --log-opt max-size=5m --log-opt max-file=2 \
  -e "CLOUDSDK_CORE_PROJECT=$project" \
  -e "CLOUDSDK_COMPUTE_REGION=$(jq -er .region <<< "$cfg")" \
  -v /var/lib/terminal/home:/home/rod \
  "$image"
cat > /usr/local/bin/terminal-shell <<'SHELL'
#!/bin/bash
set -e
flags=(-i)
if [[ -t 0 && -t 1 ]]; then flags+=(-t); fi
if [[ "${1:-}" == -c ]]; then
  exec /usr/bin/docker exec "${flags[@]}" --user rod --workdir /home/rod photointel-terminal /bin/bash "$@"
fi
exec /usr/bin/docker exec "${flags[@]}" --user rod --workdir /home/rod photointel-terminal /bin/bash -l
SHELL
chmod 0755 /usr/local/bin/terminal-shell
if ! id rod >/dev/null 2>&1; then useradd -m -s /usr/local/bin/terminal-shell rod; fi
usermod -aG docker -s /usr/local/bin/terminal-shell rod
grep -qxF /usr/local/bin/terminal-shell /etc/shells || echo /usr/local/bin/terminal-shell >> /etc/shells
echo "Terminal ready: ssh rod@$(tailscale ip -4). Maximum uptime: $minutes minutes."
