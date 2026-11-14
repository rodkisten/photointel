export interface Tenant {
  id: string;
  tokenHash: string;
  sourcePrefix: string;
}
export interface Env {
  MEDIA_TENANTS_JSON: string;
  MEDIA_SOURCE_GATEWAY_URL: string;
  MEDIA_SOURCE_TOKEN: string;
}
const encoder = new TextEncoder();
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function parseTenants(raw: string): Tenant[] {
  const input: unknown = JSON.parse(raw);
  if (!Array.isArray(input) || input.length > 1000) throw Error('Invalid tenant configuration');
  const ids = new Set<string>();
  const hashes = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== 'object') throw Error('Invalid tenant');
    const tenant = value as Record<string, unknown>;
    const { id, tokenHash, sourcePrefix } = tenant;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ||
        typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash) ||
        typeof sourcePrefix !== 'string' ||
        sourcePrefix !== `originals/tenants/${id}/` ||
        ids.has(id) || hashes.has(tokenHash)) throw Error('Invalid tenant configuration');
    ids.add(id);
    hashes.add(tokenHash);
    return { id, tokenHash, sourcePrefix };
  });
}
function validKey(key: unknown, prefix: string): key is string {
  return typeof key === 'string' && key.length <= 500 &&
    key.startsWith(prefix) && key.length > prefix.length &&
    !key.includes('%') && !key.includes('\\') &&
    key.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return json({ ok: true });
    if (url.pathname !== '/v1/source/sign') return json({ error: 'Not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ') || auth.length > 512) return json({ error: 'Unauthorized' }, 401);
    let tenants: Tenant[];
    try { tenants = parseTenants(env.MEDIA_TENANTS_JSON); }
    catch { return json({ error: 'Unavailable' }, 503); }
    const hash = await sha256(auth.slice(7));
    const tenant = tenants.find(entry => safeEqual(entry.tokenHash, hash));
    if (!tenant) return json({ error: 'Unauthorized' }, 401);
    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > 1024) return json({ error: 'Payload too large' }, 413);
    const raw = await request.text();
    if (raw.length > 1024) return json({ error: 'Payload too large' }, 413);
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'Invalid request' }, 400);
    }
    const key = (payload as Record<string, unknown>).key;
    if (!validKey(key, tenant.sourcePrefix)) return json({ error: 'Forbidden' }, 403);
    if (!env.MEDIA_SOURCE_TOKEN || env.MEDIA_SOURCE_TOKEN.length < 32) {
      return json({ error: 'Unavailable' }, 503);
    }
    let origin: URL;
    try {
      origin = new URL(env.MEDIA_SOURCE_GATEWAY_URL);
      if (origin.protocol !== 'https:' || origin.username || origin.password ||
          origin.search || origin.hash || origin.pathname !== '/') throw Error('Invalid gateway');
    } catch { return json({ error: 'Unavailable' }, 503); }
    const response = await fetch(new URL('/v1/source/sign', origin), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.MEDIA_SOURCE_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key }),
      redirect: 'error',
    });
    if (!response.ok) return json({ error: 'Source unavailable' }, 502);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' ||
        typeof (result as Record<string, unknown>).url !== 'string' ||
        typeof (result as Record<string, unknown>).expires !== 'number') {
      return json({ error: 'Invalid source response' }, 502);
    }
    const signed = new URL((result as { url: string }).url);
    if (signed.origin !== origin.origin ||
        signed.pathname !== '/v1/source/' + key.split('/').map(encodeURIComponent).join('/')) {
      return json({ error: 'Invalid source response' }, 502);
    }
    return json(result);
  },
};
