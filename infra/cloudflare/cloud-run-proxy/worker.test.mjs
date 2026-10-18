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
