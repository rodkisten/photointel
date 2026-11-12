import { ApiError, bodyJson, json } from './auth';
import type { Env } from './auth';
import { gh } from './providers';

export const NOTIFICATION_EVENTS = ['workflow_started', 'workflow_success', 'workflow_failure', 'workflow_recovered', 'deploy_failed', 'job_failed'] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];
export type NotificationSettings = {
  events: NotificationEvent[];
  grouping: 'window' | 'run' | 'none';
  windowMinutes: number;
  updateMode: 'edit' | 'new';
  retentionMinutes: { running: number; success: number; error: number };
  template: string;
};
const VARIABLE = '/actions/variables/PHOTOINTEL_NOTIFICATION_SETTINGS';
export const DEFAULT_SETTINGS: NotificationSettings = {
  events: ['workflow_failure', 'workflow_recovered', 'deploy_failed', 'job_failed'],
  grouping: 'window', windowMinutes: 5, updateMode: 'edit',
  retentionMinutes: { running: 30, success: 60, error: 0 },
  template: '❌ {{workflow}} #{{run_number}}\nJob: {{job}}\nEtapa: {{step}}\nErro: {{error}}\nDiagnóstico: {{diagnosis}}\n{{url}}',
};
export function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'NOTIFICATIONS', 'Configuração inválida');
  const v = value as Record<string, unknown>;
  const events = v.events;
  const retention = v.retentionMinutes as Record<string, unknown> | undefined;
  if (!Array.isArray(events) || events.some(x => !NOTIFICATION_EVENTS.includes(x)) ||
    !['window', 'run', 'none'].includes(String(v.grouping)) ||
    ![2, 5, 10].includes(Number(v.windowMinutes)) ||
    !['edit', 'new'].includes(String(v.updateMode)) ||
    !retention || ['running', 'success', 'error'].some(k =>
      !Number.isSafeInteger(retention[k]) || Number(retention[k]) < 0 || Number(retention[k]) > 43200) ||
    typeof v.template !== 'string' || !v.template.trim() || v.template.length > 3500)
    throw new ApiError(422, 'NOTIFICATIONS', 'Eventos, janela, retenção ou template inválidos');
  return { events: [...new Set(events)] as NotificationEvent[], grouping: v.grouping as NotificationSettings['grouping'],
    windowMinutes: Number(v.windowMinutes), updateMode: v.updateMode as NotificationSettings['updateMode'],
    retentionMinutes: { running: Number(retention.running), success: Number(retention.success), error: Number(retention.error) },
    template: v.template };
}
export async function readNotificationSettings(env: Env): Promise<NotificationSettings> {
  const saved = await gh(env, VARIABLE).catch(() => null) as { value?: string } | null;
  if (!saved?.value) return DEFAULT_SETTINGS;
  try { return validateNotificationSettings(JSON.parse(saved.value)); }
  catch { return DEFAULT_SETTINGS; }
}
export async function notificationSettingsRoute(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/notifications/settings') return null;
  if (request.method === 'GET') return json({ settings: await readNotificationSettings(env), events: NOTIFICATION_EVENTS });
  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  const input = await bodyJson<{ settings?: unknown }>(request, 10000);
  const settings = validateNotificationSettings(input.settings);
  const exists = await gh(env, VARIABLE).then(() => true).catch(() => false);
  await gh(env, exists ? VARIABLE : '/actions/variables', exists ? 'PATCH' : 'POST',
    { name: 'PHOTOINTEL_NOTIFICATION_SETTINGS', value: JSON.stringify(settings) });
  return json({ ok: true, settings });
}
