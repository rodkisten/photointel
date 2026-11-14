import { ApiError, bodyJson, json, requireOrigin, redact } from './auth';
import type { Env, Identity } from './auth';
import { gcp, gcpBase, gcpToken, provider } from './providers';

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
type Overrides = { env?: Array<{ name: string; value: string }>; args?: string[]; taskCount?: number; timeout?: string };

function validate(input: Overrides): Overrides {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(422, 'OVERRIDES', 'Inputs inválidos');
  const allowed = ['env', 'args', 'taskCount', 'timeout'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(422, 'OVERRIDES', 'Campo não permitido');
  if (input.env !== undefined && (!Array.isArray(input.env) || input.env.length > 40)) throw new ApiError(422, 'ENV', 'Máximo de 40 variáveis');
  const seen = new Set<string>();
  for (const item of input.env || []) {
    if (!item || !KEY.test(item.name) || typeof item.value !== 'string' || item.value.length > 4096 || seen.has(item.name)) throw new ApiError(422, 'ENV', 'Variável inválida ou duplicada');
    if (/^(?:GOOGLE_|K_SERVICE|K_REVISION|K_CONFIGURATION|PORT$)/.test(item.name)) throw new ApiError(422, 'ENV_RESERVED', 'Variável reservada');
    seen.add(item.name);
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 30 || input.args.some(x => typeof x !== 'string' || x.length > 1024))) throw new ApiError(422, 'ARGS', 'Argumentos inválidos');
  if (input.taskCount !== undefined && (!Number.isInteger(input.taskCount) || input.taskCount < 1 || input.taskCount > 10)) throw new ApiError(422, 'TASK_COUNT', 'Limite de 10 tasks por disparo');
  if (input.timeout !== undefined && (!/^([1-9][0-9]{0,3})s$/.test(input.timeout) || Number(input.timeout.slice(0, -1)) > 3600)) throw new ApiError(422, 'TIMEOUT', 'Timeout máximo 3600s');
  return input;
}

async function gcpLogging(env: Env, identity: Identity, project: string, filter: string): Promise<{ entries?: Array<{ jsonPayload?: unknown; textPayload?: string; [key: string]: unknown }> }> {
  const token = await gcpToken(env, identity);
  return await provider('https://logging.googleapis.com/v2/entries:list', token, {
    method: 'POST',
    body: JSON.stringify({ resourceNames: ['projects/' + project], filter, orderBy: 'timestamp desc', pageSize: 100 }),
  }) as { entries?: Array<{ jsonPayload?: unknown; textPayload?: string; [key: string]: unknown }> };
}

export async function cloudRunJobsRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/cloud-run-jobs' && !url.pathname.startsWith('/api/cloud-run-jobs/')) return null;
  if (env.PHOTOINTEL_PREVIEW) throw new ApiError(403, 'PREVIEW', 'Execução indisponível em preview');
  const base = gcpBase(env);
  if (request.method === 'GET' && url.pathname === '/api/cloud-run-jobs') {
    const result = await gcp(env, identity, base + '/jobs?pageSize=100') as { jobs?: unknown[]; nextPageToken?: string };
    return json({ items: result.jobs || [], nextPageToken: result.nextPageToken || null });
  }
  const logMatch = url.pathname.match(/^\/api\/cloud-run-jobs\/([a-z][a-z0-9-]{0,62})\/executions\/([a-z][a-z0-9-]{0,100})\/logs$/);
  if (request.method === 'GET' && logMatch) {
    const project = env.GCP_PROJECT_ID || 'photointel';
    const execution = logMatch[2];
    const filter = 'resource.type="cloud_run_job" AND resource.labels.job_name="' + logMatch[1] + '" AND labels."run.googleapis.com/execution_name"="' + execution + '"';
    const result = await gcpLogging(env, identity, project, filter);
    return json({ entries: (result.entries || []).reverse().map(entry => ({ ...entry, jsonPayload: entry.jsonPayload ? redact(entry.jsonPayload) : undefined, textPayload: entry.textPayload ? redact(entry.textPayload) : undefined })) });
  }
  const match = url.pathname.match(/^\/api\/cloud-run-jobs\/([a-z][a-z0-9-]{0,62})\/(run|executions)$/);
  if (!match || !NAME.test(match[1])) return null;
  const job = base + '/jobs/' + match[1];
  if (request.method === 'GET' && match[2] === 'executions') {
    const result = await gcp(env, identity, job + '/executions?pageSize=30');
    return json(result);
  }
  if (request.method === 'POST' && match[2] === 'run') {
    requireOrigin(request);
    const body = await bodyJson<{ overrides?: Overrides; confirm?: string }>(request, 180000);
    if (body.confirm !== match[1]) throw new ApiError(409, 'CONFIRM', 'Confirme o nome do job antes de executar');
    const overrides = validate(body.overrides || {});
    const existing = await gcp(env, identity, job) as { template?: { template?: { containers?: Array<{ name?: string }> } } };
    const containers = existing.template?.template?.containers || [];
    if (!containers.length) throw new ApiError(422, 'CONTAINERS', 'Job sem container configurado');
    if (containers.length !== 1 && ((overrides.env?.length || 0) > 0 || (overrides.args?.length || 0) > 0)) throw new ApiError(422, 'MULTI_CONTAINER', 'Overrides de container exigem seleção explícita');
    const payload = { overrides: {
      ...(overrides.taskCount ? { taskCount: overrides.taskCount } : {}),
      ...(overrides.timeout ? { timeout: overrides.timeout } : {}),
      ...((overrides.env?.length || overrides.args?.length) ? { containerOverrides: [{ name: containers[0].name, ...(overrides.env?.length ? { env: overrides.env } : {}), ...(overrides.args?.length ? { args: overrides.args } : {}) }] } : {}),
    } };
    const result = await gcp(env, identity, job + ':run', payload);
    return json({ operation: result, job: match[1], initiated_by: identity.email }, 202);
  }
  throw new ApiError(405, 'METHOD', 'Método não permitido');
}
