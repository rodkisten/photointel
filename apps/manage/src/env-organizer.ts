import { optimizeDotenv, parseConfiguration } from './config-reconcile';

export type EnvOrganization = {
  value: string;
  changes: string[];
  warnings: string[];
  diff: string;
  safe: boolean;
};

const GROUPS = [
  ['GOOGLE CLOUD', /^(?:PROJECT_ID|REGION|REPOSITORY|GCP_|BOOTSTRAP_|RELEASE_)/],
  ['CLOUDFLARE', /^(?:CF__|CLOUDFLARE_|ACCESS_|FRONTEND_ORIGIN|API_ORIGIN)/],
  ['STORAGE', /^(?:STORAGE_|R2_)/],
  ['DATABASE', /^(?:DATABASE_|NEON_)/],
  ['WORKFLOWS', /^(?:WF__|WORKFLOWS__)/],
  ['WORKFLOW SECRETS', /^(?:WORKFLOW_SECRET__|WORKFLOW_SECRETS__)/],
  ['SECRET MANAGER', /^(?:SECRET__|SECRETS__)/],
  ['EXTRA ENVIRONMENT', /^(?:ENV__|EXTRA_ENVIRONMENT__|EXTRA_ENV__)/],
  ['MEDIA & GPU', /^(?:MEDIA_|MODAL_|GPU_|JOYTAG_|SIGLIP_)/],
  ['NOTIFICATIONS & OBSERVABILITY', /^(?:SENTRY_|TELEGRAM_|NOTIFY_)/],
] as const;

function groupOf(key: string): string {
  return GROUPS.find(([, pattern]) => pattern.test(key))?.[0] || 'OTHER SETTINGS';
}

function normalizedEntries(raw: string): Record<string, string> {
  return parseConfiguration(raw);
}

/** Only produce a proposal if the effective configuration is unchanged. */
export function organizeEnvironment(raw: string): EnvOrganization {
  const warnings: string[] = [];
  if (raw.trimStart().startsWith('{')) {
    return { value: raw, changes: [], warnings: ['Organização disponível apenas para dotenv.'], diff: '', safe: false };
  }
  let original: Record<string, string>;
  try {
    original = normalizedEntries(raw);
  } catch (error) {
    return { value: raw, changes: [], warnings: [String(error)], diff: '', safe: false };
  }

  const optimized = optimizeDotenv(raw);
  warnings.push(...optimized.warnings);
  const groups = new Map<string, Array<{ key: string; lines: string[] }>>();
  const lines = optimized.value.split(/\r?\n/);
  const header: string[] = [];
  let pending: string[] = [];
  let count = 0;
  const assignment = /^(?:\s*export\s+|\s*)([A-Za-z][A-Za-z0-9_]*)\s*=/;
  const flush = (key: string, line: string) => {
    const group = groupOf(key);
    const entries = groups.get(group) || [];
    entries.push({ key, lines: [...pending, line] });
    groups.set(group, entries);
    pending = [];
    count++;
  };
  for (const line of lines) {
    const match = assignment.exec(line);
    if (match) {
      flush(match[1], line);
    } else {
      // Existing comments stay attached to their next assignment.
      // An unknown directive is never reordered.
      if (line.trim() && !line.trimStart().startsWith('#')) {
        return { value: raw, changes: [], warnings: ['Linha não reconhecida: organização cancelada.'], diff: '', safe: false };
      }
      pending.push(line);
    }
  }
  if (!count) return { value: raw, changes: [], warnings: ['Nenhuma variável encontrada.'], diff: '', safe: false };
  if (pending.some(line => line.trim())) header.push(...pending.filter(line => line.trim()));
  const output: string[] = [];
  for (const [name] of [...GROUPS.map(([name]) => [name] as const), ['OTHER SETTINGS'] as const]) {
    const entries = groups.get(name);
    if (!entries?.length) continue;
    output.push('# ' + name);
    for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key))) {
      const attached = entry.lines.filter((line, index, all) =>
        line.trim() || (index > 0 && index < all.length - 1));
      // Do not repeat a pre-existing group title when moving assignments.
      output.push(...attached.filter(line => !/^# (?:GOOGLE CLOUD|CLOUDFLARE|STORAGE|DATABASE|WORKFLOWS|WORKFLOW SECRETS|SECRET MANAGER|EXTRA ENVIRONMENT|MEDIA & GPU|NOTIFICATIONS & OBSERVABILITY|OTHER SETTINGS)$/.test(line.trim())));
    }
    output.push('');
  }
  if (header.length) output.push(...header);
  const value = output.join('\n').trimEnd() + '\n';
  try {
    const after = normalizedEntries(value);
    const keys = [...new Set([...Object.keys(original), ...Object.keys(after)])];
    if (keys.some(key => original[key] !== after[key])) {
      return { value: raw, changes: [], warnings: ['A organização alteraria valores resolvidos; operação cancelada.'], diff: '', safe: false };
    }
  } catch (error) {
    return { value: raw, changes: [], warnings: ['A organização não passou na validação: ' + String(error)], diff: '', safe: false };
  }
  const changes = [...optimized.changes, 'Agrupadas ' + count + ' variáveis em blocos comentados'];
  const beforeLines = raw.split(/\r?\n/);
  const afterLines = value.split(/\r?\n/);
  // Full line-by-line preview (no remote service or persisted secret values).
  const diff = ['--- original', '+++ organizado',
    ...beforeLines.map(line => '- ' + line),
    ...afterLines.map(line => '+ ' + line)].join('\n');
  return { value, changes, warnings, diff, safe: true };
}
