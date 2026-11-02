/**
 * Decide which running systems must be reconciled after a GCP_CONFIG_ENV edit.
 * This is a strict allowlisted deployment planner, never an arbitrary workflow executor.
 * Config changes never trigger Docker builds, database migrations or admin IAM.
 */
export type ConfigTarget = 'api' | 'jobs' | 'worker' | 'manage';
export type ConfigPlan = {
  changed: string[];
  targets: ConfigTarget[];
  manual: string[];
  blocked: boolean;
  workflows: Array<{ file: string; label: string; inputs: Record<string, string> }>;
};

function flatten(value: unknown, prefix = '', result: Record<string, string> = {}): Record<string, string> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? prefix + '.' + key : key, result);
    }
  } else {
    result[prefix] = JSON.stringify(value);
  }
  return result;
}

function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error('Linha .env não reconhecida; não é seguro aplicar automaticamente.');
    const name = match[1];
    if (Object.prototype.hasOwnProperty.call(result, name))
      throw new Error('Variável .env duplicada; não é seguro aplicar automaticamente.');
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    result[name] = value.startsWith('json:') ? JSON.stringify(JSON.parse(value.slice(5))) : value;
  }
  return result;
}

export function parseConfiguration(raw: string): Record<string, string> {
  if (raw.trim().startsWith('{')) return flatten(JSON.parse(raw));
  return parseDotenv(raw);
}

export function planConfigChange(before: string, after: string): ConfigPlan {
  const oldConfig = parseConfiguration(before);
  const newConfig = parseConfiguration(after);
  const changed = [...new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)])]
    .filter((key) => oldConfig[key] !== newConfig[key])
    .sort();
  const targets = new Set<ConfigTarget>();
  const manual = new Set<string>();
  let blocked = false;
  const add = (...items: ConfigTarget[]) => items.forEach((target) => targets.add(target));
  for (const key of changed) {
    const normalized = key.replaceAll('__', '.').toLowerCase();
    if (/^(?:gcp_(?:bootstrap_)?(?:workload_identity_provider|service_account)|bootstrap_)/.test(key.toLowerCase())) {
      manual.add('Identidade GitHub/GCP: requer revisão do Workload Identity Federation.');
      blocked = true;
      continue;
    }
    if (/^(?:project_id|region|repository|image|release_git_sha|release_branch)$/.test(normalized)) {
      manual.add('Projeto, região ou imagem Docker: alteração de infraestrutura exige deploy manual.');
      blocked = true;
      continue;
    }
    if (/^(?:scheduler_timezone|discovery_schedule|worker_schedule|maintenance_schedule)$/.test(normalized)) {
      manual.add('Agendamentos Cloud Scheduler: executar Scheduler manualmente para evitar pausas inesperadas.');
      continue;
    }
    if (normalized.startsWith('workflow_secrets.')) {
      if (/^workflow_secrets\.manage_[a-z0-9_]+\.(?:name|version)$/.test(normalized)) add('manage');
      else if (/^workflow_secrets\.cloudflare_[a-z0-9_]+\.(?:name|version)$/.test(normalized)) add('worker', 'manage');
      else manual.add('Referências de credenciais de workflow: verificar IAM/Secret Manager manualmente.');
      if (/\.name$/.test(normalized)) {
        manual.add('Novos containers de credenciais de workflow exigem IAM antes de publicar.');
        blocked = true;
      } else if (/\.version$/.test(normalized)) {
        manual.add('Confirme que a versão do secret já existe no Secret Manager.');
      }
      continue;
    }
    if (normalized.startsWith('secrets.')) {
      add('api', 'jobs');
      if (/\.name$/.test(normalized)) {
        manual.add('Novo nome de segredo: executar Setup GCP → permissions antes da sincronização.');
        blocked = true;
      }
      if (/migration_database_url/.test(normalized))
        manual.add('Credencial de migração: verificar manualmente; migrações nunca são automáticas.');
      continue;
    }
    // Top-level Telegram fields are canonicalized into extra_environment by
    // gcp-env.py. They still need an API/jobs runtime sync on save.
    if (/^telegram_notification_(?:api_token|url|chat_id)$/.test(normalized)) {
      add('api', 'jobs');
      continue;
    }
    if (normalized === 'telegram_job_events_enabled') {
      manual.add('TELEGRAM_JOB_EVENTS_ENABLED é calculado automaticamente; override ignorado.');
      continue;
    }
    if (normalized.startsWith('extra_environment.')) {
      const field = normalized.slice('extra_environment.'.length);
      // The deployment renderer injects extra_environment into all Cloud Run envs.
      add('api', 'jobs');
      if (field.startsWith('vite_') || field.startsWith('worker_')) add('worker');
      if (field.startsWith('manage_') || field === 'sentry_org') add('manage');
      if (field === 'manage_access_allowed_emails') {
        manual.add('Allowlist Manage: executar Setup GCP → permissions para atualizar a federação WIF.');
        blocked = true;
      }
      continue;
    }
    if (/^workflows\./.test(normalized)) {
      add('worker');
      continue;
    }
    if (/^api_(?:max_instances|concurrency|timeout_seconds)$/.test(normalized)) {
      add('api');
      continue;
    }
    if (/^job_(?:task_count|parallelism|max_jobs|deadline_seconds|timeout_seconds)$/.test(normalized)) {
      add('jobs');
      continue;
    }
    if (normalized === 'frontend_origin') add('api', 'jobs', 'worker');
    else if (/^(?:access_team_domain|access_audience|access_allowed_emails)$/.test(normalized))
      add('api', 'jobs', 'worker', 'manage');
    else if (normalized === 'api_origin' || /^(?:storage_|database_|icloud_|enable_|catalog_)/.test(normalized))
      add('api', 'jobs');
    else {
      // Unsupported/unknown schema field: save is allowed, but avoid guessing an
      // automatic deployment that could mutate unrelated services.
      manual.add('Campo não classificado (' + key.slice(0, 100) + '): revisão manual necessária.');
      blocked = true;
    }
  }
  const ordered: ConfigTarget[] = ['jobs', 'api', 'worker', 'manage'];
  const selected = ordered.filter((target) => targets.has(target));
  const workflows: ConfigPlan['workflows'] = [];
  if (targets.has('api') || targets.has('jobs')) {
    workflows.push({
      file: 'config-sync.yml', label: 'Cloud Run · configuração sem Docker',
      inputs: {
        targets: [targets.has('jobs') ? 'jobs' : '', targets.has('api') ? 'api' : '']
          .filter(Boolean).join(','),
      },
    });
  }
  if (targets.has('worker'))
    workflows.push({ file: 'deploy-worker.yml', label: 'Cloudflare · frontend e Worker', inputs: {} });
  if (targets.has('manage'))
    workflows.push({ file: 'manage-deploy.yml', label: 'Manage · publicar painel', inputs: { mode: 'apply' } });
  return { changed, targets: selected, manual: [...manual], blocked, workflows };
}
