/** Unified React asset server + fixed-origin API relay. The API validates signed JWTs. */
const REQUEST_HEADERS = [
  'accept', 'content-type', 'authorization', 'cf-access-jwt-assertion',
  'origin', 'if-none-match', 'if-range', 'range', 'last-event-id',
];
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

// Bound repeated incidents to one event/minute per category and isolate.
// Never log URLs, query strings, headers, JWTs, bodies or exception messages.
const incidents = new Map();
function important(level, event, route, status, durationMs = 0, correlationId = null) {
  // Every edge failure must be searchable by its own correlation ID.
  if (level === 'error' && correlationId) {
    console.error({ service: 'photointel', event, route, status,
      duration_ms: Math.max(0, Math.round(durationMs)), correlation_id: correlationId });
    return;
  }
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

function configuration(env, requireUpstream = true) {
  // Static UI and login must work even if Cloud Run is not configured or unhealthy.
  const frontend = new URL(env.FRONTEND_ORIGIN);
  if (frontend.protocol !== 'https:' || frontend.pathname !== '/' ||
      frontend.username || frontend.password || frontend.search || frontend.hash || frontend.port) {
    throw new Error('Invalid frontend origin');
  }
  if (!requireUpstream) return { frontend: frontend.origin, origin: null };
  const origin = new URL(env.CLOUD_RUN_ORIGIN);
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.run.app') ||
      origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.port) {
    throw new Error('Invalid fixed upstream origin');
  }
  return { frontend: frontend.origin, origin: origin.origin };
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

function frontendFailure(status, correlationId) {
  // HTML fallback works without bundled JS, Firebase, or an ASSETS binding.
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PhotoIntel · diagnóstico</title></head>
<body style="margin:0;min-height:100dvh;background:#101112;color:#eceeed;
font:15px/1.6 system-ui;display:grid;place-items:center;padding:20px">
<main style="max-width:580px;border:1px solid #343936;border-radius:18px;padding:28px">
<h1>PhotoIntel temporariamente indisponível</h1>
<p>O Cloudflare não conseguiu servir a interface. Os dados originais não foram alterados.</p>
<p>Correlation ID: <code>${correlationId}</code></p>
<a style="color:#bcd9bf" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages">
Ver logs no Cloudflare</a>
<p>Abra o Worker photointel, Observability, e filtre pelo correlation_id.</p>
<button type="button" onclick="location.reload()">Tentar novamente</button>
</main></body></html>`;
  return new Response(html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
function isNavigation(request, pathname) {
  return request.headers.get('Accept')?.includes('text/html') ||
    (!pathname.startsWith('/assets/') && !/\.[a-z0-9]{1,8}$/i.test(pathname));
}

async function dispatch(request, env, fetchOrigin, correlationId) {
  const incoming = new URL(request.url);
  const log = (level, event, route, status, durationMs = 0) =>
    important(level, event, route, status, durationMs, correlationId);
  let config;
  try { config = configuration(env, incoming.pathname.startsWith('/v1/')); }
  catch {
    log('error', 'routing_config_invalid', 'configuration', 503);
    return failure(503, 'Routing not configured');
  }

  // Privacy-preserving browser diagnostics. Never accept messages, stacks,
  // URLs, authentication headers, cookies, or request payloads as log values.
  if (incoming.pathname === '/__diagnostics/client-errors') {
    if (incoming.origin !== config.frontend || request.method !== 'POST') {
      return failure(404, 'Route unavailable');
    }
    if (request.headers.get('Origin') !== config.frontend ||
        !/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
      return failure(403, 'Origin not allowed');
    }
    const length = Number(request.headers.get('Content-Length'));
    if ((request.headers.has('Content-Length') && (!Number.isInteger(length) || length < 1 || length > 1024))) {
      return failure(413, 'Invalid diagnostics size');
    }
    try {
      const raw = await request.text();
      if (raw.length > 1024) return failure(413, 'Invalid diagnostics size');
      const item = JSON.parse(raw);
      const phases = new Set(['bootstrap', 'render', 'runtime', 'promise', 'api', 'resource', 'worker']);
      if (!item || typeof item !== 'object' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id ?? '') ||
          !phases.has(item.phase) ||
          !/^[A-Z0-9_]{1,48}$/.test(item.code ?? '')) {
        return failure(400, 'Invalid diagnostics');
      }
      console.error({ service: 'photointel', event: 'client_error',
        correlation_id: item.id, phase: item.phase, code: item.code, source: 'browser' });
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return failure(400, 'Invalid diagnostics');
    }
  }
  if (incoming.pathname === '/__app/version') {
    if (incoming.origin !== config.frontend || request.method !== 'GET') {
      return failure(404, 'Route unavailable');
    }
    return new Response(JSON.stringify({
      release: /^[a-f0-9]{40}$/.test(env.RELEASE_SHA ?? '') ? env.RELEASE_SHA : null,
    }), { headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'CDN-Cache-Control': 'no-store',
    } });
  }
  if (incoming.pathname === '/auth/login') {
    if (incoming.origin !== config.frontend || request.method !== 'GET') {
      return failure(404, 'Route unavailable');
    }
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '') ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(env.ACCESS_AUDIENCE ?? '')) {
      log('error', 'access_login_config_missing', 'authentication', 503);
      return failure(503, 'Cloudflare Access login not configured');
    }
    const login = new URL('https://' + env.ACCESS_TEAM_DOMAIN);
    login.pathname = '/cdn-cgi/access/login/' + new URL(config.frontend).hostname;
    login.searchParams.set('kid', env.ACCESS_AUDIENCE);
    login.searchParams.set('redirect_url', config.frontend + '/');
    return new Response(null, { status: 302, headers: {
      Location: login.href, 'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    } });
  }

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
      log('error', 'frontend_assets_binding_missing', routeGroup(incoming.pathname), 503);
      return isNavigation(request, incoming.pathname)
        ? frontendFailure(503, correlationId) : failure(503, 'Frontend assets not deployed');
    }
    const started = Date.now();
    try {
      const response = await env.ASSETS.fetch(request);
      if (response.status >= 500 || (response.status === 404 && incoming.pathname === '/')) {
        log('error', 'frontend_assets_failed', routeGroup(incoming.pathname), response.status);
      } else if (response.status === 404 && incoming.pathname.startsWith('/assets/')) {
        log('warn', 'frontend_asset_missing', '/assets/*', 404);
      }
      if (response.status >= 500 && isNavigation(request, incoming.pathname)) {
        return frontendFailure(response.status, correlationId);
      }
      const headers = new Headers(response.headers);
      if (isNavigation(request, incoming.pathname) ||
          ['/index.html', '/sw.js', '/manifest.webmanifest', '/fcm.js'].includes(incoming.pathname)) {
        headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
        headers.set('CDN-Cache-Control', 'no-store');
        headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
        headers.set('Pragma', 'no-cache');
      }
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    } catch {
      log('error', 'frontend_assets_unreachable', routeGroup(incoming.pathname), 503, Date.now() - started);
      return isNavigation(request, incoming.pathname)
        ? frontendFailure(503, correlationId) : failure(503, 'Frontend temporarily unavailable');
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
  headers.set('X-Correlation-ID', correlationId);
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
      log('error', 'upstream_redirect_rejected', '/v1/*', 502);
      await response.body?.cancel();
      return failure(502, 'Unexpected origin redirect');
    }
    const elapsed = Date.now() - started;
    if (response.status >= 500) {
      log('error', 'upstream_server_error', '/v1/*', response.status, elapsed);
    } else if (response.status === 401 || response.status === 403) {
      log('warn', 'upstream_auth_rejected', '/v1/*', response.status, elapsed);
    } else if (response.status === 429) {
      log('warn', 'upstream_rate_limited', '/v1/*', 429, elapsed);
    } else if (elapsed >= 3000 && response.status < 400) {
      log('warn', 'upstream_slow', '/v1/*', response.status, elapsed);
    }
    const outgoing = new Headers(response.headers);
    outgoing.set('Cache-Control', 'private, no-store');
    outgoing.set('CDN-Cache-Control', 'no-store');
    outgoing.set('Cloudflare-CDN-Cache-Control', 'no-store');
    outgoing.delete('Set-Cookie');
    outgoing.set('X-PhotoIntel-Source', 'gcp');
    if (response.status === 401 || response.status === 403) {
      outgoing.set('X-PhotoIntel-Auth', 'upstream-rejected');
    }
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: outgoing,
    });
  } catch {
    log('error', 'upstream_unreachable', '/v1/*', 502, Date.now() - started);
    return failure(502, 'API temporarily unavailable');
  }
}

export async function handle(request, env, fetchOrigin = fetch) {
  const correlationId = crypto.randomUUID();
  let response;
  try {
    response = await dispatch(request, env, fetchOrigin, correlationId);
  } catch {
    important('error', 'worker_uncaught_error', 'edge', 500, 0, correlationId);
    response = failure(500, 'Unexpected edge error');
  }
  const headers = new Headers(response.headers);
  if (!headers.has('X-Correlation-ID')) headers.set('X-Correlation-ID', correlationId);
  if (!headers.has('X-PhotoIntel-Source')) headers.set('X-PhotoIntel-Source', 'cloudflare');
  const ray = request.headers.get('cf-ray');
  if (ray && /^[a-z0-9-]{8,64}$/i.test(ray)) headers.set('X-Cloudflare-Ray', ray);
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

export default {
  fetch(request, env) { return handle(request, env); },
};



