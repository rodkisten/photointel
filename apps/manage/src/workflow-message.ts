import { ApiError, bodyJson, json } from './auth';
import type { Env } from './auth';
import { gh } from './providers';

export const PLACEHOLDERS = ['workflow', 'run_number', 'run_id', 'job', 'step', 'error', 'diagnosis', 'url', 'repository', 'branch', 'sha', 'status'] as const;
export const DEFAULT_TEMPLATE = '❌ {{workflow}} #{{run_number}}\nJob: {{job}}\nEtapa: {{step}}\nErro: {{error}}\nDiagnóstico: {{diagnosis}}\n{{url}}';
const VARIABLE = '/actions/variables/PHOTOINTEL_WORKFLOW_MESSAGE_TEMPLATE';
export function renderWorkflowMessage(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) =>
    PLACEHOLDERS.includes(key as typeof PLACEHOLDERS[number]) ? values[key] || 'indisponível' : '');
}
export async function workflowTemplateRoute(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/workflows/message-template') return null;
  if (request.method === 'GET') {
    const saved = await gh(env, VARIABLE).catch(() => null) as { value?: string } | null;
    return json({ template: saved?.value || DEFAULT_TEMPLATE, placeholders: PLACEHOLDERS });
  }
  if (request.method !== 'PUT') return null;
  const input = await bodyJson<{ template?: unknown }>(request, 5000);
  if (typeof input.template !== 'string' || !input.template.trim() || input.template.length > 3500 ||
    /\{\{[^}]*\}\}/.test(input.template.replace(/\{\{(?:workflow|run_number|run_id|job|step|error|diagnosis|url|repository|branch|sha|status)\}\}/g, '')))
    throw new ApiError(422, 'TEMPLATE', 'Template inválido ou placeholder desconhecido');
  const exists = await gh(env, VARIABLE).then(() => true).catch(() => false);
  await gh(env, exists ? VARIABLE : '/actions/variables', exists ? 'PATCH' : 'POST',
    { name: 'PHOTOINTEL_WORKFLOW_MESSAGE_TEMPLATE', value: input.template });
  return json({ ok: true });
}
