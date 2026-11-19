import { json } from './auth';
import { cf } from './providers';
import type { Env } from './auth';

const SCRIPT = 'photointel';
type JsonObject = Record<string, unknown>;
type CFResponse = { result?: unknown; success?: boolean };
function object(value: unknown): JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
function array(value: unknown): JsonObject[] { return Array.isArray(value) ? value.map(object) : []; }

export async function cloudflareRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET') return null;
  if (path === '/api/cloudflare/variables') {
    const response = await cf(env, '/workers/scripts/' + SCRIPT + '/settings') as CFResponse;
    const result = object(response.result);
    const bindings = array(result.bindings);
    return json({ worker: SCRIPT, items: bindings.map((binding) => ({
      name: String(binding.name || ''),
      type: String(binding.type || ''),
      // Secret values are never exposed. Only plaintext vars can be inspected.
      value: binding.type === 'plain_text' && typeof binding.text === 'string'
        ? binding.text : null,
      protected: binding.type !== 'plain_text',
    })).filter((binding) => binding.name) });
  }
  if (path === '/api/cloudflare/deployments') {
    const response = await cf(env, '/workers/scripts/' + SCRIPT + '/deployments?per_page=15') as CFResponse;
    const result = object(response.result);
    const deployments = array(result.deployments ?? response.result);
    return json({ worker: SCRIPT, items: deployments.slice(0, 15).map((item) => ({
      id: String(item.id || ''),
      created_on: item.created_on || null,
      source: item.source || null,
      author: item.author || null,
      versions: Array.isArray(item.versions) ? array(item.versions).map((v) => ({
        version_id: String(v.version_id || ''), percentage: v.percentage ?? null,
      })) : [],
    })) });
  }
  return null;
}
