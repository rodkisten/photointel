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

test('important logs redact private data and coalesce repeated upstream failures', async t => {
  const log = t.mock.method(console, 'error', () => {});
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const make = () => request('/v1/assets/private-id?token=PRIVATE_QUERY', {
    'cf-access-jwt-assertion': 'PRIVATE_JWT', authorization: 'Bearer PRIVATE_TOKEN',
  });
  const upstream = async () => new Response('PRIVATE_BODY', { status: 500 });
  await handle(make(), env, upstream);
  await handle(make(), env, upstream);
  assert.equal(log.mock.calls.length, 1);
  clock += 61000;
  await handle(make(), env, upstream);
  assert.equal(log.mock.calls.length, 2);
  assert.equal(log.mock.calls[1].arguments[0].suppressed_since_last, 1);
  const serialized = JSON.stringify(log.mock.calls.map(call => call.arguments));
  for (const secret of ['PRIVATE_QUERY', 'PRIVATE_JWT', 'PRIVATE_TOKEN', 'PRIVATE_BODY', 'private-id']) {
    assert.ok(!serialized.includes(secret));
  }
});

test('successful requests and expected authentication failures do not emit logs', async t => {
  const error = t.mock.method(console, 'error', () => {});
  const warning = t.mock.method(console, 'warn', () => {});
  await handle(request(), env);
  await handle(request('/v1/assets', { 'cf-access-jwt-assertion': 'unit' }), env,
    async () => new Response('[]'));
  await handle(request('/v1/assets', { 'cf-access-jwt-assertion': 'unit' }), env,
    async () => new Response(null, { status: 401 }));
  assert.equal(error.mock.calls.length, 0);
  assert.equal(warning.mock.calls.length, 0);
});
