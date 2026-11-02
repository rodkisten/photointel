/* Photo Intelligence Cloud - cache do PWA + Firebase Cloud Messaging 13.1.0 */
/* global firebase */

// Registre o clique ANTES dos imports para evitar que o FCM substitua o handler.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const message = notificationData.FCM_MSG || {};
  const requestedUrl = notificationData.url || message.fcmOptions?.link || message.data?.url || '/';

  let targetUrl;
  try {
    targetUrl = new URL(requestedUrl, self.location.origin);
    if (targetUrl.origin !== self.location.origin) {
      targetUrl = new URL('/', self.location.origin);
    }
  } catch {
    targetUrl = new URL('/', self.location.origin);
  }

  event.waitUntil(
    (async () => {
      const existingWindows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of existingWindows) {
        if (new URL(client.url).origin !== targetUrl.origin) continue;

        try {
          const navigated =
            client.url !== targetUrl.href && typeof client.navigate === 'function'
              ? await client.navigate(targetUrl.href)
              : client;
          await (navigated || client).focus();
          return;
        } catch (error) {
          console.warn('[PhotoIntel SW] Falha ao reutilizar janela:', error);
        }
      }

      await self.clients.openWindow(targetUrl.href);
    })(),
  );
});

// Firebase SDK compat funciona em um service worker classico, sem bundler.
try {
  importScripts('https://www.gstatic.com/firebasejs/13.1.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging-compat.js');
} catch (error) {
  console.warn('[PhotoIntel SW] Firebase SDK unavailable; offline mode remains active.', error);
}

if (typeof firebase !== 'undefined' && typeof firebase.messaging === 'function') {
  firebase.initializeApp({
    apiKey: 'AIzaSyAnhQBb9OHKyg93cCyNxlPY4Ny5HW25vHY',
    authDomain: 'photointel-firebase.firebaseapp.com',
    projectId: 'photointel-firebase',
    storageBucket: 'photointel-firebase.firebasestorage.app',
    messagingSenderId: '723658488603',
    appId: '1:723658488603:web:64c64e34743b9aabe431be',
    measurementId: 'G-RE93MWG6FN',
  });

  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    console.info('[PhotoIntel SW] Mensagem em segundo plano:', payload);

    // O Firebase ja exibe notificacoes com payload.notification automaticamente.
    // Somente as mensagens data-only precisam de showNotification manual.
    if (payload.notification) return;

    const data = payload.data || {};
    return self.registration.showNotification(data.title || 'Photo Intelligence Cloud', {
      body: data.body || 'Voce recebeu uma nova atualizacao.',
      icon: '/icon-192.png',
      data: { url: data.url || '/' },
    });
  });
}

/* Public SPA shell and build-stamped immutable assets. No private/API caching. */
const SW_BUILD = '__PHOTOINTEL_SW_VERSION__';
const SHELL_CACHE = 'photointel-shell-' + SW_BUILD;
const ASSET_CACHE = 'photointel-static-v3';
const PRECACHE = /*__PHOTOINTEL_PRECACHE__*/ [];
const PRIVATE = /^\/(?:v1(?:\/|$)|auth(?:\/|$)|__|cdn-cgi(?:\/|$)|api(?:\/|$)|\.)/;
const HASHED = /^\/assets\/[\w./-]+[-.][a-zA-Z0-9_-]{8,}\.(?:js|mjs|css|woff2?|png|svg|webp|avif)$/;
function valid(response, path) {
  if (!response.ok || response.redirected || response.type === 'opaque') return false;
  const type = response.headers.get('content-type') || '';
  if (/\.(?:js|mjs)$/.test(path)) return /javascript|ecmascript/.test(type);
  if (/\.css$/.test(path)) return /text\/css/.test(type);
  if (/\.html$/.test(path)) return /text\/html/.test(type);
  return !/text\/html/.test(type);
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      const assets = await caches.open(ASSET_CACHE);
      // An incomplete install must not replace a working previous release.
      const files = ['/index.html', ...PRECACHE.filter((url) => url !== '/index.html')];
      for (let index = 0; index < files.length; index += 12) {
        await Promise.all(
          files.slice(index, index + 12).map(async (path) => {
            const response = await fetch(path, {
              cache: 'reload',
              credentials: 'same-origin',
              redirect: 'error',
            });
            if (!valid(response, path)) throw new Error('Invalid asset: ' + path);
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
      await Promise.all(
        keys
          .filter((key) => key.startsWith('photointel-shell-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      );
      // The static cache is intentionally retained across releases.
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        event.ports?.[0]?.postMessage({
          shellReady: Boolean(await cache.match('/index.html')),
          version: SW_BUILD,
          assetCount: PRECACHE.length,
        });
      })(),
    );
  }
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || PRIVATE.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(req);
          if (response.status < 500) return response;
        } catch {
          // Offline fallback below.
        }
        return (
          (await caches.open(SHELL_CACHE)).match('/index.html') ||
          new Response('PhotoIntel precisa ser aberto online uma vez.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        );
      })(),
    );
    return;
  }
  if (!PRECACHE.includes(url.pathname) && !HASHED.test(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(url.pathname);
      if (hit) return hit;
      const response = await fetch(req);
      if (valid(response, url.pathname)) {
        event.waitUntil(cache.put(url.pathname, response.clone()));
      }
      return response;
    })(),
  );
});
