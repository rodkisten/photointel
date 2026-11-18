#!/usr/bin/env bash
set -Eeuo pipefail

# PhotoIntel Manage: Debian + nvm + Node.js 24 + build/deploy
# ./deploy-manage.sh [--install-only|--build-only|--deploy]
# Optional: PHOTOINTEL_REPO=/path/to/photointel ./deploy-manage.sh --build-only

MODE="${1:---deploy}"
NODE_MAJOR=24
NVM_VERSION=v0.40.3
REPO="${PHOTOINTEL_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
export DEBIAN_FRONTEND=noninteractive

purple=$'\033[1;35m'
green=$'\033[1;32m'
red=$'\033[1;31m'
reset=$'\033[0m'
log() { printf '\n%s●%s %s\n' "$purple" "$reset" "$*"; }
ok() { printf '%s✓%s %s\n' "$green" "$reset" "$*"; }
die() { printf '%s✗%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }
trap 'printf "%s✗%s Falha na linha %s (exit %s)\n" "$red" "$reset" "$LINENO" "$?" >&2' ERR

case "$MODE" in
  --install-only|--build-only|--deploy) ;;
  *) die "Uso: $0 [--install-only|--build-only|--deploy]" ;;
esac

[[ "${EUID}" -ne 0 ]] || die "Execute como usuário normal (ex.: rod), não como root."
command -v sudo >/dev/null || die "sudo não instalado."
[[ -f "$REPO/apps/manage/package.json" && -f "$REPO/infra/scripts/deploy_manage.py" ]] ||
  die "Repositório PhotoIntel não encontrado em $REPO."

log "🐧 Verificando dependências Debian"
declare -A required_commands=(
  [curl]=curl
  [git]=git
  [make]=build-essential
  [gcc]=build-essential
  [python3]=python3
  [jq]=jq
)
missing_packages=()
declare -A scheduled_packages=()
for cmd in curl git make gcc python3 jq; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd já instalado: $(command -v "$cmd")"
  else
    package="${required_commands[$cmd]}"
    if [[ -z "${scheduled_packages[$package]:-}" ]]; then
      missing_packages+=("$package")
      scheduled_packages[$package]=1
    fi
    log "$cmd ausente; instalar pacote $package"
  fi
done

# HTTPS support for curl is needed to install nvm; install CA certificates
# only when the Debian certificate bundle is absent.
if [[ ! -s /etc/ssl/certs/ca-certificates.crt ]]; then
  missing_packages+=(ca-certificates)
  log "Bundle de certificados CA ausente"
else
  ok "Certificados CA presentes"
fi

if (( ${#missing_packages[@]} > 0 )); then
  log "📦 Instalando somente pacotes ausentes: ${missing_packages[*]}"
  sudo -v
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${missing_packages[@]}"
else
  ok "Todos os requisitos presentes; apt-get não será executado"
fi

log "🟣 nvm $NVM_VERSION e Node.js $NODE_MAJOR"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" \
    -o /tmp/photointel-nvm-install.sh
  bash /tmp/photointel-nvm-install.sh
  rm -f /tmp/photointel-nvm-install.sh
fi
# nvm is a shell function and is not available until sourced.
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR"
nvm use "$NODE_MAJOR"
nvm alias default "$NODE_MAJOR"
hash -r
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]] ||
  die "Node.js 24 não está ativo."
ok "Node $(node --version), npm $(npm --version), nvm $(nvm --version)"

cd "$REPO"
log "📁 Sincronizando main"
[[ "$(git branch --show-current)" == main ]] ||
  die "Checkout não está na branch main. Troque para main antes de publicar."
[[ -z "$(git status --porcelain)" ]] ||
  die "Há alterações locais. Faça commit/stash antes de atualizar."
git pull --ff-only
ok "Commit $(git rev-parse --short HEAD)"

log "📦 Instalando dependências com lockfile"
npm --prefix apps/manage ci
ok "npm ci concluído"

if [[ "$MODE" == --install-only ]]; then
  ok "Instalação concluída, sem build/deploy"
  exit 0
fi

log "🔎 TypeScript + Vite"
npm --prefix apps/manage run build
ok "Build concluído"

if [[ "$MODE" == --build-only ]]; then
  ok "Build validado, sem deploy"
  exit 0
fi

log "🔐 Verificando GCP"
command -v gcloud >/dev/null || die "Instale e autentique o gcloud CLI antes do deploy."
gcloud auth print-access-token >/dev/null ||
  die "Credencial GCP indisponível. Execute gcloud auth login ou configure ADC."
[[ -f infra/gcp/config.local.json ]] ||
  die "infra/gcp/config.local.json ausente. Prepare GCP_CONFIG_ENV com o fluxo oficial."
export CONFIRM_PROJECT=photointel

log "🚀 Publicando Manage pelo publicador oficial (D1 + bindings + secrets)"
python3 infra/scripts/deploy_manage.py apply
ok "Deploy finalizado: https://photos-manage.migos.club"
