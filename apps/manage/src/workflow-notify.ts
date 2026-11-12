import { redact } from './auth';
import type { Env } from './auth';
import { gh } from './providers';
import { DEFAULT_TEMPLATE, renderWorkflowMessage } from './workflow-message';

type Obj = Record<string, unknown>;
const items = (data: unknown, key: string): Obj[] => {
  const value = (data as Obj | null)?.[key];
  return Array.isArray(value) ? value as Obj[] : [];
};
export async function sendWorkflowFailure(env: Env, runId: number): Promise<void> {
  if (!env.XRELAY_NOTIFICATION_URL || !env.XRELAY_NOTIFICATION_TOKEN) return;
  const run = await gh(env, '/actions/runs/' + runId) as Obj;
  if (run.conclusion !== 'failure') return;
  const jobs = items(await gh(env, '/actions/runs/' + runId + '/jobs?per_page=100'), 'jobs');
  const job = jobs.find(value => value.conclusion === 'failure');
  const steps = Array.isArray(job?.steps) ? job.steps as Obj[] : [];
  const step = steps.find(value => value.conclusion === 'failure');
  const url = String(run.html_url || '');
  const repo = env.GITHUB_REPO || 'rodkisten/photointel';
  const configured = await gh(env, '/actions/variables/PHOTOINTEL_WORKFLOW_MESSAGE_TEMPLATE')
    .catch(() => null) as { value?: string } | null;
  const message = renderWorkflowMessage(configured?.value || DEFAULT_TEMPLATE, {
    workflow: String(run.name || 'Workflow'), run_number: String(run.run_number || ''),
    run_id: String(runId), job: String(job?.name || 'Não identificado'),
    step: String(step?.name || 'Não identificada'), error: 'Consulte os logs da execução',
    diagnosis: 'Causa ainda não confirmada', url, repository: repo,
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
      body: redact(message).slice(0, 3900), notification_key: 'photointel:workflow:' + runId,
      sequence: Number(run.run_attempt || 1), chat_id: env.XRELAY_CHAT_ID || undefined,
      buttons: [[{ text: '📋 Logs', url }, {
        text: '🔧 Manage', url: 'https://photos-manage.migos.club/deploys/' + runId,
      }]],
    }),
  });
  if (!response.ok) throw new Error('Relay notification HTTP ' + response.status);
}
