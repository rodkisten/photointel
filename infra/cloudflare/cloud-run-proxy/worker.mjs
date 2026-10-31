/** Unified React asset server + fixed-origin API relay. The API validates signed JWTs. */
const REQUEST_HEADERS = [
  'accept', 'content-type', 'authorization', 'cf-access-jwt-assertion',
  'origin', 'if-none-match', 'if-range', 'range', 'last-event-id',
];
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

// Bound repeated incidents to one event/minute per category and isolate.
// Never log URLs, query strings, headers, JWTs, bodies or exception messages.
const incidents = new Map();
function important(level, event, route, status, durationMs = 0) {
  const now = Date.now();
  const key = `${event}:${route}:${status}`;
  const prior = incidents.get(key);
  if (prior && now - prior.at < 60000) { prior.suppressed++; return; }
  incidents.set(key, { at: now, suppressed: 0 });
  console[level]({ service: 'photointel', event, route, status,
    duration_ms: Math.max(0, Math.round(durationMs)),
    suppressed_since_last: prior?.suppressed ?? 0 });
}
function routeGroup(path) {
  if (path.startsWith('/v1/')) return '/v1/*';
  if (path === '/') return '/';
  if (path.startsWith('/assets/')) return '/assets/*';
  return 'frontend';
}

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
  catch {
    important('error', 'routing_config_invalid', 'configuration', 503);
    return failure(503, 'API routing not configured');
  }
  const incoming = new URL(request.url);
  // One Worker, two services: React static assets on the frontend hostname
  // and /v1/* requests proxied to the existing Cloud Run Python API.
  // An existing api.* custom domain may remain attached for compatibility.
  if (!incoming.pathname.startsWith('/v1/')) {
    if (incoming.pathname === '/v1' || incoming.pathname.startsWith('/v1')) {
      return failure(404, 'Route unavailable');
    }
    if (
      incoming.origin !== config.frontend ||
      !['GET', 'HEAD'].includes(request.method)
    ) {
      return failure(404, 'Route unavailable');
    }
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      important('error', 'frontend_assets_binding_missing', routeGroup(incoming.pathname), 503);
      return failure(503, 'Frontend assets not deployed');
    }
    const started = Date.now();
    try {
      const response = await env.ASSETS.fetch(request);
      if (response.status >= 500 || (response.status === 404 && incoming.pathname === '/')) {
        important('error', 'frontend_assets_failed', routeGroup(incoming.pathname), response.status);
      } else if (response.status === 404 && incoming.pathname.startsWith('/assets/')) {
        important('warn', 'frontend_asset_missing', '/assets/*', 404);
      }
      return response;
    } catch {
      important('error', 'frontend_assets_unreachable', routeGroup(incoming.pathname), 503, Date.now() - started);
      return failure(503, 'Frontend temporarily unavailable');
    }
  }
  if (!METHODS.has(request.method)) {
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
  // Access may deliver its signed application JWT as a same-origin cookie.
  // This is credential transport only: Cloud Run still verifies signature,
  // issuer, audience, expiry and allowlist. Never trust decoded cookie claims.
  let assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion && incoming.origin === config.frontend) {
    const cookie = request.headers.get('Cookie') ?? '';
    if (cookie.length <= 32768) {
      const matches = cookie.split(';').map(part => part.trim())
        .filter(part => part.startsWith('CF_Authorization='));
      if (matches.length === 1) {
        const value = matches[0].slice('CF_Authorization='.length);
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
          assertion = value;
        }
      }
    }
  }
  if (!assertion || assertion.length > 16384) {
    return failure(401, 'Cloudflare Access required', { 'X-PhotoIntel-Auth': 'session-missing' });
  }
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('Cf-Access-Jwt-Assertion', assertion);
  // A fixed origin prevents open proxy/SSRF; caller input is only path and query.
  const target = new URL(config.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const upstream = new Request(target, {
    method: request.method, headers, body: request.body, redirect: 'manual',
    duplex: 'half',
  });
  const started = Date.now();
  try {
    const response = await fetchOrigin(upstream, {
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      important('error', 'upstream_redirect_rejected', '/v1/*', 502);
      await response.body?.cancel();
      return failure(502, 'Unexpected origin redirect');
    }
    const elapsed = Date.now() - started;
    if (response.status >= 500) {
      important('error', 'upstream_server_error', '/v1/*', response.status, elapsed);
    } else if (response.status === 401 || response.status === 403) {
      important('warn', 'upstream_auth_rejected', '/v1/*', response.status, elapsed);
    } else if (response.status === 429) {
      important('warn', 'upstream_rate_limited', '/v1/*', 429, elapsed);
    } else if (elapsed >= 3000 && response.status < 400) {
      important('warn', 'upstream_slow', '/v1/*', response.status, elapsed);
    }
    const outgoing = new Headers(response.headers);
    outgoing.set('Cache-Control', 'private, no-store');
    outgoing.set('CDN-Cache-Control', 'no-store');
    outgoing.set('Cloudflare-CDN-Cache-Control', 'no-store');
    outgoing.delete('Set-Cookie');
    if (response.status === 401 || response.status === 403) {
      outgoing.set('X-PhotoIntel-Auth', 'upstream-rejected');
    }
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: outgoing,
    });
  } catch {
    important('error', 'upstream_unreachable', '/v1/*', 502, Date.now() - started);
    return failure(502, 'API temporarily unavailable');
  }
}

export default {
  fetch(request, env) { return handle(request, env); },
};


