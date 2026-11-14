import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto, createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const ts = require('typescript');
globalThis.crypto ??= webcrypto;
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const api = (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).default;
const token = 'client-secret-'.repeat(4);
const env = {
  MEDIA_TENANTS_JSON: JSON.stringify([{
    id: 'tenant-a',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    sourcePrefix: 'originals/tenants/tenant-a/',
  }]),
  MEDIA_SOURCE_TOKEN: 's'.repeat(48),
  MEDIA_SOURCE_GATEWAY_URL: 'https://media.example/',
};
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
function request(key, auth = token) {
  return new Request('https://api.example/v1/source/sign', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + auth },
    body: JSON.stringify({ key }),
  });
}
test('rejects unknown client credentials', async () => {
  assert.equal((await api.fetch(request('originals/tenants/tenant-a/a.jpg', 'wrong'), env)).status, 401);
});
test('rejects cross-tenant access without contacting gateway', async () => {
  globalThis.fetch = () => { throw Error('Unexpected network request'); };
  assert.equal((await api.fetch(request('originals/tenants/tenant-b/a.jpg'), env)).status, 403);
});
test('rejects path traversal and encoded separators', async () => {
  globalThis.fetch = () => { throw Error('Unexpected network request'); };
  for (const key of ['originals/tenants/tenant-a/../tenant-b/a.jpg',
    'originals/tenants/tenant-a/%2e%2e/a.jpg']) {
    assert.equal((await api.fetch(request(key), env)).status, 403);
  }
});
test('mints source URL through authenticated private gateway', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://media.example/v1/source/sign');
    assert.equal(init.headers.Authorization, 'Bearer ' + env.MEDIA_SOURCE_TOKEN);
    assert.equal(JSON.parse(init.body).key, 'originals/tenants/tenant-a/a.jpg');
    return Response.json({ url: 'https://media.example/v1/source/originals/tenants/tenant-a/a.jpg?exp=1234567890&sig=' + 'a'.repeat(64), expires: 1234567890 });
  };
  const response = await api.fetch(request('originals/tenants/tenant-a/a.jpg'), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).expires, 1234567890);
});
test('rejects gateway URLs pointing to a different origin', async () => {
  globalThis.fetch = async () => Response.json({ url: 'https://evil.example/v1/source/originals/tenants/tenant-a/a.jpg', expires: 1234567890 });
  assert.equal((await api.fetch(request('originals/tenants/tenant-a/a.jpg'), env)).status, 502);
});

test('generates SHA256-signed Imagor transform URL with expiring private source', async () => {
  const expires = Math.floor(Date.now() / 1000) + 50;
  globalThis.fetch = async () => Response.json({
    url: 'https://media.example/v1/source/originals/tenants/tenant-a/a.jpg?exp=' + expires + '&sig=' + 'a'.repeat(64),
    expires,
  });
  const transformEnv = { ...env, MEDIA_IMAGOR_URL: 'https://imagor.example/', MEDIA_IMAGOR_SECRET: 'i'.repeat(48) };
  const response = await api.fetch(new Request('https://api.example/v1/image/transform', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: JSON.stringify({ key: 'originals/tenants/tenant-a/a.jpg',
      transform: { width: 400, height: 300, format: 'webp', quality: 75, fit: 'contain' } }),
  }), transformEnv);
  assert.equal(response.status, 200);
  const result = await response.json();
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://imagor.example');
  const parts = url.pathname.slice(1).split('/');
  const signature = parts.shift();
  const path = parts.join('/');
  assert.ok(path.startsWith('fit-in/400x300/filters:quality(75):format(webp):expire('));
  assert.ok(path.includes('/b64:'));
  const expected = createHash('sha256');
  const { createHmac } = await import('node:crypto');
  const digest = createHmac('sha256', transformEnv.MEDIA_IMAGOR_SECRET).update(path).digest('base64url');
  assert.equal(signature, digest);
  assert.equal(result.expires, expires);
});
test('rejects excessive dimensions and unsupported transforms before gateway access', async () => {
  globalThis.fetch = () => { throw Error('Unexpected gateway request'); };
  for (const transform of [
    { width: 5000, height: 300 }, { width: 400, height: 300, format: 'svg' },
    { width: 400, height: 300, quality: 100 }, { width: 400, height: 300, blur: 10 },
  ]) {
    const response = await api.fetch(new Request('https://api.example/v1/image/transform', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ key: 'originals/tenants/tenant-a/a.jpg', transform }),
    }), env);
    assert.equal(response.status, 400);
  }
});
