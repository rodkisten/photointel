import { json } from './auth';
import { cf } from './providers';
import type { Env } from './auth';

const SCRIPT = 'photointel';
type CFResponse = { result?: any; success?: boolean };

export async function cloudflareRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET') return null;
  if (path === '/api/cloudflare/variables') {
    const response = await cf(env, '/workers/scripts/' + SCRIPT + '/settings') as CFResponse;
    const bindings = Array.isArray(response.result?.bindings) ? response.result.bindings : [];
    return json({ worker: SCRIPT, items: bindings.map((binding: any) => ({
      name: String(binding.name || ''),
      type: String(binding.type || ''),
      // Secret values are never exposed. Only plaintext vars can be inspected.
      value: binding.type === 'plain_text' && typeof binding.text === 'string'
        ? binding.text : null,
      protected: binding.type !== 'plain_text',
    })).filter((binding: any) => binding.name) });
  }
  if (path === '/api/cloudflare/deployments') {
    const response = await cf(env, '/workers/scripts/' + SCRIPT + '/deployments?per_page=15') as CFResponse;
    const deployments = Array.isArray(response.result?.deployments) ? response.result.deployments
      : Array.isArray(response.result) ? response.result : [];
    return json({ worker: SCRIPT, items: deployments.slice(0, 15).map((item: any) => ({
      id: String(item.id || ''),
      created_on: item.created_on || null,
      source: item.source || null,
      author: item.author || null,
      versions: Array.isArray(item.versions) ? item.versions.map((v: any) => ({
        version_id: String(v.version_id || ''), percentage: v.percentage ?? null,
      })) : [],
    })) });
  }
  return null;
}
