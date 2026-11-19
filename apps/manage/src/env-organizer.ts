import { optimizeDotenv, parseConfiguration } from './config-reconcile';

export type EnvOrganization = {
  value: string;
  changes: string[];
  warnings: string[];
  diff: string;
  safe: boolean;
};

type GroupedEntry = {
  key: string;
  lines: string[];
};

// TODO extract to file src/config/dotenv-groups.ts
const DOTENV_ORGANIZER_CONFIG = {
  FALLBACK_GROUP: 'OTHER SETTINGS',
  COMMENT_PREFIX: '#',
  HEADER_PREFIX: '# ',
  JSON_START_TOKEN: '{',
  LINE_BREAK_REGEX: /\r?\n/,
  ASSIGNMENT_REGEX: /^(?:\s*export\s+|\s*)([A-Za-z][A-Za-z0-9_]*)\s*=/,
  DIFF_HEADERS: {
    ORIGINAL: '--- original',
    ORGANIZED: '+++ organizado',
  },
  GROUPS: [
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
  ] as const,
} as const;

const ALL_GROUP_NAMES: readonly string[] = [
  ...DOTENV_ORGANIZER_CONFIG.GROUPS.map(([name]) => name),
  DOTENV_ORGANIZER_CONFIG.FALLBACK_GROUP,
];

const GROUP_HEADER_SET = new Set(
  ALL_GROUP_NAMES.map((name) => `${DOTENV_ORGANIZER_CONFIG.HEADER_PREFIX}${name}`),
);

// TODO extract to file src/utils/dotenv-organizer-helpers.ts
function groupOf(key: string): string {
  return (
    DOTENV_ORGANIZER_CONFIG.GROUPS.find(([, pattern]) => pattern.test(key))?.[0] ||
    DOTENV_ORGANIZER_CONFIG.FALLBACK_GROUP
  );
}

function abortOrganization(raw: string, warning: string): EnvOrganization {
  return {
    value: raw,
    changes: [],
    warnings: [warning],
    diff: '',
    safe: false,
  };
}

function areConfigurationsEqual(
  before: Record<string, string>,
  after: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) return false;
  }
  return true;
}

function buildLineDiff(beforeRaw: string, afterRaw: string): string {
  const beforeLines = beforeRaw.split(DOTENV_ORGANIZER_CONFIG.LINE_BREAK_REGEX);
  const afterLines = afterRaw.split(DOTENV_ORGANIZER_CONFIG.LINE_BREAK_REGEX);

  return [
    DOTENV_ORGANIZER_CONFIG.DIFF_HEADERS.ORIGINAL,
    DOTENV_ORGANIZER_CONFIG.DIFF_HEADERS.ORGANIZED,
    ...beforeLines.map((line) => `- ${line}`),
    ...afterLines.map((line) => `+ ${line}`),
  ].join('\n');
}

function formatGroupedOutput(
  groups: Map<string, GroupedEntry[]>,
  trailingComments: string[],
): string {
  const output: string[] = [];

  for (const name of ALL_GROUP_NAMES) {
    const entries = groups.get(name);
    if (!entries?.length) continue;

    output.push(`${DOTENV_ORGANIZER_CONFIG.HEADER_PREFIX}${name}`);
    const sortedEntries = [...entries].sort((a, b) => a.key.localeCompare(b.key));

    for (const entry of sortedEntries) {
      const attached = entry.lines.filter(
        (line, index, all) => line.trim() || (index > 0 && index < all.length - 1),
      );
      // Do not repeat a pre-existing group title when moving assignments.
      output.push(...attached.filter((line) => !GROUP_HEADER_SET.has(line.trim())));
    }
    output.push('');
  }

  if (trailingComments.length) {
    output.push(...trailingComments);
  }

  return `${output.join('\n').trimEnd()}\n`;
}

// TODO extract to file src/config/dotenv-organizer.ts
/** Only produce a proposal if the effective configuration is unchanged. */
export function organizeEnvironment(raw: string): EnvOrganization {
  if (raw.trimStart().startsWith(DOTENV_ORGANIZER_CONFIG.JSON_START_TOKEN)) {
    return abortOrganization(raw, 'Organização disponível apenas para dotenv.');
  }

  let original: Record<string, string>;
  try {
    original = parseConfiguration(raw);
  } catch (error) {
    return abortOrganization(raw, String(error));
  }

  const optimized = optimizeDotenv(raw);
  const warnings = [...optimized.warnings];
  const groups = new Map<string, GroupedEntry[]>();
  const lines = optimized.value.split(DOTENV_ORGANIZER_CONFIG.LINE_BREAK_REGEX);

  let pending: string[] = [];
  let count = 0;

  for (const line of lines) {
    const match = DOTENV_ORGANIZER_CONFIG.ASSIGNMENT_REGEX.exec(line);
    if (match) {
      const key = match[1];
      const group = groupOf(key);
      const entries = groups.get(group) || [];
      entries.push({ key, lines: [...pending, line] });
      groups.set(group, entries);
      pending = [];
      count++;
    } else {
      const trimmed = line.trim();
      // Existing comments stay attached to their next assignment.
      // An unknown directive is never reordered.
      if (trimmed && !trimmed.startsWith(DOTENV_ORGANIZER_CONFIG.COMMENT_PREFIX)) {
        return abortOrganization(raw, 'Linha não reconhecida: organização cancelada.');
      }
      pending.push(line);
    }
  }

  if (!count) {
    return abortOrganization(raw, 'Nenhuma variável encontrada.');
  }

  const trailingComments = pending.filter((line) => line.trim());
  const value = formatGroupedOutput(groups, trailingComments);

  try {
    const after = parseConfiguration(value);
    if (!areConfigurationsEqual(original, after)) {
      return abortOrganization(
        raw,
        'A organização alteraria valores resolvidos; operação cancelada.',
      );
    }
  } catch (error) {
    return abortOrganization(
      raw,
      `A organização não passou na validação: ${String(error)}`,
    );
  }

  return {
    value,
    changes: [...optimized.changes, `Agrupadas ${count} variáveis em blocos comentados`],
    warnings,
    diff: buildLineDiff(raw, value),
    safe: true,
  };
}
