interface Env {
  MEDIA_BUCKET: R2Bucket;
  MEDIA_SIGNING_KEY: string;
  MEDIA_ISSUER_TOKEN: string;
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
  let hasUnexpectedQueryParam = false;
  url.searchParams.forEach((_value, param) => {
    if (param !== 'exp' && param !== 'sig') hasUnexpectedQueryParam = true;
  });
  if (hasUnexpectedQueryParam) return null;
  const rawExp = url.searchParams.get('exp') || '';
  const sig = url.searchParams.get('sig') || '';
  if (!/^\d{10,13}$/.test(rawExp) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  return { key, expires: Number(rawExp), sig };
}
function authorizedPrefix(env: Env): string | null {
  const prefix = env.MEDIA_PREFIX;
  // Explicit, directory-scoped R2 prefixes prevent cross-tenant key traversal.
  if (!prefix || !prefix.startsWith('derived/') || !prefix.endsWith('/') ||
      prefix.includes('\\\\') || prefix.includes('%') ||
      prefix.split('/').some((segment, i, parts) =>
        i < parts.length - 1 && (!segment || segment === '.' || segment === '..'))) {
    return null;
  }
  return prefix;
}
function withinPrefix(key: string, prefix: string): boolean {
  return key.startsWith(prefix) && key.length > prefix.length;
}
function contentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  return ({ avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg',
    png: 'image/png', mp4: 'video/mp4' } as Record<string, string>)[ext || ''] || 'application/octet-stream';
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!allowedMethods.has(request.method) && request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname === '/v1/sign') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      const authorization = request.headers.get('Authorization') || '';
      if (!env.MEDIA_ISSUER_TOKEN || env.MEDIA_ISSUER_TOKEN.length < 32 ||
          !constantTimeEquals(authorization, 'Bearer ' + env.MEDIA_ISSUER_TOKEN)) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (!env.MEDIA_SIGNING_KEY || env.MEDIA_SIGNING_KEY.length < 32) {
        return new Response('Unavailable', { status: 503 });
      }
      const body = await request.text();
      if (body.length > 2048) return new Response('Payload Too Large', { status: 413 });
      let input: unknown;
      try { input = JSON.parse(body); }
      catch { return new Response('Invalid JSON', { status: 400 }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return new Response('Invalid request', { status: 400 });
      }
      const { key, ttl } = input as Record<string, unknown>;
      if (typeof key !== 'string' || typeof ttl !== 'number' ||
          !Number.isInteger(ttl) || ttl < 1 || ttl > 3600) {
        return new Response('Invalid key or TTL', { status: 400 });
      }
      const path = '/v1/media/' + key.split('/').map(encodeURIComponent).join('/');
      const candidate = new URL(path, url.origin);
      candidate.searchParams.set('exp', String(Math.floor(Date.now() / 1000) + ttl));
      candidate.searchParams.set('sig', '0'.repeat(64));
      const parsedKey = parseRequest(candidate);
      if (!parsedKey || parsedKey.key !== key) {
        return new Response('Invalid key', { status: 400 });
      }
      const prefix = authorizedPrefix(env);
      if (!prefix) return new Response('Unavailable', { status: 503 });
      if (!withinPrefix(key, prefix)) return new Response('Forbidden', { status: 403 });
      const object = await env.MEDIA_BUCKET.head(key);
      if (!object) return new Response('Not Found', { status: 404 });
      const sig = await signature(env.MEDIA_SIGNING_KEY,
        `GET\n${key}\n${parsedKey.expires}`);
      candidate.searchParams.set('sig', sig);
      return Response.json({ url: candidate.toString(), expires: parsedKey.expires }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (!allowedMethods.has(request.method)) return new Response('Method Not Allowed', { status: 405 });
    const parsed = parseRequest(url);
    if (!parsed) return new Response('Not Found', { status: 404 });
    const prefix = authorizedPrefix(env);
    if (!prefix) return new Response('Unavailable', { status: 503 });
    if (!withinPrefix(parsed.key, prefix)) return new Response('Forbidden', { status: 403 });
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(parsed.expires) || parsed.expires < now || parsed.expires > now + 3600) {
      return new Response('Expired or invalid signature', { status: 403 });
    }
    if (!env.MEDIA_SIGNING_KEY || env.MEDIA_SIGNING_KEY.length < 32) {
      return new Response('Unavailable', { status: 503 });
    }
    const expected = await signature(env.MEDIA_SIGNING_KEY, `GET\n${parsed.key}\n${parsed.expires}`);
    if (!constantTimeEquals(expected, parsed.sig)) return new Response('Forbidden', { status: 403 });
    // RFC 7233 single-byte ranges support Safari/iOS seeking without buffering full MP4s.
    // Refuse multipart ranges rather than returning an incorrect partial response.
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader && (parsed.key.toLowerCase().endsWith('.mp4') === false || rangeHeader.includes(','))) {
      return new Response('Range Not Satisfiable', { status: 416, headers: { 'Cache-Control': 'no-store' } });
    }
    const metadata = await env.MEDIA_BUCKET.head(parsed.key);
    if (!metadata) return new Response('Not Found', { status: 404 });
    const size = metadata.size;
    let range: { offset: number; length: number } | undefined;
    if (rangeHeader) {
      const match = /^bytes=(\\d*)-(\\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start >= size || end < start || start < 0 || size === 0 ||
          (match[1] === '' && Number(match[2]) === 0)) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      range = { offset: start, length: Math.min(end, size - 1) - start + 1 };
    }
    const object = await env.MEDIA_BUCKET.get(parsed.key, range ? { range } : undefined);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers({
      'Content-Type': object.httpMetadata?.contentType || contentType(parsed.key),
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    if (parsed.key.toLowerCase().endsWith('.mp4')) headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(range?.length ?? size));
    if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
  },
} satisfies ExportedHandler<Env>;
