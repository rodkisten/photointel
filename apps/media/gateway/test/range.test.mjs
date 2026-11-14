import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
globalThis.crypto ??= webcrypto;
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const worker = (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).default;
const secret = 's'.repeat(48);
const issuer = 'i'.repeat(48);
const data = new TextEncoder().encode('0123456789');
const calls = [];
const env = {
  MEDIA_SIGNING_KEY: secret,
  MEDIA_ISSUER_TOKEN: issuer,
  MEDIA_PREFIX: 'derived/',
  MEDIA_BUCKET: {
    async head(key) { return key === 'derived/test.mp4' ? { size: data.length } : null; },
    async get(key, options) {
      calls.push(options);
      if (key !== 'derived/test.mp4') return null;
      const range = options?.range;
      const bytes = range ? data.slice(range.offset, range.offset + range.length) : data;
      return { body: bytes, httpMetadata: { contentType: 'video/mp4' }, httpEtag: '"test"' };
    },
  },
};
async function signedUrl() {
  const response = await worker.fetch(new Request('https://media.example/v1/sign', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + issuer },
    body: JSON.stringify({ key: 'derived/test.mp4', ttl: 300 }),
  }), env);
  assert.equal(response.status, 200);
  return (await response.json()).url;
}
test('returns full video with byte-range support advertised', async () => {
  const response = await worker.fetch(new Request(await signedUrl()), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(await response.text(), '0123456789');
});
test('returns 206 for a bounded byte range', async () => {
  const response = await worker.fetch(new Request(await signedUrl(), {
    headers: { Range: 'bytes=2-5' },
  }), env);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('Content-Length'), '4');
  assert.equal(await response.text(), '2345');
});
test('supports suffix byte ranges', async () => {
  const response = await worker.fetch(new Request(await signedUrl(), {
    headers: { Range: 'bytes=-3' },
  }), env);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '789');
});
test('rejects unsatisfiable and multipart ranges', async () => {
  for (const range of ['bytes=100-200', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=foo']) {
    const response = await worker.fetch(new Request(await signedUrl(), {
      headers: { Range: range },
    }), env);
    assert.equal(response.status, 416, range);
  }
});
test('rejects unsigned requests', async () => {
  const response = await worker.fetch(new Request('https://media.example/v1/media/derived/test.mp4'), env);
  assert.equal(response.status, 404);
});

test('HEAD returns metadata without reading a body', async () => {
  const response = await worker.fetch(new Request(await signedUrl(), { method: 'HEAD' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(await response.text(), '');
});
test('refuses signing without a trusted issuer token', async () => {
  const response = await worker.fetch(new Request('https://media.example/v1/sign', {
    method: 'POST',
    body: JSON.stringify({ key: 'derived/test.mp4', ttl: 300 }),
  }), env);
  assert.equal(response.status, 401);
});
test('refuses tampered signatures', async () => {
  const url = new URL(await signedUrl());
  url.searchParams.set('sig', '0'.repeat(64));
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 403);
});

test('rejects access outside a configured tenant prefix', async () => {
  const tenantEnv = { ...env, MEDIA_PREFIX: 'derived/tenants/tenant-a/' };
  const response = await worker.fetch(new Request('https://media.example/v1/sign', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + issuer },
    body: JSON.stringify({ key: 'derived/test.mp4', ttl: 300 }),
  }), tenantEnv);
  assert.equal(response.status, 403);
});
test('fails closed on invalid or absent R2 prefixes', async () => {
  for (const prefix of ['', 'originals/', 'derived/../', 'derived']) {
    const response = await worker.fetch(new Request('https://media.example/v1/sign', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + issuer },
      body: JSON.stringify({ key: 'derived/test.mp4', ttl: 300 }),
    }), { ...env, MEDIA_PREFIX: prefix });
    assert.equal(response.status, 503, prefix);
  }
});

test('private Imagor origin is disabled without its own secret', async () => {
  const response = await worker.fetch(new Request('https://media.example/v1/source/originals/a.jpg'), env);
  assert.equal(response.status, 404);
});
test('private Imagor origin requires separate bearer authorization', async () => {
  const sourceEnv = { ...env, MEDIA_SOURCE_TOKEN: 'o'.repeat(48), MEDIA_SOURCE_PREFIX: 'originals/tenant-a/' };
  const response = await worker.fetch(new Request('https://media.example/v1/source/originals/tenant-a/a.jpg'), sourceEnv);
  assert.equal(response.status, 401);
});
test('private Imagor origin restricts tenant and rejects traversal', async () => {
  const sourceEnv = { ...env, MEDIA_SOURCE_TOKEN: 'o'.repeat(48), MEDIA_SOURCE_PREFIX: 'originals/tenant-a/' };
  for (const path of ['originals/tenant-b/a.jpg', 'originals/tenant-a/../tenant-b/a.jpg', 'originals/tenant-a/%252e%252e/a.jpg']) {
    const response = await worker.fetch(new Request('https://media.example/v1/source/' + path, {
      headers: { Authorization: 'Bearer ' + sourceEnv.MEDIA_SOURCE_TOKEN },
    }), sourceEnv);
    assert.equal(response.status, 404, path);
  }
});
test('private Imagor origin reads only the permitted R2 object', async () => {
  const sourceEnv = {
    ...env,
    MEDIA_SOURCE_TOKEN: 'o'.repeat(48),
    MEDIA_SOURCE_PREFIX: 'originals/tenant-a/',
    MEDIA_BUCKET: {
      ...env.MEDIA_BUCKET,
      async get(key) {
        assert.equal(key, 'originals/tenant-a/a.jpg');
        return { body: new TextEncoder().encode('private image'), httpMetadata: { contentType: 'image/jpeg' } };
      },
    },
  };
  const response = await worker.fetch(new Request('https://media.example/v1/source/originals/tenant-a/a.jpg', {
    headers: { Authorization: 'Bearer ' + sourceEnv.MEDIA_SOURCE_TOKEN },
  }), sourceEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(await response.text(), 'private image');
});

test('mints an Imagor-compatible short-lived private source URL', async () => {
  const sourceEnv = {
    ...env,
    MEDIA_SOURCE_TOKEN: 'o'.repeat(48),
    MEDIA_SOURCE_PREFIX: 'originals/tenant-a/',
    MEDIA_BUCKET: {
      ...env.MEDIA_BUCKET,
      async get(key) {
        assert.equal(key, 'originals/tenant-a/a.jpg');
        return { body: new TextEncoder().encode('private image'), httpMetadata: { contentType: 'image/jpeg' } };
      },
    },
  };
  const mint = await worker.fetch(new Request('https://media.example/v1/source/sign', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sourceEnv.MEDIA_SOURCE_TOKEN },
    body: JSON.stringify({ key: 'originals/tenant-a/a.jpg' }),
  }), sourceEnv);
  assert.equal(mint.status, 200);
  const { url, expires } = await mint.json();
  assert.ok(expires <= Math.floor(Date.now() / 1000) + 60);
  assert.ok(!url.includes(sourceEnv.MEDIA_SOURCE_TOKEN));
  const image = await worker.fetch(new Request(url), sourceEnv);
  assert.equal(image.status, 200);
  assert.equal(await image.text(), 'private image');
  const tampered = new URL(url);
  tampered.searchParams.set('sig', '0'.repeat(64));
  assert.equal((await worker.fetch(new Request(tampered), sourceEnv)).status, 401);
  const expired = new URL(url);
  expired.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 1));
  assert.equal((await worker.fetch(new Request(expired), sourceEnv)).status, 401);
});
test('source URL minting rejects cross-tenant keys and unauthenticated clients', async () => {
  const sourceEnv = { ...env, MEDIA_SOURCE_TOKEN: 'o'.repeat(48), MEDIA_SOURCE_PREFIX: 'originals/tenant-a/' };
  const mint = (key, authorized) => worker.fetch(new Request('https://media.example/v1/source/sign', {
    method: 'POST',
    headers: authorized ? { Authorization: 'Bearer ' + sourceEnv.MEDIA_SOURCE_TOKEN } : {},
    body: JSON.stringify({ key }),
  }), sourceEnv);
  assert.equal((await mint('originals/tenant-a/a.jpg', false)).status, 401);
  assert.equal((await mint('originals/tenant-b/a.jpg', true)).status, 403);
});
