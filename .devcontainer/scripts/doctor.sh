#!/usr/bin/env bash
set -euo pipefail

printf '\n== Codespaces Mobile Doctor ==\n'
printf '%-14s' 'Shell:'; if command -v zsh >/dev/null 2>&1; then zsh --version; else echo 'MISSING'; fi
for tool in python uv ruff pygmentize node npm pnpm wrangler gcloud gh git jq fzf rg fdfind batcat eza zoxide nano micro shellcheck; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '\033[32mOK\033[0m  %-14s %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '\033[31mMISSING\033[0m %s\n' "$tool"
  fi
done
printf '\nPython: '
if command -v python >/dev/null 2>&1; then python --version; else echo MISSING; fi
printf 'Node: '
if command -v node >/dev/null 2>&1; then node --version; else echo MISSING; fi
printf 'gcloud Python: %s\n' "${CLOUDSDK_PYTHON:-system default}"
printf '\nZsh configuration syntax:\n'
if command -v zsh >/dev/null 2>&1; then
  zsh -n "$HOME/.zshrc" && echo '  .zshrc: OK'
  zsh -n "$HOME/.oh-my-zsh/custom/themes/rod-mobile.zsh-theme" && echo '  theme: OK'
else
  echo '  zsh não instalado'
fi
printf '\nTerminal info: TERM=%s, COLUMNS=%s\n' "${TERM:-unknown}" "${COLUMNS:-unknown}"
printf '\nRun \x27gcloud auth login\x27 and \x27wrangler login\x27 only when needed.\n'
