export interface Tenant {
  id: string;
  tokenHash: string;
  sourcePrefix: string;
}
export interface Env {
  MEDIA_TENANTS_JSON: string;
  MEDIA_SOURCE_GATEWAY_URL: string;
  MEDIA_SOURCE_TOKEN: string;
  MEDIA_IMAGOR_URL?: string;
  MEDIA_IMAGOR_SECRET?: string;
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
function transformOptions(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['width', 'height', 'quality', 'format', 'fit'].includes(key))) return null;
  const { width, height, quality = 80, format = 'webp', fit = 'contain' } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      (width as number) < 1 || (height as number) < 1 ||
      (width as number) > 4096 || (height as number) > 4096 ||
      (width as number) * (height as number) > 16000000 ||
      !Number.isInteger(quality) || (quality as number) < 30 || (quality as number) > 95 ||
      !['webp', 'avif', 'jpeg', 'png'].includes(format as string) ||
      !['contain', 'cover'].includes(fit as string)) return null;
  return (fit === 'contain' ? 'fit-in/' : '') + width + 'x' + height +
    '/filters:quality(' + quality + '):format(' + format + ')';
}
function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function signImagor(path: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(path))));
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return json({ ok: true });
    const transform = url.pathname === '/v1/image/transform';
    if (!transform && url.pathname !== '/v1/source/sign') return json({ error: 'Not found' }, 404);
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
    const input = payload as Record<string, unknown>;
    const key = input.key;
    const options = transform ? transformOptions(input.transform) : null;
    if (transform && !options) return json({ error: 'Invalid transform' }, 400);
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
    if (!transform) return json(result);
    if (!env.MEDIA_IMAGOR_SECRET || env.MEDIA_IMAGOR_SECRET.length < 32) {
      return json({ error: 'Imagor unavailable' }, 503);
    }
    let imagor: URL;
    try {
      imagor = new URL(env.MEDIA_IMAGOR_URL || '');
      if (imagor.protocol !== 'https:' || imagor.username || imagor.password ||
          imagor.search || imagor.hash || imagor.pathname !== '/') throw Error('Invalid Imagor');
    } catch { return json({ error: 'Imagor unavailable' }, 503); }
    const imageSource = 'b64:' + base64Url(encoder.encode(signed.toString()));
    const expires = (result as { expires: number }).expires;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + 60) {
      return json({ error: 'Invalid source expiration' }, 502);
    }
    // Imagor expire() uses milliseconds; never exceed the source URL's lifetime.
    const path = options + ':expire(' + expires * 1000 + ')/' + imageSource;
    const signature = await signImagor(path, env.MEDIA_IMAGOR_SECRET);
    return json({ url: new URL('/' + signature + '/' + path, imagor).toString(), expires });
  },
};
