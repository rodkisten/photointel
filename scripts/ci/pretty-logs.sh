#!/usr/bin/env bash
# Source from GitHub Actions steps: source scripts/ci/pretty-logs.sh
# Never pass secret-bearing arguments to ci_run; use environment variables and stdin.

_ci_color() {
  if [[ -t 1 || "${GITHUB_ACTIONS:-}" == true ]] && [[ "${NO_COLOR:-}" != 1 ]]; then
    printf '\033[%sm' "$1"
  fi
}

ci_note() { printf '%sℹ %s%s\n' "$(_ci_color '36')" "$*" "$(_ci_color 0)"; }
ci_ok()   { printf '%s✔ %s%s\n' "$(_ci_color '32')" "$*" "$(_ci_color 0)"; }

ci_warn() {
  printf '%s⚠ %s%s\n' "$(_ci_color '33')" "$*" "$(_ci_color 0)"
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    printf '::warning::%s\n' "$*"
  fi
  return 0
}

ci_fail() {
  printf '%s✖ %s%s\n' "$(_ci_color '31')" "$*" "$(_ci_color 0)" >&2
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    printf '::error::%s\n' "$*" >&2
  fi
  return 0
}

# Links are shown only on failures. URLs are public consoles, never credential-bearing.
ci_help() {
  local command="$1" logfile="${2:-}" hint title url
  local project="${CI_GCP_PROJECT:-photointel}"

  # Project IDs are validated before interpolating them into console links.
  [[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || project=photointel

  local is_state_locked=0
  if [[ -f "$logfile" ]] && grep -Eqi 'Error acquiring the state lock|state lock|Lock Info:' "$logfile"; then
    is_state_locked=1
  fi

  # Python diagnostics live in a standalone module; no embedded Python in Bash.
  if [[ "$command" =~ ^(gcloud|photointel-gcloud|docker|terraform)$ ]] \
     && [[ -f "$logfile" ]] \
     && [[ "$is_state_locked" == 0 ]] \
     && command -v python3 >/dev/null 2>&1 \
     && [[ -f "scripts/ci/gcloud_diagnostics.py" ]]; then
    local -a cloud_diagnosis
    mapfile -t cloud_diagnosis < <(python3 -m scripts.ci.gcloud_diagnostics "$logfile" "$project" "$command" 2>/dev/null || true)
    if (( ${#cloud_diagnosis[@]} == 3 )); then
      printf '%s\n' "${cloud_diagnosis[@]}"
      return 0
    fi
  fi

  local resource="" region=""
  if [[ -f "$logfile" ]]; then
    resource="$(grep -Eo 'photointel-[a-z0-9-]+' "$logfile" | head -n 1 || true)"
    region="$(grep -Eo 'us-(central|east|west)[0-9]+' "$logfile" | head -n 1 || true)"
  fi

  if [[ -f "$logfile" ]] && grep -Eqi 'Resource not accessible by integration|HTTP 403.*integration' "$logfile"; then
    hint="GitHub App HTTP 403: garanta permissão Actions (Read and write) no app instalado, aprove as permissões e tente novamente."
    title="Permissões do GitHub App"
    url="https://github.com/settings/installations"
  elif [[ ! "$command" =~ ^(gcloud|photointel-gcloud|terraform|docker|wrangler)$ ]]; then
    hint="Inspecione a saída do comando e os erros de teste ou dependência reportados."
    title="Execução do workflow"
    url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-rodkisten/photointel}/actions/runs/${GITHUB_RUN_ID:-0}"
  elif [[ "$is_state_locked" == 1 ]]; then
    hint="O state do Terraform está travado (lock). Identifique a execução dona do lock; nunca force unlock em operação ativa."
    title="Terraform state locking"
    url="https://developer.hashicorp.com/terraform/language/state/locking"
  elif [[ -f "$logfile" ]] && grep -Eqi 'RESOURCE_EXHAUSTED|quota exceeded|quota.*exceeded|429 Too Many Requests' "$logfile"; then
    hint="Cota ou limite de requisições atingido. Verifique a cota do serviço afetado antes de tentar novamente."
    title="Cotas do GCP"
    url="https://console.cloud.google.com/iam-admin/quotas?project=$project"
  elif [[ -f "$logfile" ]] && grep -Eqi 'secretmanager|Secret Manager|secrets/[^ ]+' "$logfile" && grep -Eqi '404|NOT_FOUND|not found|permission.denied|403|denied' "$logfile"; then
    hint="Segredo ausente ou acesso negado no Secret Manager. Verifique o nome, versão ativa e IAM da service account."
    title="Secret Manager"
    url="https://console.cloud.google.com/security/secret-manager?project=$project"
  elif [[ -f "$logfile" ]] && grep -Eqi '403|PERMISSION_DENIED|permission denied|does not have permission|not authorized' "$logfile"; then
    hint="Acesso negado (403). Verifique a identidade do workflow e a permissão IAM exata exibida no log."
    title="GCP IAM"
    url="https://console.cloud.google.com/iam-admin/iam?project=$project"
  elif [[ -f "$logfile" ]] && grep -Eqi '404|NOT_FOUND|not found' "$logfile"; then
    hint="Recurso não encontrado (404). Verifique o nome do recurso, projeto, região e se o provisionamento concluiu."
    title="Recursos GCP"
    url="https://console.cloud.google.com/home/dashboard?project=$project"
  else
    case "$command" in
      gcloud|photointel-gcloud)
        hint="Verifique projeto, Workload Identity, papéis IAM e status do recurso."
        title="GCP IAM"
        url="https://console.cloud.google.com/iam-admin/iam?project=$project"
        ;;
      terraform)
        hint="Inspecione o plan, remote state, permissões do provider e drift."
        title="Documentação Terraform"
        url="https://developer.hashicorp.com/terraform/cli"
        ;;
      docker)
        hint="Verifique autenticação no registry, permissões do repositório e digest imutável."
        title="Artifact Registry"
        url="https://console.cloud.google.com/artifacts?project=$project"
        ;;
      wrangler)
        hint="Verifique a conta Cloudflare, escopos do token e ambiente."
        title="Cloudflare"
        url="https://dash.cloudflare.com/"
        ;;
      *)
        hint="Inspecione a saída do CLI e a configuração de ambiente."
        title="Execução do workflow"
        url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-rodkisten/photointel}/actions/runs/${GITHUB_RUN_ID:-0}"
        ;;
    esac
  fi

  if [[ -n "$resource" && "$command" == "gcloud" && "$title" == "Recursos GCP" ]]; then
    title="Recursos Cloud Run"
    url="https://console.cloud.google.com/run?project=$project"
  fi

  printf '%s\n%s\n%s\n' "$hint" "$title" "$url"
}

ci_run() {
  if (( $# < 2 )); then
    ci_fail 'ci_run requires a safe label and a command'
    return 2
  fi

  local label="$1" status start duration
  shift

  # Resolve o comando efetivo mesmo se vier encapsulado em "uv run ..."
  local effective_cmd="$1"
  if [[ "$1" == "uv" && "${2:-}" == "run" && -n "${3:-}" ]]; then
    effective_cmd="$3"
  fi

  ci_note "$label"
  start=$SECONDS

  local logfile
  logfile="$(mktemp)"
  chmod 600 "$logfile"

  local is_test=0
  if [[ "$label" =~ [Tt]est|[Pp]ytest|[Vv]itest|[Jj]est|[Pp]laywright|[Uu]nittest|[Ee]2[Ee] ]] \
     || [[ " $* " =~ [[:space:]](pytest|unittest|vitest|jest|playwright)[[:space:]] ]]; then
    is_test=1
  fi

  if [[ "${GITHUB_ACTIONS:-}" == true && "$is_test" == 0 ]]; then
    printf '::group::📄 Raw output · %s\n' "$label"
  fi

  # Fallback seguro caso python3 ou highlight_output.py não estejam disponíveis no job
  local -a highlighter=(cat)
  if command -v python3 >/dev/null 2>&1 && [[ -f "scripts/ci/highlight_output.py" ]]; then
    highlighter=(python3 -u scripts/ci/highlight_output.py)
  fi

  local -a pipeline_status
  if PHOTOINTEL_CI_RAW_GROUP=1 FORCE_COLOR=1 CLICOLOR_FORCE=1 PY_COLORS=1 "$@" 2>&1 | tee "$logfile" | "${highlighter[@]}"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  status=${pipeline_status[0]}

  if [[ "${GITHUB_ACTIONS:-}" == true && "$is_test" == 0 ]]; then
    printf '::endgroup::\n'
  fi

  duration=$((SECONDS - start))

  if (( status == 0 )); then
    ci_ok "$label concluído em ${duration}s"
  else
    local hint title url
    local -a diagnosis
    mapfile -t diagnosis < <(ci_help "$effective_cmd" "$logfile")
    hint="${diagnosis[0]}"
    title="${diagnosis[1]}"
    url="${diagnosis[2]}"

    ci_fail "$label falhou (exit ${status}, ${duration}s). $hint"

    if [[ -f "$logfile" ]]; then
      printf '::group::🔎 Destaques da falha · %s\n' "$label"
      grep -Ei 'Resource not accessible by integration|HTTP 403|RuntimeError:|JSONDecodeError|Traceback|Error:|permission denied|forbidden|FAILED |[0-9]+ failed' "$logfile" | tail -n 24 || true
      printf '::endgroup::\n'
    fi

    ci_note "Próxima ação: $title ($url)"

    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      {
        printf '\n### ❌ %s\n\n' "$label"
        printf -- '- **Código de saída:** %s · **Duração:** %ss\n' "$status" "$duration"
        printf -- '- **Diagnóstico:** %s\n' "$hint"
        printf '\n<details><summary>🔎 Erros relevantes (até 12 linhas)</summary>\n\n'
        if command -v python3 >/dev/null 2>&1 && [[ -f "scripts/ci/failure_summary.py" ]]; then
          python3 scripts/ci/failure_summary.py "$logfile"
        else
          printf '```\n'
          tail -n 12 "$logfile"
          printf '```\n'
        fi
        printf '\n</details>\n\n'
        printf -- '- **Ação recomendada:** [%s](%s)\n' "$title" "$url"
        printf -- '- **Logs:** [Abrir esta execução](%s/%s/actions/runs/%s)\n' "${GITHUB_SERVER_URL:-https://github.com}" "${GITHUB_REPOSITORY:-rodkisten/photointel}" "${GITHUB_RUN_ID:-0}"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
  fi

  rm -f "$logfile"
  return "$status"
}
