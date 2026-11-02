import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  .replace('/*__PHOTOINTEL_PRECACHE__*/ []', "['/assets/app-a12345678.js', '/mark.svg']")
  .replace('__PHOTOINTEL_SW_VERSION__', 'test-release');

function setup() {
  const listeners = new Map();
  const stores = new Map();
  let offline = false;
  let requests = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const contents = stores.get(name);
      return {
        async match(path) {
          return contents.get(path)?.clone();
        },
        async put(path, response) {
          contents.set(path, response.clone());
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(key) {
      return stores.delete(key);
    },
  };
  const self = {
    location: { origin: 'https://photos.migos.club' },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const context = {
    self,
    caches,
    URL,
    Response,
    console,
    importScripts() {
      throw new Error('FCM offline');
    },
    async fetch(input) {
      requests++;
      if (offline) throw new Error('offline');
      const path = typeof input === 'string' ? input : new URL(input.url).pathname;
      if (path.endsWith('.js'))
        return new Response('console.log("app")', {
          headers: { 'content-type': 'application/javascript' },
        });
      if (path.endsWith('.svg'))
        return new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        });
      return new Response('<!doctype html><div id="root"></div>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  };
  vm.runInNewContext(sw, context);
  async function trigger(name, data) {
    const pending = [];
    let response;
    listeners.get(name)({
      ...data,
      waitUntil(promise) {
        pending.push(promise);
      },
      respondWith(promise) {
        response = promise;
      },
    });
    await Promise.all(pending);
    return response ? await response : undefined;
  }
  return {
    trigger,
    stores,
    disconnect() {
      offline = true;
    },
    get requests() {
      return requests;
    },
  };
}

test('precaches the complete shell and serves navigation and JavaScript offline', async () => {
  const env = setup();
  await env.trigger('install');
  assert.equal(env.stores.get('photointel-static-v3').size, 2);
  env.disconnect();
  const page = await env.trigger('fetch', {
    request: { method: 'GET', mode: 'navigate', url: 'https://photos.migos.club/library' },
  });
  assert.match(await page.text(), /root/);
  const js = await env.trigger('fetch', {
    request: { method: 'GET', mode: 'no-cors', url: 'https://photos.migos.club/assets/app-a12345678.js' },
  });
  assert.match(await js.text(), /console.log/);
});

test('never intercepts private media, API, auth, or diagnostics', async () => {
  const env = setup();
  await env.trigger('install');
  const before = env.requests;
  for (const path of [
    '/v1/assets/secret/media/preview_large',
    '/auth/login',
    '/__app/version',
    '/cdn-cgi/access/login',
  ]) {
    const response = await env.trigger('fetch', {
      request: { method: 'GET', mode: 'no-cors', url: 'https://photos.migos.club' + path },
    });
    assert.equal(response, undefined, path);
  }
  assert.equal(env.requests, before);
});

test('keeps immutable assets while removing obsolete shells', async () => {
  const env = setup();
  await env.trigger('install');
  env.stores.set('photointel-shell-old-release', new Map());
  await env.trigger('activate');
  assert.equal(env.stores.has('photointel-shell-old-release'), false);
  assert.equal(env.stores.has('photointel-static-v3'), true);
});
