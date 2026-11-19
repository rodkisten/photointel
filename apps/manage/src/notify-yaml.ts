import yaml from 'js-yaml';
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
