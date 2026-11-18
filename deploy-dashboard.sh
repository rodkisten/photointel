#!/usr/bin/env bash
set -Eeuo pipefail
# Persistent terminal dashboard for deploy-manage.sh.
MODE="${1:---deploy}"
case "$MODE" in --deploy|--build-only|--install-only) ;; *) echo "Modo inválido: $MODE" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v tmux >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends tmux
  else
    echo "tmux ausente; instale-o ou configure sudo" >&2
    exit 1
  fi
fi
SESSION=photointel-deploy
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi
WORK="$(mktemp -d /tmp/photointel-deploy.XXXXXXXX)"
chmod 700 "$WORK"
printf '0|Aguardando início\n' > "$WORK/state"
cat > "$WORK/runner.sh" <<'RUNNER'
#!/usr/bin/env bash
set -o pipefail
ROOT="$1"
MODE="$2"
WORK="$3"
# Display phase markers from the actual deployment output.
bash "$ROOT/deploy-manage.sh" "$MODE" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    *"Verificando dependências Debian"*) printf '1|Debian\n' > "$WORK/state" ;;
    *"nvm "*"Node.js"*) printf '2|Node 24\n' > "$WORK/state" ;;
    *"Sincronizando main"*) printf '3|Git main\n' > "$WORK/state" ;;
    *"Instalando dependências com lockfile"*) printf '4|npm ci\n' > "$WORK/state" ;;
    *"TypeScript + Vite"*) printf '5|Build Vite\n' > "$WORK/state" ;;
    *"Verificando GCP"*) printf '6|GCP\n' > "$WORK/state" ;;
    *"Publicando Manage"*) printf '7|Cloudflare\n' > "$WORK/state" ;;
    *"Deploy finalizado"*) printf '8|Concluído\n' > "$WORK/state" ;;
    *"Falha na linha"*|*"Manage deploy failed"*) printf '99|Falhou\n' > "$WORK/state" ;;
  esac
done
result=${PIPESTATUS[0]}
if ((result != 0)); then printf '99|Falhou (exit %s)\n' "$result" > "$WORK/state"; fi
printf '\nProcesso encerrado (exit %s). Ctrl+B, D desconecta.\n' "$result"
exec bash
RUNNER
cat > "$WORK/dashboard.sh" <<'DASH'
#!/usr/bin/env bash
WORK="$1"
while :; do
  IFS='|' read -r stage label < "$WORK/state"
  clear
  printf '\033[1;35m╭──────────────────────────────────────────╮\n'
  printf '│       ✦ PHOTOINTEL · DEPLOY ✦          │\n'
  printf '╰──────────────────────────────────────────╯\033[0m\n\n'
  if [[ "$stage" == 99 ]]; then
    printf '\033[1;31m✗ %s\033[0m\n' "$label"
  else
    count=$stage
    ((count > 7)) && count=7
    bar=''
    for ((i=0;i<7;i++)); do
      if ((i<count)); then bar+='━━━'; else bar+='┄┄┄'; fi
    done
    printf '\033[1;35m%s\033[0m\n' "$bar"
    printf '\n%s / 7 etapas · %s\n' "$count" "$label"
  fi
  printf '\n\033[2mCtrl+B, D: desconectar | tmux attach -t photointel-deploy\033[0m\n'
  sleep 1
done
DASH
chmod 700 "$WORK/"*.sh
tmux new-session -d -s "$SESSION" -n deploy "bash '$WORK/runner.sh' '$ROOT' '$MODE' '$WORK'"
tmux split-window -v -t "$SESSION:0" -l 11 "bash '$WORK/dashboard.sh' '$WORK'"
tmux select-pane -t "$SESSION:0.0"
exec tmux attach -t "$SESSION"
