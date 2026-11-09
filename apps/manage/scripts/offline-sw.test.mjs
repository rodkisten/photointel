import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  .replace('/*__PHOTOINTEL_MANAGE_PRECACHE__*/ []', "['/assets/index-B7x92a0z.js', '/assets/index-Q9w8c7f6.css']")
  .replace('__PHOTOINTEL_MANAGE_SW_VERSION__', 'test-release');

function setup() {
  const listeners = new Map();
  const stores = new Map();
  let offline = false;
  let requests = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const cache = stores.get(name);
      return {
        async match(path) { return cache.get(path)?.clone(); },
        async put(path, response) { cache.set(path, response.clone()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    location: { origin: 'https://photos-manage.migos.club' },
    addEventListener(name, callback) { listeners.set(name, callback); },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  vm.runInNewContext(source, {
    self, caches, URL, Response, console,
    async fetch(input) {
      requests++;
      if (offline) throw new Error('offline');
      const path = typeof input === 'string' ? input : new URL(input.url).pathname;
      if (path.endsWith('.js')) return new Response('console.log("manage")', { headers: { 'content-type': 'application/javascript' } });
      if (path.endsWith('.css')) return new Response('body{color:black}', { headers: { 'content-type': 'text/css' } });
      return new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } });
    },
  });

  async function trigger(name, extra = {}) {
    const pending = [];
    let response;
    listeners.get(name)({
      ...extra,
      waitUntil(promise) { pending.push(promise); },
      respondWith(promise) { response = promise; },
    });
    await Promise.all(pending);
    return response ? await response : undefined;
  }
  return { trigger, stores, disconnect() { offline = true; }, get requests() { return requests; } };
}

test('Manage precaches the whole release and serves a React shell and bundles offline', async () => {
  const env = setup();
  await env.trigger('install');
  assert.equal(env.stores.get('photointel-manage-assets-test-release').size, 2);
  env.disconnect();
  const html = await env.trigger('fetch', {
    request: { method: 'GET', mode: 'navigate', url: 'https://photos-manage.migos.club/triggers' },
  });
  assert.match(await html.text(), /root/);
  const js = await env.trigger('fetch', {
    request: { method: 'GET', mode: 'no-cors', url: 'https://photos-manage.migos.club/assets/index-B7x92a0z.js' },
  });
  assert.match(await js.text(), /console.log/);
});

test('Manage never intercepts API, auth, hooks, diagnostics or cross-origin requests', async () => {
  const env = setup();
  await env.trigger('install');
  const before = env.requests;
  for (const path of ['/api/settings', '/auth/login', '/hooks/github', '/__diagnostics', '/cdn-cgi/access/login']) {
    assert.equal(await env.trigger('fetch', {
      request: { method: 'GET', mode: 'navigate', url: 'https://photos-manage.migos.club' + path },
    }), undefined, path);
  }
  assert.equal(await env.trigger('fetch', {
    request: { method: 'GET', mode: 'navigate', url: 'https://evil.invalid/' },
  }), undefined);
  assert.equal(env.requests, before);
});

test('Manage refuses to precache redirected Access login responses', async () => {
  assert.equal(source.includes('response.redirected'), true);
  assert.equal(source.includes('redirect: \'error\''), true);
});
