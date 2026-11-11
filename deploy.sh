#!/usr/bin/env bash
# PhotoIntel unified manual deployment CLI.
# Install: bash deploy.sh install
# Then: deploy all | gcp | cloudflare | web | manage | access | verify
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT="photointel"
REGION="us-central1"
CONFIG="$ROOT/infra/gcp/config.local.json"
LOG_DIR="$ROOT/.photointel-reports/logs"
MODE="${1:-menu}"
if (( $# )); then shift; fi
YES=0
NO_TMUX=0

usage() {
  cat <<'HELP'
PhotoIntel deployment CLI

  bash deploy.sh install       Install "deploy" in ~/.local/bin and PATH
  deploy                      Interactive menu
  deploy all                  GCP API/jobs/scheduler + Access/R2 + web + Manage
  deploy gcp                  Cloud Build (only if missing), jobs, API, scheduler
  deploy cloudflare           Access/R2 + BOTH PhotoIntel and Manage Workers
  deploy web                  Access/R2 + photointel web Worker and assets
  deploy manage               Independent Manage Access + Worker
  deploy access               Reconcile Access/R2 and sync API/jobs audiences
  deploy plan                 Read-only Cloudflare and Manage plans
  deploy verify               Check Access redirects and public HTTP status
  deploy doctor               Inspect local prerequisites
  deploy help                 Display this help

Options:
  --yes                       Confirm production changes without interactive prompt
  --no-tmux                   Do not start a persistent tmux session
  --env-file PATH             Use a local GCP_CONFIG_ENV dotenv/JSON file

Config priority: environment GCP_CONFIG_ENV, --env-file,
  ~/.config/photointel/GCP_CONFIG_ENV, GitHub production environment variable
  via authenticated gh CLI, then existing infra/gcp/config.local.json.

All GCP commands use the Python bridge (except interactive OAuth login).
Migrations are NEVER applied automatically. No destructive cleanup is run.
The Scheduler stage retains repository defaults (new schedules are paused).
HELP
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

# Shared project-scoped GCP executor; native login remains interactive.
gcp() {
  python3 -m infra.gcp.cloud_cli --project "$PROJECT" -- "$@"
}

install_cli() {
  local bin="$HOME/.local/bin"
  local wrapper="$bin/deploy"
  mkdir -p "$bin"
  # A wrapper avoids chmod on the Git-tracked deploy.sh file (no dirty release).
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$ROOT/deploy.sh" > "$wrapper"
  chmod 700 "$wrapper"

  local profile
  for profile in "$HOME/.bashrc" "$HOME/.profile"; do
    touch "$profile"
    if ! grep -Fq '# PhotoIntel deploy PATH' "$profile"; then
      printf '\n# PhotoIntel deploy PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
    fi
  done
  printf 'Installed %s\n' "$wrapper"
  printf 'Activate now: source ~/.bashrc\n'
  printf 'Then try: deploy all\n'
}

choose_mode() {
  printf 'PhotoIntel deployment\n'
  PS3='Select: '
  select choice in all gcp cloudflare web manage access plan verify doctor quit; do
    case "$choice" in
      all|gcp|cloudflare|web|manage|access|plan|verify|doctor)
        MODE="$choice"; return ;;
      quit) exit 0 ;;
      *) printf 'Choose a valid item.\n' ;;
    esac
  done
}

while (( $# )); do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    --no-tmux) NO_TMUX=1; shift ;;
    --env-file)
      (( $# >= 2 )) || die 'Missing --env-file path'
      export PHOTOINTEL_CONFIG_ENV_FILE="$2"
      shift 2 ;;
    --env-file=*)
      export PHOTOINTEL_CONFIG_ENV_FILE="${1#--env-file=}"
      shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done

if [[ "$MODE" == help || "$MODE" == --help || "$MODE" == -h ]]; then
  usage
  exit 0
fi
if [[ "$MODE" == install ]]; then
  install_cli
  exit 0
fi
if [[ "$MODE" == menu ]]; then
  if [[ ! -t 0 ]]; then usage; exit 0; fi
  choose_mode
fi
case "$MODE" in
  all|gcp|cloudflare|web|manage|access|plan|verify|doctor) ;;
  *) usage; die "Invalid mode: $MODE" ;;
esac

# A tmux session survives Safari disconnects while the Cloud Shell VM is alive.
if [[ "$NO_TMUX" == 0 && -z "${TMUX:-}" && -t 0 ]] &&
   command -v tmux >/dev/null 2>&1; then
  case "$MODE" in
    all|gcp|cloudflare|web|manage|access)
      printf -v tmux_cmd '%q ' bash "$ROOT/deploy.sh" "$MODE" --no-tmux
      if [[ "$YES" == 1 ]]; then tmux_cmd+=" --yes"; fi
      if [[ -n "${PHOTOINTEL_CONFIG_ENV_FILE:-}" ]]; then
        printf -v env_arg '%q' "--env-file=$PHOTOINTEL_CONFIG_ENV_FILE"
        tmux_cmd+=" $env_arg"
      fi
      tmux_cmd+='; result=$?; printf "\n[deploy] exit=%s\n" "$result"; exec bash'
      printf 'Attaching tmux session: photointel-deploy (Ctrl+B, D detaches)\n'
      exec tmux new-session -A -s photointel-deploy "$tmux_cmd"
      ;;
  esac
fi

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$MODE.log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'rc=$?; printf "\n[deploy] exit=%s | log=%s\n" "$rc" "$LOG_FILE"' EXIT
cd "$ROOT"
need git
need python3
need gcloud
python3 -c 'from datetime import UTC' || die 'Python >= 3.11 required'
SHA="$(git rev-parse HEAD)"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || die "No valid Git release SHA"
export CONFIRM_PROJECT="$PROJECT"
export RELEASE_SHA="$SHA"
export GITHUB_SHA="$SHA"

info "Repository: $ROOT"
printf 'Release: %s | project: %s | mode: %s\n' "$SHA" "$PROJECT" "$MODE"

ensure_gcloud() {
  local account
  account="$(gcp auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null || true)"
  if [[ -z "$account" ]]; then
    if [[ -t 0 ]]; then
      info 'Google Cloud login'
      gcloud auth login --no-launch-browser
    else
      die 'gcloud authentication required: run gcloud auth login --no-launch-browser'
    fi
  fi
  gcp projects describe "$PROJECT" --format='value(projectId)' >/dev/null ||
    die "Cannot access Google Cloud project $PROJECT"
}

prepare_config() {
  local raw=""
  local path="${PHOTOINTEL_CONFIG_ENV_FILE:-$HOME/.config/photointel/GCP_CONFIG_ENV}"
  if [[ -n "${GCP_CONFIG_ENV:-}" ]]; then
    raw="$GCP_CONFIG_ENV"
    info 'Configuration source: supplied GCP_CONFIG_ENV'
  elif [[ -f "$path" ]]; then
    raw="$(cat "$path")"
    info 'Configuration source: local private file'
  elif command -v gh >/dev/null 2>&1 &&
       env -u GITHUB_TOKEN -u GH_TOKEN gh auth status >/dev/null 2>&1; then
    # Codespaces exports a restricted GITHUB_TOKEN which overrides the user's
    # authenticated gh credentials. Use the explicitly authenticated account.
    raw="$(env -u GITHUB_TOKEN -u GH_TOKEN gh api \
      'repos/rodkisten/photointel/environments/production/variables/GCP_CONFIG_ENV' \
      --jq '.value' 2>/dev/null || true)"
    if [[ -n "$raw" ]]; then info 'Configuration source: GitHub production Environment'; fi
  fi

  if [[ -n "$raw" ]]; then
    local py="python3"
    if [[ "$raw" != \{* ]] && ! python3 -c 'import dotenv' >/dev/null 2>&1; then
      local venv="$HOME/.cache/photointel-deploy/venv"
      info 'Installing isolated python-dotenv dependency'
      python3 -m venv "$venv"
      "$venv/bin/python" -m pip install -q --disable-pip-version-check python-dotenv
      py="$venv/bin/python"
    fi
    GCP_CONFIG_ENV="$raw" CONFIRM_PROJECT="$PROJECT" RELEASE_SHA="$SHA" \
      "$py" -m infra.gcp.gcp_env
    unset raw
  elif [[ -f "$CONFIG" ]]; then
    info 'Using existing private config.local.json; refreshing release SHA'
    python3 - "$CONFIG" "$PROJECT" "$SHA" <<'PY'
import json
import os
import sys
from pathlib import Path

path, project, sha = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
config = json.loads(path.read_text(encoding="utf-8"))
if config.get("project_id") != project:
    raise SystemExit("Refusing configuration for a different project")
region = config["region"]
repo = config["repository"]
config["release_git_sha"] = sha
config["image"] = f"{region}-docker.pkg.dev/{project}/{repo}/api:{sha}"
path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(path, 0o600)
PY
  else
    die 'No deployment configuration. Run gh auth login, or provide --env-file=/path/to/GCP_CONFIG_ENV'
  fi

  python3 - "$CONFIG" "$PROJECT" "$SHA" <<'PY'
import json
import sys
from pathlib import Path
config = json.loads(Path(sys.argv[1]).read_text())
assert config["project_id"] == sys.argv[2], "Wrong project"
assert config["release_git_sha"] == sys.argv[3], "Wrong release SHA"
assert config["region"] == "us-central1", "Unexpected region"
print("Configuration validated: project/region/SHA (secrets not displayed)")
PY
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1 ||
     ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
      # shellcheck disable=SC1091
      source "$HOME/.nvm/nvm.sh"
      nvm install 22
      nvm use 22
    else
      die 'Node >=22 required; install Node 22 or nvm before deploying Workers'
    fi
  fi
  need npm
  printf 'Node: %s\n' "$(node -v)"
}

confirm_apply() {
  [[ "$YES" == 1 ]] && return 0
  [[ -t 0 ]] || die 'Production modifications require --yes in noninteractive mode'
  printf '\nThis will change production resources in %s.\n' "$PROJECT"
  printf 'Type exactly "%s" to continue: ' "$PROJECT"
  local response
  read -r response
  [[ "$response" == "$PROJECT" ]] || die 'Cancelled'
}

gcp_deploy() {
  info 'GCP preflight and immutable image check'
  python3 -m infra.gcp.release_image preflight --project "$PROJECT"
  python3 -m infra.gcp.release_image cache --project "$PROJECT" --sha "$SHA"
  if python3 -m infra.gcp.release_image verify --project "$PROJECT" --sha "$SHA"; then
    info 'Reusing existing image, no Cloud Build charges'
  else
    info 'Building API Docker image in Cloud Build'
    bash infra/gcp/release.sh build
    python3 -m infra.gcp.release_image verify --project "$PROJECT" --sha "$SHA"
  fi
  info 'Cloud Run processing jobs'
  bash infra/gcp/release.sh jobs-deploy
  info 'Cloud Run API (includes Neon schema gate; no automatic migrations)'
  bash infra/gcp/release.sh deploy
  info 'Cloud Scheduler (repository defaults: newly created schedules paused)'
  bash infra/gcp/release.sh scheduler
}

access_apply() {
  info 'Inspect Cloudflare Access application, policies and private R2'
  python3 -m infra.scripts.cloudflare_setup plan
  info 'Reconcile Cloudflare Access/R2 and synchronize API/Jobs audiences'
  python3 -m infra.scripts.cloudflare_setup apply
}

web_deploy() {
  ensure_node
  info 'Installing frontend dependencies'
  npm --prefix apps/web ci
  info 'Building PhotoIntel SPA'
  python3 -m infra.scripts.prepare_workflow_env worker-build
  cp infra/cloudflare/worker-headers apps/web/dist/_headers
  info 'Deploying photointel Worker + assets + /v1 proxy'
  python3 -m infra.scripts.prepare_workflow_env worker-deploy
}

manage_deploy() {
  ensure_node
  info 'Planning independent Manage Access application'
  python3 -m infra.scripts.deploy_manage plan
  info 'Installing Manage dependencies'
  npm --prefix apps/manage ci
  info 'Building Manage SPA with existing public Sentry settings'
  python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

from infra.scripts.deploy_manage import public_sentry_settings

config = json.loads(Path("infra/gcp/config.local.json").read_text())
dsn, org = public_sentry_settings(config)
env = os.environ.copy()
if dsn:
    env["VITE_MANAGE_SENTRY_DSN"] = dsn
if org:
    env["VITE_MANAGE_SENTRY_ORG"] = org
env["VITE_MANAGE_RELEASE"] = os.environ["RELEASE_SHA"]
subprocess.run(["npm", "--prefix", "apps/manage", "run", "build"], env=env, check=True)
PY
  info 'Deploying separate photointel-manage Worker and runtime secrets'
  python3 -m infra.scripts.deploy_manage apply
}

verify_public() {
  info 'Checking unauthenticated Cloudflare Access redirects'
  python3 -m infra.scripts.cloudflare_setup verify
  info 'HTTP status only; a login in Safari is still required'
  local url
  for url in https://photos.migos.club/ https://photos-manage.migos.club/; do
    curl --max-time 20 -sS -o /dev/null \
      -w "$url -> HTTP %{http_code}\n" "$url" || true
  done
  info 'Cloud Run service URL'
  gcp run services describe photointel-api \
    --region "$REGION" --project "$PROJECT" --format='value(status.url)'
}

case "$MODE" in
  doctor)
    printf 'Active GCP account: '
    gcp auth list --filter='status:ACTIVE' --format='value(account)'
    printf 'Python: '; python3 --version
    printf 'Node: '; command -v node >/dev/null && node --version || true
    printf 'npm: '; command -v npm >/dev/null && npm --version || true
    printf 'gh: '; command -v gh || true
    printf 'tmux: '; command -v tmux || true
    printf 'Local config exists: '; [[ -f "$CONFIG" ]] && echo yes || echo no
    ;;
  *)
    ensure_gcloud
    prepare_config
    case "$MODE" in
      plan)
        python3 -m infra.gcp.manage render
        python3 -m infra.scripts.cloudflare_setup plan
        python3 -m infra.scripts.deploy_manage plan
        ;;
      verify)
        verify_public
        ;;
      all|gcp|cloudflare|web|manage|access)
        confirm_apply
        case "$MODE" in
          all)
            gcp_deploy
            access_apply
            web_deploy
            manage_deploy
            verify_public
            ;;
          gcp) gcp_deploy ;;
          cloudflare) access_apply; web_deploy; manage_deploy; verify_public ;;
          web) access_apply; web_deploy; verify_public ;;
          manage) manage_deploy ;;
          access) access_apply; verify_public ;;
        esac
        info "SUCCESS: $MODE completed"
        ;;
    esac
    ;;
esac
