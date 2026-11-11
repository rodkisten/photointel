interface Env {
  MEDIA_BUCKET: R2Bucket;
  MEDIA_SIGNING_KEY: string;
  MEDIA_PREFIX: string;
}

const allowedFormats = new Set(['avif', 'webp', 'jpeg', 'png', 'mp4']);
const allowedMethods = new Set(['GET', 'HEAD']);
const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))));
}
function parseRequest(url: URL): { key: string; expires: number; sig: string } | null {
  if (url.pathname.length > 700 || !url.pathname.startsWith('/v1/media/')) return null;
  let key: string;
  try { key = decodeURIComponent(url.pathname.slice('/v1/media/'.length)); }
  catch { return null; }
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('%') ||
      key.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  if (!key.startsWith('derived/')) return null;
  const ext = key.split('.').pop()?.toLowerCase();
  if (!ext || !allowedFormats.has(ext)) return null;
  if ([...url.searchParams.keys()].some(param => param !== 'exp' && param !== 'sig')) return null;
  const rawExp = url.searchParams.get('exp') || '';
  const sig = url.searchParams.get('sig') || '';
  if (!/^\d{10,13}$/.test(rawExp) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  return { key, expires: Number(rawExp), sig };
}
function contentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  return ({ avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg',
    png: 'image/png', mp4: 'video/mp4' } as Record<string, string>)[ext || ''] || 'application/octet-stream';
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!allowedMethods.has(request.method)) return new Response('Method Not Allowed', { status: 405 });
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    const parsed = parseRequest(url);
    if (!parsed) return new Response('Not Found', { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(parsed.expires) || parsed.expires < now || parsed.expires > now + 3600) {
      return new Response('Expired or invalid signature', { status: 403 });
    }
    if (!env.MEDIA_SIGNING_KEY || env.MEDIA_SIGNING_KEY.length < 32) {
      return new Response('Unavailable', { status: 503 });
    }
    const expected = await signature(env.MEDIA_SIGNING_KEY, `GET\n${parsed.key}\n${parsed.expires}`);
    if (!constantTimeEquals(expected, parsed.sig)) return new Response('Forbidden', { status: 403 });
    const object = await env.MEDIA_BUCKET.get(parsed.key);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers({
      'Content-Type': object.httpMetadata?.contentType || contentType(parsed.key),
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
  },
} satisfies ExportedHandler<Env>;
