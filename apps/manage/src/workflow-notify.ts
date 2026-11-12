import { readNotificationSettings } from './notification-settings';
import { redact } from './auth';
import type { Env } from './auth';
import { gh } from './providers';
import { DEFAULT_TEMPLATE, renderWorkflowMessage } from './workflow-message';

type Obj = Record<string, unknown>;
const items = (data: unknown, key: string): Obj[] => {
  const value = (data as Obj | null)?.[key];
  return Array.isArray(value) ? value as Obj[] : [];
};
async function failureLog(env: Env, jobId: unknown): Promise<string> {
  if (!Number.isSafeInteger(Number(jobId)) || Number(jobId) <= 0 || !env.GITHUB_API_TOKEN) return '';
  const repo = env.GITHUB_REPO || 'rodkisten/photointel';
  const response = await fetch('https://api.github.com/repos/' + repo + '/actions/jobs/' + jobId + '/logs', {
    redirect: 'manual', signal: AbortSignal.timeout(9000),
    headers: { Authorization: 'Bearer ' + env.GITHUB_API_TOKEN, Accept: 'application/vnd.github+json' },
  });
  if (response.status !== 302) return '';
  const location = response.headers.get('location');
  if (!location) return '';
  const target = new URL(location);
  if (target.protocol !== 'https:' ||
    !(target.hostname.endsWith('.actions.githubusercontent.com') ||
      target.hostname.endsWith('.githubusercontent.com'))) return '';
  const logs = await fetch(target.href, { redirect: 'manual', signal: AbortSignal.timeout(9000) });
  if (!logs.ok || Number(logs.headers.get('content-length') || 0) > 400_000) return '';
  const raw = (await logs.text()).slice(-100_000);
  const lines = raw.split('\n').filter(line =>
    /(?:^|\s)(?:error|fatal|failed|exception|permission denied|traceback)(?:\s|:|$)/i.test(line));
  return redact((lines.slice(-6).join('\n') || raw.split('\n').slice(-4).join('\n')).slice(-900));
}
export async function sendWorkflowFailure(env: Env, runId: number): Promise<void> {
  if (!env.XRELAY_NOTIFICATION_URL || !env.XRELAY_NOTIFICATION_TOKEN) return;
  const run = await gh(env, '/actions/runs/' + runId) as Obj;
  if (run.conclusion !== 'failure') return;
  const notificationSettings = await readNotificationSettings(env);
  if (!notificationSettings.events.includes('workflow_failure')) return;
  const jobs = items(await gh(env, '/actions/runs/' + runId + '/jobs?per_page=100'), 'jobs');
  const job = jobs.find(value => value.conclusion === 'failure');
  const steps = Array.isArray(job?.steps) ? job.steps as Obj[] : [];
  const step = steps.find(value => value.conclusion === 'failure');
  const errorLog = await failureLog(env, job?.id).catch(() => '');
  const url = String(run.html_url || '');
  const repo = env.GITHUB_REPO || 'rodkisten/photointel';
  const message = renderWorkflowMessage(notificationSettings.template || DEFAULT_TEMPLATE, {
    workflow: String(run.name || 'Workflow'), run_number: String(run.run_number || ''),
    run_id: String(runId), job: String(job?.name || 'Não identificado'),
    step: String(step?.name || 'Não identificada'), error: errorLog || 'Logs indisponíveis. Consulte a execução.',
    diagnosis: /permission denied|403|iam/i.test(errorLog) ? 'Possível falha de permissões; verifique IAM e tokens.' : 'Causa ainda não confirmada', url, repository: repo,
    branch: String(run.head_branch || ''), sha: String(run.head_sha || '').slice(0, 8),
    status: 'failure',
  });
  const endpoint = new URL(env.XRELAY_NOTIFICATION_URL);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.migos.club') ||
    endpoint.username || endpoint.password || endpoint.hash)
    throw new Error('Relay URL inválida');
  const response = await fetch(endpoint.href, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + env.XRELAY_NOTIFICATION_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: redact(message).slice(0, 3900), notification_key: 'workflow:' + repo + ':' + runId,
      sequence: Number(run.run_attempt || 1) * 100000 + 99999,
      delete_after_minutes: notificationSettings.retentionMinutes.error,
      chat_id: env.XRELAY_CHAT_ID || undefined,
      buttons: [[{ text: '📋 Logs', url }, {
        text: '🔧 Manage', url: 'https://photos-manage.migos.club/deploys/' + runId,
      }]],
    }),
  });
  if (!response.ok) throw new Error('Relay notification HTTP ' + response.status);
}
