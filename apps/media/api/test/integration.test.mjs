import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto, createHash, createHmac } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
globalThis.crypto ??= webcrypto;
async function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).default;
}
const api = await load('../src/index.ts');
const gateway = await load('../../gateway/src/index.ts');
const tenantToken = 'tenant-test-secret-'.repeat(3);
const gatewayToken = 'gateway-source-secret-'.repeat(3);
const signingKey = 'gateway-signing-secret-'.repeat(3);
const imagorSecret = 'imagor-signing-secret-'.repeat(3);
const key = 'originals/tenants/client-a/fixture.png';
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const gatewayEnv = {
  MEDIA_SOURCE_TOKEN: gatewayToken,
  MEDIA_SOURCE_PREFIX: 'originals/tenants/client-a/',
  MEDIA_SIGNING_KEY: signingKey,
  MEDIA_ISSUER_TOKEN: 'unused-issuer-secret-'.repeat(3),
  MEDIA_PREFIX: 'derived/',
  MEDIA_BUCKET: {
    async get(requestedKey) {
      if (requestedKey !== key) return null;
      return { body: bytes, httpMetadata: { contentType: 'image/png' } };
    },
  },
};
const apiEnv = {
  MEDIA_TENANTS_JSON: JSON.stringify([{
    id: 'client-a',
    tokenHash: createHash('sha256').update(tenantToken).digest('hex'),
    sourcePrefix: 'originals/tenants/client-a/',
  }]),
  MEDIA_SOURCE_TOKEN: gatewayToken,
  MEDIA_SOURCE_GATEWAY_URL: 'https://media.example/',
  MEDIA_IMAGOR_URL: 'https://imagor.example/',
  MEDIA_IMAGOR_SECRET: imagorSecret,
};
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
function transformRequest(requestedKey = key, token = tenantToken) {
  return new Request('https://api.example/v1/image/transform', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      key: requestedKey,
      transform: { width: 320, height: 240, format: 'webp', quality: 75, fit: 'contain' },
    }),
  });
}
test('tenant API -> private gateway -> signed Imagor URL -> private R2 bytes', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://media.example/v1/source/sign');
    return gateway.fetch(new Request(String(url), init), gatewayEnv);
  };
  const response = await api.fetch(transformRequest(), apiEnv);
  assert.equal(response.status, 200);
  const { url, expires } = await response.json();
  const imagor = new URL(url);
  assert.equal(imagor.origin, 'https://imagor.example');
  const segments = imagor.pathname.slice(1).split('/');
  const signature = segments.shift();
  const path = segments.join('/');
  assert.equal(signature, createHmac('sha256', imagorSecret).update(path).digest('base64url'));
  const encodedSource = path.split('/b64:')[1];
  assert.ok(encodedSource);
  const sourceUrl = Buffer.from(encodedSource, 'base64url').toString('utf8');
  assert.ok(!sourceUrl.includes(gatewayToken));
  assert.equal(new URL(sourceUrl).origin, 'https://media.example');
  assert.ok(expires <= Math.floor(Date.now() / 1000) + 60);
  const image = await gateway.fetch(new Request(sourceUrl), gatewayEnv);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
  const invalid = new URL(sourceUrl);
  invalid.searchParams.set('sig', '0'.repeat(64));
  assert.equal((await gateway.fetch(new Request(invalid), gatewayEnv)).status, 401);
});
test('cross-tenant transform is denied before any source-signing request', async () => {
  globalThis.fetch = () => { throw Error('Unexpected gateway call'); };
  const response = await api.fetch(
    transformRequest('originals/tenants/client-b/private.png'), apiEnv);
  assert.equal(response.status, 403);
});
test('invalid client credential cannot reach source-signing gateway', async () => {
  globalThis.fetch = () => { throw Error('Unexpected gateway call'); };
  const response = await api.fetch(transformRequest(key, 'wrong-credential'), apiEnv);
  assert.equal(response.status, 401);
});
