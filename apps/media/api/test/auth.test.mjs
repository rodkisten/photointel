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
