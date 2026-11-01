#!/bin/bash
# Metadata contains only non-secret settings and Secret Manager references.
set -Eeuo pipefail
umask 077
# Log only the failing stage and exit status to serial console. Never log
# OAuth secrets, instance metadata contents, Docker credentials or JWTs.
terminal_stage=metadata
trap 'result=$?; echo "terminal-startup: FAILED stage=$terminal_stage exit=$result" >&2' ERR
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
chmod 0644 /etc/systemd/system/terminal-deadline.service /etc/systemd/system/terminal-deadline.timer
systemctl daemon-reload
systemctl enable --now terminal-deadline.timer
terminal_stage=apt
export DEBIAN_FRONTEND=noninteractive
# On the first boot this script used umask 077 for all files, including the
# public Tailscale keyring. APT verifies repositories as the unprivileged _apt
# user, so mode 0600 makes the correct key unreadable and produces a misleading
# "repository is not signed" / GPG verification error. Repair any files left by
# a previous failed boot BEFORE the first apt-get update.
tailscale_keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg
tailscale_sources=/etc/apt/sources.list.d/tailscale.list
for apt_public_file in "$tailscale_keyring" "$tailscale_sources"; do
  if [[ -f "$apt_public_file" ]]; then
    chmod 0644 "$apt_public_file"
  fi
done
echo 'terminal-startup: apt source permissions checked'
apt-get update -qq
apt-get install -y --no-install-recommends docker.io curl jq ca-certificates gnupg
systemctl enable --now docker
if ! command -v tailscale >/dev/null; then
  # Download both *public* files to a private staging directory, then install
  # them atomically with explicit APT-readable permissions. The restrictive
  # umask remains in effect for OAuth and Google Secret Manager credentials.
  tailscale_stage="$(mktemp -d)"
  curl -fsSL --retry 5 https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o "$tailscale_stage/keyring.gpg"
  curl -fsSL --retry 5 https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list -o "$tailscale_stage/tailscale.list"
  test -s "$tailscale_stage/keyring.gpg"
  test -s "$tailscale_stage/tailscale.list"
  install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
  install -m 0644 "$tailscale_stage/keyring.gpg" "$tailscale_keyring"
  install -m 0644 "$tailscale_stage/tailscale.list" "$tailscale_sources"
  rm -rf "$tailscale_stage"
  echo 'terminal-startup: tailscale public APT keyring and source installed'
  apt-get update -qq
  apt-get install -y --no-install-recommends tailscale tailscale-archive-keyring
fi
systemctl enable --now tailscaled
echo 'terminal-startup: tailscaled service enabled'
terminal_stage=tailscale-auth
# Keep the host's conventional SSH server off the public interface.
mkdir -p /etc/ssh/sshd_config.d
printf 'ListenAddress 127.0.0.1\nPasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-terminal.conf
systemctl restart ssh || true
install -d -m 0700 /run/terminal
trap 'rm -f /run/terminal/*' EXIT
access_token="$(meta instance/service-accounts/default/token | jq -er .access_token)"
secret() {
  local name version response
  name="$(jq -er --arg key "$1" '.oauth[$key].name' <<< "$cfg")"
  version="$(jq -er --arg key "$1" '.oauth[$key].version' <<< "$cfg")"
  if ! response="$(curl -fsS --retry 5 -H "Authorization: Bearer $access_token" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$name/versions/$version:access")"; then
    # These are configuration references, not the secret values.
    echo "terminal-startup: FAILED stage=tailscale-auth secret=$1 version=$version" >&2
    return 1
  fi
  jq -er .payload.data <<< "$response" | base64 -d
}
if ! tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null; then
  secret TS_OAUTH_CLIENT_ID > /run/terminal/client
  secret TS_OAUTH_SECRET > /run/terminal/secret
  echo 'terminal-startup: oauth credentials read'
  curl -fsS --retry 5 -X POST https://api.tailscale.com/api/v2/oauth/token \
    --data-urlencode client_id@/run/terminal/client --data-urlencode client_secret@/run/terminal/secret \
    --data grant_type=client_credentials > /run/terminal/oauth
  echo 'terminal-startup: oauth token received'
  jq -er '.access_token | "Authorization: Bearer " + .' /run/terminal/oauth > /run/terminal/header
  jq -n --arg tag "$(jq -er .tag <<< "$cfg")" \
    '{capabilities:{devices:{create:{reusable:false,ephemeral:false,preauthorized:true,tags:[$tag]}}},expirySeconds:600}' > /run/terminal/request
  curl -fsS --retry 5 -X POST -H @/run/terminal/header -H 'Content-Type: application/json' \
    --data-binary @/run/terminal/request https://api.tailscale.com/api/v2/tailnet/-/keys \
    | jq -er .key > /run/terminal/key
  echo 'terminal-startup: tailscale auth key issued'
  tailscale up --auth-key=file:/run/terminal/key --ssh --accept-dns=false \
    --hostname="$(jq -er .name <<< "$cfg")" --advertise-tags="$(jq -er .tag <<< "$cfg")"
else
  tailscale set --ssh --accept-dns=false
fi
echo 'terminal-startup: tailscale network configured'
terminal_stage=docker-image
image="$(jq -er .image <<< "$cfg")"
registry="${image%%/*}"
echo 'terminal-startup: registry authentication starting'
printf '%s' "$access_token" | docker --config /run/terminal/docker login -u oauth2accesstoken --password-stdin "https://$registry"
echo 'terminal-startup: registry authenticated'
echo 'terminal-startup: docker image pull starting'
docker --config /run/terminal/docker pull "$image"
echo 'terminal-startup: docker image pulled'
install -d -o 1000 -g 1000 -m 0700 /var/lib/terminal/home
# Preserve changes to the container's writable layer across normal VM starts.
# A new immutable image digest requires replacement; personal files are mounted
# from the persistent VM boot disk, and baseline tools live in the Dockerfile.
if docker container inspect photointel-terminal >/dev/null 2>&1; then
  current_image="$(docker inspect --format '{{.Config.Image}}' photointel-terminal)"
  if [[ "$current_image" != "$image" ]]; then
    echo 'terminal-startup: image changed; replacing container (home preserved)'
    docker rm -f photointel-terminal >/dev/null
  fi
fi
if docker container inspect photointel-terminal >/dev/null 2>&1; then
  docker update --restart unless-stopped photointel-terminal >/dev/null
  if [[ "$(docker inspect --format '{{.State.Running}}' photointel-terminal)" != true ]]; then
    docker start photointel-terminal >/dev/null
  fi
  echo 'terminal-startup: existing docker container reused'
else
  # The container uses bridge networking, no privileged mode and no host Docker socket.
  docker run -d --name photointel-terminal --restart unless-stopped \
    --log-opt max-size=5m --log-opt max-file=2 \
    -e "CLOUDSDK_CORE_PROJECT=$project" \
    -e "CLOUDSDK_COMPUTE_REGION=$(jq -er .region <<< "$cfg")" \
    -v /var/lib/terminal/home:/home/rod \
    "$image"
  echo 'terminal-startup: docker container started'
fi
# Install interactive shell tooling inside the container. The home directory is
# already mounted from the persistent VM boot disk by the original Docker setup.
terminal_stage=shell-packages
docker exec -i --user root -e DEBIAN_FRONTEND=noninteractive \
  photointel-terminal /bin/sh -eu <<'CONTAINER_PACKAGES'
if ! command -v apt-get >/dev/null 2>&1; then
  echo 'terminal-startup: shell setup requires a Debian/Ubuntu-based container' >&2
  exit 1
fi
missing=0
for pkg in zsh vim git ca-certificates fzf command-not-found; do
  if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -qx 'install ok installed'; then
    missing=1
    break
  fi
done
if [ "$missing" -eq 1 ]; then
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    zsh vim git ca-certificates fzf command-not-found
  if command -v update-command-not-found >/dev/null 2>&1; then
    update-command-not-found >/dev/null 2>&1 || true
  fi
fi
CONTAINER_PACKAGES

# Only correct ownership of the mount root to match the actual container user.
# No recursive chmod/chown and no replacement of existing personal files.
rod_uid="$(docker exec photointel-terminal id -u rod)"
rod_gid="$(docker exec photointel-terminal id -g rod)"
chown "$rod_uid:$rod_gid" /var/lib/terminal/home

terminal_stage=shell-dotfiles
docker exec -i --user rod --workdir /home/rod -e HOME=/home/rod \
  photointel-terminal /bin/bash -se <<'CONTAINER_DOTFILES'
set -Eeuo pipefail
umask 077
export HOME=/home/rod

clone_once() {
  local url="$1" destination="$2" required="$3"
  if [[ -f "$destination/$required" ]]; then return 0; fi
  if [[ -e "$destination" ]]; then
    echo "terminal-startup: incomplete shell plugin directory: $destination" >&2
    return 1
  fi
  git clone --quiet --depth 1 -- "$url" "$destination"
  [[ -f "$destination/$required" ]]
}

clone_once https://github.com/ohmyzsh/ohmyzsh.git \
  "$HOME/.oh-my-zsh" oh-my-zsh.sh
plugins="$HOME/.oh-my-zsh/custom/plugins"
mkdir -p "$plugins" "$HOME/.config/photointel"
clone_once https://github.com/zsh-users/zsh-autosuggestions.git \
  "$plugins/zsh-autosuggestions" zsh-autosuggestions.zsh
clone_once https://github.com/zsh-users/zsh-syntax-highlighting.git \
  "$plugins/zsh-syntax-highlighting" zsh-syntax-highlighting.zsh
clone_once https://github.com/zsh-users/zsh-completions.git \
  "$plugins/zsh-completions" zsh-completions.plugin.zsh

managed_zsh="$HOME/.config/photointel/zsh-init.zsh"
if [[ ! -e "$managed_zsh" ]]; then
  cat > "$managed_zsh" <<'ZSH_CONFIG'
# Persistent Photointel terminal settings (edit freely).
export ZSH="$HOME/.oh-my-zsh"
export EDITOR=vim
export VISUAL=vim
export HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000

ZSH_THEME="${ZSH_THEME:-robbyrussell}"
ENABLE_CORRECTION=true
CASE_SENSITIVE=false
HYPHEN_INSENSITIVE=true
DISABLE_AUTO_TITLE=true
zstyle ':omz:update' mode disabled
setopt SHARE_HISTORY HIST_IGNORE_ALL_DUPS HIST_REDUCE_BLANKS HIST_VERIFY
setopt AUTO_CD CORRECT INTERACTIVE_COMMENTS

# Include additional completion definitions before OMZ runs compinit.
fpath=("$ZSH/custom/plugins/zsh-completions/src" $fpath)

# Do not load Oh My Zsh twice when .zshrc already contains a custom setup.
if (( ! $+functions[omz] )); then
  plugins=(git colored-man-pages command-not-found extract sudo z)
  source "$ZSH/oh-my-zsh.sh"
fi

# Keep useful command-not-found hints even with a pre-existing OMZ setup.
if [[ -r "$ZSH/plugins/command-not-found/command-not-found.plugin.zsh" ]]; then
  source "$ZSH/plugins/command-not-found/command-not-found.plugin.zsh"
fi

zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
zstyle ':completion:*' menu select
bindkey -e

if [[ -r /usr/share/doc/fzf/examples/key-bindings.zsh ]]; then
  source /usr/share/doc/fzf/examples/key-bindings.zsh
fi

ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'
source "$ZSH/custom/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
# Syntax highlighting must come after keybinding/completion integrations.
source "$ZSH/custom/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
ZSH_CONFIG
fi

# Preserve and extend existing dotfiles. Never overwrite user customizations.
touch "$HOME/.zshrc"
if ! grep -Fqx 'source "$HOME/.config/photointel/zsh-init.zsh"' "$HOME/.zshrc"; then
  printf '\n# Photointel persistent shell setup\n' >> "$HOME/.zshrc"
  printf '%s\n' 'source "$HOME/.config/photointel/zsh-init.zsh"' >> "$HOME/.zshrc"
fi

touch "$HOME/.vimrc"
if ! grep -Fqx '" Photointel Vim configuration' "$HOME/.vimrc"; then
  cat >> "$HOME/.vimrc" <<'VIM_CONFIG'

" Photointel Vim configuration
syntax on
filetype plugin indent on
set number
set showmatch
set cursorline
set incsearch
set hlsearch
set ignorecase
set smartcase
set expandtab
set shiftwidth=2
set softtabstop=2
set tabstop=2
set autoindent
set backspace=indent,eol,start
set encoding=utf-8
VIM_CONFIG
fi
CONTAINER_DOTFILES

docker exec --user rod -e HOME=/home/rod \
  photointel-terminal /bin/zsh -n /home/rod/.zshrc
docker exec --user rod -e HOME=/home/rod \
  photointel-terminal /bin/zsh -n /home/rod/.config/photointel/zsh-init.zsh
echo 'terminal-startup: Oh My Zsh, suggestions, completion and Vim ready'

cat > /usr/local/bin/terminal-shell <<'SHELL'
#!/bin/bash
set -e
flags=(-i)
if [[ -t 0 && -t 1 ]]; then flags+=(-t); fi
if [[ "${1:-}" == -c ]]; then
  exec /usr/bin/docker exec "${flags[@]}" --user rod --workdir /home/rod photointel-terminal /bin/zsh "$@"
fi
exec /usr/bin/docker exec "${flags[@]}" --user rod --workdir /home/rod photointel-terminal /bin/zsh -l
SHELL
chmod 0755 /usr/local/bin/terminal-shell
if ! id rod >/dev/null 2>&1; then useradd -m -s /usr/local/bin/terminal-shell rod; fi
usermod -aG docker -s /usr/local/bin/terminal-shell rod
grep -qxF /usr/local/bin/terminal-shell /etc/shells || echo /usr/local/bin/terminal-shell >> /etc/shells
terminal_stage=ready
echo "Terminal ready: ssh rod@$(tailscale ip -4). Maximum uptime: $minutes minutes."
