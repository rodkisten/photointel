import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './worker.mjs';

const env = {
  CLOUD_RUN_ORIGIN: 'https://photointel-api-123.a.run.app',
  FRONTEND_ORIGIN: 'https://fotos.example.com',
};

function request(path = '/v1/assets', headers = {}) {
  return new Request('https://api.example.com' + path, { headers });
}

test('does not contact an upstream without Access or on an unconfigured origin', async () => {
  const fetchOrigin = () => { throw new Error('must not fetch'); };
  assert.equal((await handle(request(), env, fetchOrigin)).status, 401);
  assert.equal((await handle(request('/v1/assets', {
    'cf-access-authenticated-user-email': 'owner@example.com',
  }), env, fetchOrigin)).status, 401);
  assert.equal((await handle(request(), {
    ...env, CLOUD_RUN_ORIGIN: 'https://evil.example.com',
  }, fetchOrigin)).status, 503);
  assert.equal((await handle(request('/admin'), env, fetchOrigin)).status, 404);
});

test('fixed upstream preserves JWT/device credentials while dropping forged proxy headers', async () => {
  let calls = 0;
  const response = await handle(request('/v1/bridge/status?next=https://evil.invalid', {
    'cf-access-jwt-assertion': 'signed-at-edge', authorization: 'Bearer bridge_unit',
    'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'evil.invalid',
    'cf-access-authenticated-user-email': 'forged@example.com',
    'cf-access-client-secret': 'must-not-forward',
    cookie: 'other=must-not-forward',
  }), env, async upstream => {
    calls++;
    assert.equal(new URL(upstream.url).origin, env.CLOUD_RUN_ORIGIN);
    assert.equal(upstream.headers.get('cf-access-jwt-assertion'), 'signed-at-edge');
    assert.equal(upstream.headers.get('authorization'), 'Bearer bridge_unit');
    assert.equal(upstream.headers.get('x-forwarded-for'), null);
    assert.equal(upstream.headers.get('cf-access-client-secret'), null);
    assert.equal(upstream.headers.get('cf-access-authenticated-user-email'), null);
    assert.equal(upstream.headers.get('cookie'), null);
    return new Response('private', { headers: { 'set-cookie': 'not-forwarded=true' } });
  });
  assert.equal(calls, 1);
  assert.equal(await response.text(), 'private');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('unexpected redirect is not followed, and exact-origin preflight is bounded', async () => {
  const response = await handle(request('/v1/assets', {
    'cf-access-jwt-assertion': 'edge-jwt',
  }), env, async upstream => {
    assert.equal(upstream.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } });
  });
  assert.equal(response.status, 502);
  for (const origin of ['https://evil.invalid', env.FRONTEND_ORIGIN]) {
    const preflight = await handle(new Request('https://api.example.com/v1/search', {
      method: 'OPTIONS', headers: { origin },
    }), env);
    assert.equal(preflight.status, origin === env.FRONTEND_ORIGIN ? 204 : 403);
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');
  }
});


test('one Worker serves frontend assets only on frontend host and proxies /v1', async () => {
  const seen = [];
  const assetEnv = {
    ...env,
    ASSETS: {
      fetch: async request => {
        seen.push(new URL(request.url).pathname);
        return new Response('<!doctype html><title>PhotoIntel</title>', {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    },
  };
  const home = await handle(new Request('https://fotos.example.com/'), assetEnv);
  assert.equal(home.status, 200);
  const spa = await handle(new Request('https://fotos.example.com/library'), assetEnv);
  assert.equal(spa.status, 200);
  assert.deepEqual(seen, ['/', '/library']);

  const outsideHost = await handle(new Request('https://api.example.com/library'), assetEnv);
  assert.equal(outsideHost.status, 404);
  const blocked = await handle(new Request('https://fotos.example.com/v1/assets'), assetEnv);
  assert.equal(blocked.status, 401);
  assert.deepEqual(seen, ['/', '/library'], 'API must never be served as HTML SPA');

  const proxied = await handle(new Request('https://fotos.example.com/v1/assets', {
    headers: { 'cf-access-jwt-assertion': 'valid-edge-assertion' },
  }), assetEnv, async upstream => {
    assert.equal(upstream.url, env.CLOUD_RUN_ORIGIN + '/v1/assets');
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(proxied.status, 200);
  assert.equal(await proxied.text(), '[]');
  assert.deepEqual(seen, ['/', '/library']);
});


test('missing assets produces an actionable error and one important log', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const response = await handle(new Request('https://fotos.example.com/'), env);
  assert.equal(response.status, 503);
  assert.equal(log.mock.calls.length, 1);
  assert.equal(log.mock.calls[0].arguments[0].event, 'frontend_assets_binding_missing');
});

test('important edge errors are individually correlated and redact private data', async t => {
  const log = t.mock.method(console, 'error', () => {});
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const make = () => request('/v1/assets/private-id?token=PRIVATE_QUERY', {
    'cf-access-jwt-assertion': 'PRIVATE_JWT', authorization: 'Bearer PRIVATE_TOKEN',
  });
  const upstream = async () => new Response('PRIVATE_BODY', { status: 500 });
  await handle(make(), env, upstream);
  await handle(make(), env, upstream);
  assert.equal(log.mock.calls.length, 2);
  assert.ok(log.mock.calls.every(call => Boolean(call.arguments[0].correlation_id)));
  assert.notEqual(log.mock.calls[0].arguments[0].correlation_id,
    log.mock.calls[1].arguments[0].correlation_id);
  clock += 61000;
  await handle(make(), env, upstream);
  assert.equal(log.mock.calls.length, 3);
  const serialized = JSON.stringify(log.mock.calls.map(call => call.arguments));
  for (const secret of ['PRIVATE_QUERY', 'PRIVATE_JWT', 'PRIVATE_TOKEN', 'PRIVATE_BODY', 'private-id']) {
    assert.ok(!serialized.includes(secret));
  }
});

test('successful requests and missing sessions do not emit logs', async t => {
  const error = t.mock.method(console, 'error', () => {});
  const warning = t.mock.method(console, 'warn', () => {});
  await handle(request(), env);
  await handle(request('/v1/assets', { 'cf-access-jwt-assertion': 'unit' }), env,
    async () => new Response('[]'));
  assert.equal(error.mock.calls.length, 0);
  assert.equal(warning.mock.calls.length, 0);
});


test('same-origin Access cookie is transported as assertion without other cookies', async () => {
  const response = await handle(new Request('https://fotos.example.com/v1/assets', {
    headers: { cookie: 'other=PRIVATE; CF_Authorization=unit.jwt.sig; analytics=NO' },
  }), env, async upstream => {
    assert.equal(upstream.headers.get('cf-access-jwt-assertion'), 'unit.jwt.sig');
    assert.equal(upstream.headers.get('cookie'), null);
    return new Response('[]');
  });
  assert.equal(response.status, 200);
});

test('missing and ambiguous sessions stay blocked; legacy host does not consume cookies', async () => {
  for (const [host, cookie] of [
    ['fotos.example.com', 'CF_Authorization=not-a-jwt'],
    ['fotos.example.com', 'CF_Authorization=a.b.c; CF_Authorization=x.y.z'],
    ['api.example.com', 'CF_Authorization=a.b.c'],
  ]) {
    const response = await handle(new Request('https://' + host + '/v1/assets', {
      headers: { cookie },
    }), env, () => { throw new Error('must not fetch'); });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('X-PhotoIntel-Auth'), 'session-missing');
  }
});

test('explicit assertion takes precedence over cookie and upstream JWT rejection stays blocked', async t => {
  const log = t.mock.method(console, 'warn', () => {});
  const response = await handle(new Request('https://fotos.example.com/v1/assets?private=SECRET', {
    headers: { 'cf-access-jwt-assertion': 'header-jwt', cookie: 'CF_Authorization=cookie.jwt.sig' },
  }), env, async upstream => {
    assert.equal(upstream.headers.get('cf-access-jwt-assertion'), 'header-jwt');
    return new Response('unauthorized', { status: 401 });
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-PhotoIntel-Auth'), 'upstream-rejected');
  assert.equal(log.mock.calls[0].arguments[0].event, 'upstream_auth_rejected');
  assert.ok(!JSON.stringify(log.mock.calls).includes('SECRET'));
  assert.ok(!JSON.stringify(log.mock.calls).includes('header-jwt'));
});


test('login navigation targets configured Access application and ignores caller redirects', async () => {
  const configured = { ...env, ACCESS_TEAM_DOMAIN: 'photointel.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64) };
  const response = await handle(new Request('https://fotos.example.com/auth/login?redirect_url=https://evil.invalid'), configured);
  assert.equal(response.status, 302);
  const login = new URL(response.headers.get('location'));
  assert.equal(login.origin, 'https://photointel.cloudflareaccess.com');
  assert.equal(login.pathname, '/cdn-cgi/access/login/fotos.example.com');
  assert.equal(login.searchParams.get('kid'), 'a'.repeat(64));
  assert.equal(login.searchParams.get('redirect_url'), 'https://fotos.example.com/');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('missing login config cannot silently return SPA or redirect to an arbitrary domain', async t => {
  t.mock.method(console, 'error', () => {});
  for (const team of [undefined, 'evil.example.org', 'photointel.cloudflareaccess.com@evil.invalid']) {
    const response = await handle(new Request('https://fotos.example.com/auth/login'), {
      ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUDIENCE: 'a'.repeat(64),
    });
    assert.equal(response.status, 503);
  }
});

test('a broken Cloud Run setting cannot blank the frontend shell', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const config = { FRONTEND_ORIGIN: env.FRONTEND_ORIGIN, CLOUD_RUN_ORIGIN: 'not-a-url',
    ASSETS: { fetch: async () => new Response('<!doctype html><div id="root"></div>',
      { headers: { 'Content-Type': 'text/html' } }) } };
  for (const path of ['/', '/library', '/assets/app.js']) {
    const response = await handle(new Request(env.FRONTEND_ORIGIN + path), config);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('X-PhotoIntel-Source'), 'cloudflare');
    assert.match(response.headers.get('X-Correlation-ID'), /^[0-9a-f-]{36}$/);
  }
  const api = await handle(new Request(env.FRONTEND_ORIGIN + '/v1/assets'), config);
  assert.equal(api.status, 503);
  assert.equal(errors.mock.calls.at(-1).arguments[0].event, 'routing_config_invalid');
  assert.equal(errors.mock.calls.at(-1).arguments[0].correlation_id,
    api.headers.get('X-Correlation-ID'));
});

test('browser reports contain only approved metadata and can be searched by ID', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const id = '75ce59c1-fc9b-4d20-9f1e-e40a9d4e954d';
  const url = env.FRONTEND_ORIGIN + '/__diagnostics/client-errors';
  const response = await handle(new Request(url, {
    method: 'POST',
    headers: { Origin: env.FRONTEND_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, phase: 'render', code: 'CLIENT_FAILURE',
      secret: 'DO_NOT_LOG_THIS', stack: 'private' }),
  }), env);
  assert.equal(response.status, 204);
  assert.equal(errors.mock.calls.at(-1).arguments[0].correlation_id, id);
  assert.ok(!JSON.stringify(errors.mock.calls).includes('DO_NOT_LOG_THIS'));
  const blocked = await handle(new Request(url, {
    method: 'POST',
    headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, phase: 'render', code: 'CLIENT_FAILURE' }),
  }), env);
  assert.equal(blocked.status, 403);
});
