/* PhotoIntel Manage: offline-only public application shell, never account data. */
const BUILD = '__PHOTOINTEL_MANAGE_SW_VERSION__';
const PRECACHE = /*__PHOTOINTEL_MANAGE_PRECACHE__*/ [];
const SHELL_CACHE = 'photointel-manage-shell-' + BUILD;
const ASSET_CACHE = 'photointel-manage-assets-' + BUILD;
const BLOCKED = /^\/(?:api|auth|hooks|__|cdn-cgi)(?:\/|$)|^\/\./;

function acceptable(response, path) {
  if (!response.ok || response.redirected || response.type === 'opaque') return false;
  const type = response.headers.get('content-type') || '';
  if (path === '/index.html') return /text\/html/i.test(type);
  if (/\.(?:js|mjs)$/i.test(path)) return /javascript|ecmascript/i.test(type);
  if (/\.css$/i.test(path)) return /text\/css/i.test(type);
  return !/text\/html/i.test(type);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      const assets = await caches.open(ASSET_CACHE);
      const paths = ['/index.html', ...PRECACHE.filter((path) => path !== '/index.html')];
      for (let index = 0; index < paths.length; index += 12) {
        await Promise.all(
          paths.slice(index, index + 12).map(async (path) => {
            const response = await fetch(path, {
              credentials: 'same-origin',
              redirect: 'error',
              cache: 'reload',
            });
            // Cloudflare Access login pages and incomplete builds must never be cached.
            if (!acceptable(response, path)) throw new Error('Cannot precache ' + path);
            await (path === '/index.html' ? shell : assets).put(path, response);
          }),
        );
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldAssets = keys.filter(
        (key) => key.startsWith('photointel-manage-assets-') && key !== ASSET_CACHE,
      );
      const expired = [
        ...keys.filter(
          (key) => key.startsWith('photointel-manage-shell-') && key !== SHELL_CACHE,
        ),
        ...oldAssets.slice(0, -2),
      ];
      await Promise.all(expired.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(
      (async () => {
        const shell = await caches.open(SHELL_CACHE);
        event.ports?.[0]?.postMessage({
          shellReady: Boolean(await shell.match('/index.html')),
          version: BUILD,
          assetCount: PRECACHE.length,
        });
      })(),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || BLOCKED.test(url.pathname)) return;
  // sw.js must always be fetched from the network so upgrades are discovered.
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          // Never persist authenticated pages or an Access login form.
          if (response.status < 500) return response;
        } catch {
          // The cached HTML is only the empty SPA bootstrap; no API data is stored.
        }
        const shell = await caches.open(SHELL_CACHE);
        return (
          (await shell.match('/index.html')) ||
          new Response('Abra o PhotoIntel Manage online uma vez.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        );
      })(),
    );
    return;
  }

  if (!PRECACHE.includes(url.pathname)) return;
  event.respondWith(
    (async () => {
      const assets = await caches.open(ASSET_CACHE);
      const cached = await assets.match(url.pathname);
      if (cached) return cached;
      const response = await fetch(request);
      if (acceptable(response, url.pathname)) {
        event.waitUntil(assets.put(url.pathname, response.clone()));
      }
      return response;
    })(),
  );
});
