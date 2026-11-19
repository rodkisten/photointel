import yaml from 'js-yaml';
import { githubToken } from './github-app';
import { ApiError, json } from './auth';
import type { Env } from './auth';
import { validateNotificationSettings, type NotificationSettings } from './notification-settings';

export type NotifySource = 'default' | 'repository' | 'manage';
export type NotifyConflict = {
  path: string;
  repository: unknown;
  manage: unknown;
  resolvedBy: 'repository' | 'manage' | null;
};
export type NotifyResolution = {
  settings: NotificationSettings;
  sources: Record<string, NotifySource>;
  conflicts: NotifyConflict[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const FIELDS = new Set(['events', 'grouping', 'windowSeconds', 'updateMode', 'retentionMinutes', 'template']);

export function parseNotifyYaml(source: string): Partial<NotificationSettings> {
  if (source.length > 32_768) throw new Error('notify.yml exceeds 32 KiB');
  const document: unknown = yaml.load(source, { json: false });
  if (!isRecord(document)) throw new Error('notify.yml must contain a mapping');
  if (document.version !== 1) throw new Error('notify.yml requires version: 1');
  const settings = document.notifications ?? document.settings;
  if (!isRecord(settings)) throw new Error('notify.yml requires notifications mapping');
  for (const key of Object.keys(settings)) {
    if (FORBIDDEN.has(key) || !FIELDS.has(key)) throw new Error('Unknown notification field: ' + key);
  }
  if (settings.retentionMinutes !== undefined) {
    if (!isRecord(settings.retentionMinutes)) throw new Error('retentionMinutes must be a mapping');
    for (const key of Object.keys(settings.retentionMinutes)) {
      if (FORBIDDEN.has(key) || !['running', 'success', 'error'].includes(key))
        throw new Error('Unknown retention field: ' + key);
    }
  }
  return settings as Partial<NotificationSettings>;
}

function flatten(value: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, child]) => {
    if (FORBIDDEN.has(key)) throw new Error('Unsafe configuration key');
    const path = prefix ? prefix + '.' + key : key;
    return isRecord(child) ? flatten(child, path) : [[path, child] as [string, unknown]];
  });
}

function assignPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

export function resolveNotifySettings(
  defaults: NotificationSettings,
  repository: Partial<NotificationSettings>,
  manage: Partial<NotificationSettings> = {},
  choices: Record<string, 'repository' | 'manage'> = {},
): NotifyResolution {
  const output = structuredClone(defaults) as unknown as Record<string, unknown>;
  const sources: Record<string, NotifySource> = {};
  const repoFields = new Map(flatten(repository as Record<string, unknown>));
  const manageFields = new Map(flatten(manage as Record<string, unknown>));
  const conflicts: NotifyConflict[] = [];
  for (const [path, value] of repoFields) {
    assignPath(output, path, value);
    sources[path] = 'repository';
  }
  for (const [path, value] of manageFields) {
    const repoValue = repoFields.get(path);
    const conflict = repoFields.has(path) && JSON.stringify(repoValue) !== JSON.stringify(value);
    const resolvedBy = conflict ? choices[path] ?? null : null;
    if (conflict) conflicts.push({ path, repository: repoValue, manage: value, resolvedBy });
    if (!conflict || resolvedBy === 'manage') {
      assignPath(output, path, value);
      sources[path] = 'manage';
    }
  }
  return { settings: validateNotificationSettings(output), sources, conflicts };
}

const REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export async function readRepositoryNotifyYaml(
  env: Env,
  repository: string,
): Promise<{ found: boolean; config: Partial<NotificationSettings>; sha?: string }> {
  if (!REPOSITORY_PATTERN.test(repository)) throw new ApiError(422, 'NOTIFY_REPO', 'Repositório inválido');
  const token = await githubToken(env);
  const response = await fetch(
    `https://api.github.com/repos/${repository}/contents/notify.yml`,
    { headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PhotoIntel-Manage',
    }, redirect: 'manual', signal: AbortSignal.timeout(12000) },
  );
  if (response.status === 404) return { found: false, config: {} };
  if (!response.ok) throw new ApiError(503, 'NOTIFY_GITHUB', 'Não foi possível ler notify.yml do GitHub (HTTP ' + response.status + ')');
  const content = await response.text();
  return { found: true, config: parseNotifyYaml(content), sha: response.headers.get('etag') ?? undefined };
}

/** Read-only repository config endpoint. The UI resolves conflicts before applying overrides. */
export async function repositoryNotifyRoute(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/notifications/repository') return null;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const repository = new URL(request.url).searchParams.get('repository') || env.GITHUB_REPO;
  const allowed = new Set([env.GITHUB_REPO, ...(env.MANAGE_PROJECT_REPOSITORIES || '').split(',').map(x => x.trim())]);
  if (!allowed.has(repository)) throw new ApiError(403, 'NOTIFY_REPO', 'Repositório fora da allowlist');
  const result = await readRepositoryNotifyYaml(env, repository);
  return json({ repository, ...result });
}
