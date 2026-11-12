import { ApiError, json, redact } from './auth';
import type { Env } from './auth';
import { gh } from './providers';

type RecordValue = Record<string, unknown>;
const asItems = (value: unknown, key: string): RecordValue[] => {
  const items = (value as RecordValue | null)?.[key];
  return Array.isArray(items) ? items as RecordValue[] : [];
};

/** Last failed run is searched server-side, not inferred from the first page of the UI. */
export async function workflowFailureRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/workflows/last-failure') return null;
  const response = await gh(env, '/actions/runs?status=failure&per_page=10') as RecordValue;
  const run = asItems(response, 'workflow_runs').find(item => item.conclusion === 'failure');
  if (!run) return json({ item: null });
  const id = Number(run.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(502, 'RUN_ID', 'Execução inválida');
  const jobsResponse = await gh(env, '/actions/runs/' + id + '/jobs?per_page=100');
  const jobs = asItems(jobsResponse, 'jobs')
    .filter(job => job.conclusion === 'failure')
    .map(job => ({
      id: job.id,
      name: redact(String(job.name || 'Job')),
      html_url: job.html_url,
      steps: (Array.isArray(job.steps) ? job.steps as RecordValue[] : [])
        .filter(step => step.conclusion === 'failure')
        .map(step => ({ name: redact(String(step.name || 'Step')), number: step.number })),
    }));
  return json({
    item: {
      id, name: redact(String(run.name || 'Workflow')), run_number: run.run_number,
      created_at: run.created_at, html_url: run.html_url, jobs,
    },
  });
}
