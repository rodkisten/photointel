/** Fixed-origin Access relay. The API independently validates every signed JWT. */
const REQUEST_HEADERS = [
  'accept', 'content-type', 'authorization', 'cf-access-jwt-assertion',
  'origin', 'if-none-match', 'if-range', 'range', 'last-event-id',
];
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

function configuration(env) {
  const origin = new URL(env.CLOUD_RUN_ORIGIN);
  const frontend = new URL(env.FRONTEND_ORIGIN);
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.run.app') ||
      origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.port ||
      frontend.protocol !== 'https:' || frontend.pathname !== '/' ||
      frontend.username || frontend.password || frontend.search || frontend.hash) {
    throw new Error('Invalid fixed upstream or frontend origin');
  }
  return { origin: origin.origin, frontend: frontend.origin };
}

function failure(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', ...extra,
    },
  });
}

export async function handle(request, env, fetchOrigin = fetch) {
  let config;
  try { config = configuration(env); }
  catch { return failure(503, 'API routing not configured'); }
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith('/v1/') || !METHODS.has(request.method)) {
    return failure(404, 'Route unavailable');
  }
  if (request.method === 'OPTIONS') {
    if (request.headers.get('Origin') !== config.frontend) {
      return failure(403, 'Origin not allowed');
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': config.frontend,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cf-Access-Jwt-Assertion,If-None-Match,If-Range,Range,Last-Event-ID',
        'Vary': 'Origin', 'Cache-Control': 'private, no-store',
      },
    });
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16384) {
    return failure(401, 'Cloudflare Access required');
  }
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // A fixed origin prevents open proxy/SSRF; caller input is only path and query.
  const target = new URL(config.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const upstream = new Request(target, {
    method: request.method, headers, body: request.body, redirect: 'manual',
    duplex: 'half',
  });
  try {
    const response = await fetchOrigin(upstream, {
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel();
      return failure(502, 'Unexpected origin redirect');
    }
    const outgoing = new Headers(response.headers);
    outgoing.set('Cache-Control', 'private, no-store');
    outgoing.set('CDN-Cache-Control', 'no-store');
    outgoing.set('Cloudflare-CDN-Cache-Control', 'no-store');
    outgoing.delete('Set-Cookie');
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: outgoing,
    });
  } catch { return failure(502, 'API temporarily unavailable'); }
}

export default {
  fetch(request, env) { return handle(request, env); },
};
