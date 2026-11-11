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


/** Resolve references from this dotenv only, never from process environment. */
export function resolveConfigReferences(entries: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  const active = new Set<string>();
  const has = (key: string) => Object.prototype.hasOwnProperty.call(entries, key);
  const expand = (input: string, depth: number): string => {
    if (depth > 32) throw new Error('Profundidade máxima de referências excedida');
    return input.replace(/\$\$|\$\{([A-Za-z][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}/g,
      (token, name: string | undefined, operator: string | undefined, fallback: string | undefined) => {
        if (token === '$$') return '$';
        if (!has(name!) || (operator === ':-' && !entries[name!])) {
          if (operator) return expand(fallback || '', depth + 1);
          throw new Error('Referência inexistente: ' + name);
        }
        return resolve(name!, depth + 1);
      });
  };
  const resolve = (key: string, depth: number): string => {
    if (Object.prototype.hasOwnProperty.call(resolved, key)) return resolved[key];
    if (active.has(key) || depth > 32) throw new Error('Referência circular: ' + key);
    active.add(key);
    const value = expand(entries[key], depth);
    if (new TextEncoder().encode(value).length > 65536)
      throw new Error('Valor expandido muito grande: ' + key);
    active.delete(key);
    resolved[key] = value;
    return value;
  };
  Object.keys(entries).forEach((key) => resolve(key, 0));
  return resolved;
}

function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error('Linha .env não reconhecida; não é seguro aplicar automaticamente.');
    const name = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    const parsed = value.startsWith('json:') ? JSON.stringify(JSON.parse(value.slice(5))) : value;
    // An identical repeated line is harmless. Preserve original lines and comments.
    // Never silently choose between conflicting values.
    if (Object.prototype.hasOwnProperty.call(result, name) && result[name] !== parsed)
      throw new Error('Variável .env duplicada com valores diferentes: ' + name);
    result[name] = parsed;
  }
  return resolveConfigReferences(result);
}

/** Inspect repeated dotenv keys without rewriting the user's comments or lines. */
export function findDuplicateConfigKeys(raw: string): Array<{ key: string; lines: number[] }> {
  if (raw.trim().startsWith('{')) return [];
  const seen = new Map<string, number[]>();
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (!match) return;
    const lines = seen.get(match[1]) || [];
    lines.push(index + 1);
    seen.set(match[1], lines);
  });
  return [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
}

export function parseConfiguration(raw: string): Record<string, string> {
  if (raw.trim().startsWith('{')) return flatten(JSON.parse(raw));
  return parseDotenv(raw);
}


/** Produce a conservative, comment-preserving proposal. Never discard conflicting values. */
export function optimizeDotenv(raw: string): { value: string; changes: string[]; warnings: string[] } {
  if (raw.trimStart().startsWith('{')) return {
    value: raw, changes: [], warnings: ['O otimizador aceita apenas .env; JSON permanece intacto.'],
  };
  const lines = raw.split(/(\r?\n)/);
  const changes: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const secretNames = new Map<string, { name?: string; version?: string; indices: number[] }>();
  for (let i = 0; i < lines.length; i += 2) {
    const m = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*=\s*)(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, , key, , value] = m;
    if (seen.has(key) && seen.get(key) !== value) warnings.push('Conflito em ' + key + ': preservado.');
    seen.set(key, value);
    const ref = /^(SECRETS|WORKFLOW_SECRETS)__([A-Z][A-Z0-9_]*)__(NAME|VERSION)$/.exec(key);
    if (!ref) continue;
    const id = ref[1] + '__' + ref[2];
    const entry = secretNames.get(id) || { indices: [] };
    entry[ref[3] === 'NAME' ? 'name' : 'version'] = value.trim();
    entry.indices.push(i);
    secretNames.set(id, entry);
  }
  const remove = new Set<number>();
  for (const [id, entry] of secretNames) {
    if (!entry.name || !entry.version || !/^[a-z][a-z0-9-]*$/.test(entry.name) ||
        !/^[1-9][0-9]*$/.test(entry.version) || entry.indices.length !== 2) continue;
    const prefix = id.startsWith('SECRETS__') ? 'SECRET__' : 'WORKFLOW_SECRET__';
    const key = id.split('__')[1];
    const compact = prefix + key;
    if (seen.has(compact) || seen.has(key)) {
      warnings.push('Referência ' + key + ' já possui outra definição; preservada.');
      continue;
    }
    const first = Math.min(...entry.indices);
    const m = /^(\s*(?:export\s+)?)[A-Z][A-Z0-9_]*(\s*=\s*).*$/.exec(lines[first]);
    if (!m) continue;
    lines[first] = m[1] + compact + m[2] + entry.name + '@' + entry.version;
    remove.add(Math.max(...entry.indices));
    changes.push(id + ' → ' + compact);
  }
  const result: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (remove.has(i)) continue;
    result.push(lines[i]);
    if (i + 1 < lines.length) result.push(lines[i + 1]);
  }
  return { value: result.join(''), changes, warnings };
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
    if (normalized === 'manage_sentry_dsn' || normalized === 'extra_environment.manage_sentry_dsn') {
      // A Manage-only Sentry DSN never rebuilds the photo API, workers or images.
      add('manage');
      continue;
    }
    if (
      /^(?:gcp_(?:bootstrap_)?(?:workload_identity_provider|service_account)|bootstrap_)/.test(
        key.toLowerCase(),
      )
    ) {
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
      manual.add(
        'Agendamentos Cloud Scheduler: executar Scheduler manualmente para evitar pausas inesperadas.',
      );
      continue;
    }
    if (normalized.startsWith('cf.')) { add('worker'); continue; }
    if (normalized.startsWith('env.')) { add('api', 'jobs'); continue; }
    if (normalized.startsWith('secret.')) { add('api', 'jobs'); continue; }
    if (normalized.startsWith('workflow_secret.')) {
      manual.add('Referência de workflow: verificar IAM e versão do Secret Manager.');
      blocked = true;
      continue;
    }
    if (normalized.startsWith('workflow_secrets.')) {
      if (/^workflow_secrets\.manage_[a-z0-9_]+\.(?:name|version)$/.test(normalized)) add('manage');
      else if (/^workflow_secrets\.cloudflare_[a-z0-9_]+\.(?:name|version)$/.test(normalized))
        add('worker', 'manage');
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
      // Manage-only values must not trigger unrelated, billable Cloud Run deploys.
      if (field.startsWith('manage_')) {
        add('manage');
        if (field === 'manage_access_allowed_emails') {
          manual.add('Allowlist Manage: executar Setup GCP → permissions para atualizar a federação WIF.');
          blocked = true;
        }
        continue;
      }
      // Other settings may need to be propagated to Cloud Run.
      add('api', 'jobs');
      if (field.startsWith('vite_') || field.startsWith('worker_')) add('worker');
      if (field === 'sentry_org') add('manage');
      continue;
    }
    if (/^(?:workflows|wf)\./.test(normalized)) {
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
    else if (
      normalized === 'api_origin' ||
      /^(?:storage_|database_|icloud_|enable_|catalog_)/.test(normalized)
    )
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
      file: 'config-sync.yml',
      label: 'Cloud Run · configuração sem Docker',
      inputs: {
        targets: [targets.has('jobs') ? 'jobs' : '', targets.has('api') ? 'api' : '']
          .filter(Boolean)
          .join(','),
      },
    });
  }
  if (targets.has('worker'))
    workflows.push({ file: 'deploy-worker.yml', label: 'Cloudflare · frontend e Worker', inputs: {} });
  if (targets.has('manage'))
    workflows.push({
      file: 'manage-deploy.yml',
      label: 'Manage · publicar painel',
      inputs: { mode: 'apply' },
    });
  return { changed, targets: selected, manual: [...manual], blocked, workflows };
}
;
      if (!Object.prototype.hasOwnProperty.call(entries, name!) ||
          (operator === ':-' && !entries[name!])) {
        if (operator) return (fallback || '').replace(pattern, (part, inner: string) =>
          part === '$' ? '
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error('Linha .env não reconhecida; não é seguro aplicar automaticamente.');
    const name = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    const parsed = value.startsWith('json:') ? JSON.stringify(JSON.parse(value.slice(5))) : value;
    // An identical repeated line is harmless. Preserve original lines and comments.
    // Never silently choose between conflicting values.
    if (Object.prototype.hasOwnProperty.call(result, name) && result[name] !== parsed)
      throw new Error('Variável .env duplicada com valores diferentes: ' + name);
    result[name] = parsed;
  }
  return result;
}

/** Inspect repeated dotenv keys without rewriting the user's comments or lines. */
export function findDuplicateConfigKeys(raw: string): Array<{ key: string; lines: number[] }> {
  if (raw.trim().startsWith('{')) return [];
  const seen = new Map<string, number[]>();
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (!match) return;
    const lines = seen.get(match[1]) || [];
    lines.push(index + 1);
    seen.set(match[1], lines);
  });
  return [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
}

export function parseConfiguration(raw: string): Record<string, string> {
  if (raw.trim().startsWith('{')) return flatten(JSON.parse(raw));
  return parseDotenv(raw);
}


/** Produce a conservative, comment-preserving proposal. Never discard conflicting values. */
export function optimizeDotenv(raw: string): { value: string; changes: string[]; warnings: string[] } {
  if (raw.trimStart().startsWith('{')) return {
    value: raw, changes: [], warnings: ['O otimizador aceita apenas .env; JSON permanece intacto.'],
  };
  const lines = raw.split(/(\r?\n)/);
  const changes: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const secretNames = new Map<string, { name?: string; version?: string; indices: number[] }>();
  for (let i = 0; i < lines.length; i += 2) {
    const m = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*=\s*)(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, , key, , value] = m;
    if (seen.has(key) && seen.get(key) !== value) warnings.push('Conflito em ' + key + ': preservado.');
    seen.set(key, value);
    const ref = /^(SECRETS|WORKFLOW_SECRETS)__([A-Z][A-Z0-9_]*)__(NAME|VERSION)$/.exec(key);
    if (!ref) continue;
    const id = ref[1] + '__' + ref[2];
    const entry = secretNames.get(id) || { indices: [] };
    entry[ref[3] === 'NAME' ? 'name' : 'version'] = value.trim();
    entry.indices.push(i);
    secretNames.set(id, entry);
  }
  const remove = new Set<number>();
  for (const [id, entry] of secretNames) {
    if (!entry.name || !entry.version || !/^[a-z][a-z0-9-]*$/.test(entry.name) ||
        !/^[1-9][0-9]*$/.test(entry.version) || entry.indices.length !== 2) continue;
    const prefix = id.startsWith('SECRETS__') ? 'SECRET__' : 'WORKFLOW_SECRET__';
    const key = id.split('__')[1];
    const compact = prefix + key;
    if (seen.has(compact) || seen.has(key)) {
      warnings.push('Referência ' + key + ' já possui outra definição; preservada.');
      continue;
    }
    const first = Math.min(...entry.indices);
    const m = /^(\s*(?:export\s+)?)[A-Z][A-Z0-9_]*(\s*=\s*).*$/.exec(lines[first]);
    if (!m) continue;
    lines[first] = m[1] + compact + m[2] + entry.name + '@' + entry.version;
    remove.add(Math.max(...entry.indices));
    changes.push(id + ' → ' + compact);
  }
  const result: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (remove.has(i)) continue;
    result.push(lines[i]);
    if (i + 1 < lines.length) result.push(lines[i + 1]);
  }
  return { value: result.join(''), changes, warnings };
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
    if (normalized === 'manage_sentry_dsn' || normalized === 'extra_environment.manage_sentry_dsn') {
      // A Manage-only Sentry DSN never rebuilds the photo API, workers or images.
      add('manage');
      continue;
    }
    if (
      /^(?:gcp_(?:bootstrap_)?(?:workload_identity_provider|service_account)|bootstrap_)/.test(
        key.toLowerCase(),
      )
    ) {
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
      manual.add(
        'Agendamentos Cloud Scheduler: executar Scheduler manualmente para evitar pausas inesperadas.',
      );
      continue;
    }
    if (normalized.startsWith('cf.')) { add('worker'); continue; }
    if (normalized.startsWith('env.')) { add('api', 'jobs'); continue; }
    if (normalized.startsWith('secret.')) { add('api', 'jobs'); continue; }
    if (normalized.startsWith('workflow_secret.')) {
      manual.add('Referência de workflow: verificar IAM e versão do Secret Manager.');
      blocked = true;
      continue;
    }
    if (normalized.startsWith('workflow_secrets.')) {
      if (/^workflow_secrets\.manage_[a-z0-9_]+\.(?:name|version)$/.test(normalized)) add('manage');
      else if (/^workflow_secrets\.cloudflare_[a-z0-9_]+\.(?:name|version)$/.test(normalized))
        add('worker', 'manage');
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
      // Manage-only values must not trigger unrelated, billable Cloud Run deploys.
      if (field.startsWith('manage_')) {
        add('manage');
        if (field === 'manage_access_allowed_emails') {
          manual.add('Allowlist Manage: executar Setup GCP → permissions para atualizar a federação WIF.');
          blocked = true;
        }
        continue;
      }
      // Other settings may need to be propagated to Cloud Run.
      add('api', 'jobs');
      if (field.startsWith('vite_') || field.startsWith('worker_')) add('worker');
      if (field === 'sentry_org') add('manage');
      continue;
    }
    if (/^(?:workflows|wf)\./.test(normalized)) {
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
    else if (
      normalized === 'api_origin' ||
      /^(?:storage_|database_|icloud_|enable_|catalog_)/.test(normalized)
    )
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
      file: 'config-sync.yml',
      label: 'Cloud Run · configuração sem Docker',
      inputs: {
        targets: [targets.has('jobs') ? 'jobs' : '', targets.has('api') ? 'api' : '']
          .filter(Boolean)
          .join(','),
      },
    });
  }
  if (targets.has('worker'))
    workflows.push({ file: 'deploy-worker.yml', label: 'Cloudflare · frontend e Worker', inputs: {} });
  if (targets.has('manage'))
    workflows.push({
      file: 'manage-deploy.yml',
      label: 'Manage · publicar painel',
      inputs: { mode: 'apply' },
    });
  return { changed, targets: selected, manual: [...manual], blocked, workflows };
}
 : resolve(inner, depth + 1));
        throw new Error('Referência inexistente: ' + name);
      }
      return resolve(name!, depth + 1);
    });
    if (new TextEncoder().encode(value).length > 65536)
      throw new Error('Valor expandido muito grande: ' + key);
    visiting.delete(key);
    resolved[key] = value;
    return value;
  };
  Object.keys(entries).forEach((key) => resolve(key));
  return resolved;
}

function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error('Linha .env não reconhecida; não é seguro aplicar automaticamente.');
    const name = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    const parsed = value.startsWith('json:') ? JSON.stringify(JSON.parse(value.slice(5))) : value;
    // An identical repeated line is harmless. Preserve original lines and comments.
    // Never silently choose between conflicting values.
    if (Object.prototype.hasOwnProperty.call(result, name) && result[name] !== parsed)
      throw new Error('Variável .env duplicada com valores diferentes: ' + name);
    result[name] = parsed;
  }
  return result;
}

/** Inspect repeated dotenv keys without rewriting the user's comments or lines. */
export function findDuplicateConfigKeys(raw: string): Array<{ key: string; lines: number[] }> {
  if (raw.trim().startsWith('{')) return [];
  const seen = new Map<string, number[]>();
  raw.split(/\r?\n/).forEach((line, index) => {
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (!match) return;
    const lines = seen.get(match[1]) || [];
    lines.push(index + 1);
    seen.set(match[1], lines);
  });
  return [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
}

export function parseConfiguration(raw: string): Record<string, string> {
  if (raw.trim().startsWith('{')) return flatten(JSON.parse(raw));
  return parseDotenv(raw);
}


/** Produce a conservative, comment-preserving proposal. Never discard conflicting values. */
export function optimizeDotenv(raw: string): { value: string; changes: string[]; warnings: string[] } {
  if (raw.trimStart().startsWith('{')) return {
    value: raw, changes: [], warnings: ['O otimizador aceita apenas .env; JSON permanece intacto.'],
  };
  const lines = raw.split(/(\r?\n)/);
  const changes: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const secretNames = new Map<string, { name?: string; version?: string; indices: number[] }>();
  for (let i = 0; i < lines.length; i += 2) {
    const m = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*=\s*)(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, , key, , value] = m;
    if (seen.has(key) && seen.get(key) !== value) warnings.push('Conflito em ' + key + ': preservado.');
    seen.set(key, value);
    const ref = /^(SECRETS|WORKFLOW_SECRETS)__([A-Z][A-Z0-9_]*)__(NAME|VERSION)$/.exec(key);
    if (!ref) continue;
    const id = ref[1] + '__' + ref[2];
    const entry = secretNames.get(id) || { indices: [] };
    entry[ref[3] === 'NAME' ? 'name' : 'version'] = value.trim();
    entry.indices.push(i);
    secretNames.set(id, entry);
  }
  const remove = new Set<number>();
  for (const [id, entry] of secretNames) {
    if (!entry.name || !entry.version || !/^[a-z][a-z0-9-]*$/.test(entry.name) ||
        !/^[1-9][0-9]*$/.test(entry.version) || entry.indices.length !== 2) continue;
    const prefix = id.startsWith('SECRETS__') ? 'SECRET__' : 'WORKFLOW_SECRET__';
    const key = id.split('__')[1];
    const compact = prefix + key;
    if (seen.has(compact) || seen.has(key)) {
      warnings.push('Referência ' + key + ' já possui outra definição; preservada.');
      continue;
    }
    const first = Math.min(...entry.indices);
    const m = /^(\s*(?:export\s+)?)[A-Z][A-Z0-9_]*(\s*=\s*).*$/.exec(lines[first]);
    if (!m) continue;
    lines[first] = m[1] + compact + m[2] + entry.name + '@' + entry.version;
    remove.add(Math.max(...entry.indices));
    changes.push(id + ' → ' + compact);
  }
  const result: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (remove.has(i)) continue;
    result.push(lines[i]);
    if (i + 1 < lines.length) result.push(lines[i + 1]);
  }
  return { value: result.join(''), changes, warnings };
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
    if (normalized === 'manage_sentry_dsn' || normalized === 'extra_environment.manage_sentry_dsn') {
      // A Manage-only Sentry DSN never rebuilds the photo API, workers or images.
      add('manage');
      continue;
    }
    if (
      /^(?:gcp_(?:bootstrap_)?(?:workload_identity_provider|service_account)|bootstrap_)/.test(
        key.toLowerCase(),
      )
    ) {
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
      manual.add(
        'Agendamentos Cloud Scheduler: executar Scheduler manualmente para evitar pausas inesperadas.',
      );
      continue;
    }
    if (normalized.startsWith('cf.')) { add('worker'); continue; }
    if (normalized.startsWith('env.')) { add('api', 'jobs'); continue; }
    if (normalized.startsWith('secret.')) { add('api', 'jobs'); continue; }
    if (normalized.startsWith('workflow_secret.')) {
      manual.add('Referência de workflow: verificar IAM e versão do Secret Manager.');
      blocked = true;
      continue;
    }
    if (normalized.startsWith('workflow_secrets.')) {
      if (/^workflow_secrets\.manage_[a-z0-9_]+\.(?:name|version)$/.test(normalized)) add('manage');
      else if (/^workflow_secrets\.cloudflare_[a-z0-9_]+\.(?:name|version)$/.test(normalized))
        add('worker', 'manage');
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
      // Manage-only values must not trigger unrelated, billable Cloud Run deploys.
      if (field.startsWith('manage_')) {
        add('manage');
        if (field === 'manage_access_allowed_emails') {
          manual.add('Allowlist Manage: executar Setup GCP → permissions para atualizar a federação WIF.');
          blocked = true;
        }
        continue;
      }
      // Other settings may need to be propagated to Cloud Run.
      add('api', 'jobs');
      if (field.startsWith('vite_') || field.startsWith('worker_')) add('worker');
      if (field === 'sentry_org') add('manage');
      continue;
    }
    if (/^(?:workflows|wf)\./.test(normalized)) {
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
    else if (
      normalized === 'api_origin' ||
      /^(?:storage_|database_|icloud_|enable_|catalog_)/.test(normalized)
    )
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
      file: 'config-sync.yml',
      label: 'Cloud Run · configuração sem Docker',
      inputs: {
        targets: [targets.has('jobs') ? 'jobs' : '', targets.has('api') ? 'api' : '']
          .filter(Boolean)
          .join(','),
      },
    });
  }
  if (targets.has('worker'))
    workflows.push({ file: 'deploy-worker.yml', label: 'Cloudflare · frontend e Worker', inputs: {} });
  if (targets.has('manage'))
    workflows.push({
      file: 'manage-deploy.yml',
      label: 'Manage · publicar painel',
      inputs: { mode: 'apply' },
    });
  return { changed, targets: selected, manual: [...manual], blocked, workflows };
}
