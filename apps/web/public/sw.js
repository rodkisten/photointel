/* Photo Intelligence Cloud - cache do PWA + Firebase Cloud Messaging 13.1.0 */
/* global firebase */

// Registre o clique ANTES dos imports para evitar que o FCM substitua o handler.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const message = notificationData.FCM_MSG || {};
  const requestedUrl =
    notificationData.url ||
    message.fcmOptions?.link ||
    message.data?.url ||
    '/';

  let targetUrl;
  try {
    targetUrl = new URL(requestedUrl, self.location.origin);
    if (targetUrl.origin !== self.location.origin) {
      targetUrl = new URL('/', self.location.origin);
    }
  } catch {
    targetUrl = new URL('/', self.location.origin);
  }

  event.waitUntil((async () => {
    const existingWindows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of existingWindows) {
      if (new URL(client.url).origin !== targetUrl.origin) continue;

      try {
        const navigated = client.url !== targetUrl.href && typeof client.navigate === 'function'
          ? await client.navigate(targetUrl.href)
          : client;
        await (navigated || client).focus();
        return;
      } catch (error) {
        console.warn('[PhotoIntel SW] Falha ao reutilizar janela:', error);
      }
    }

    await self.clients.openWindow(targetUrl.href);
  })());
});

// Firebase SDK compat funciona em um service worker classico, sem bundler.
importScripts('https://www.gstatic.com/firebasejs/13.1.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging-compat.js');

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

/* Apenas a shell estatica e armazenada. API, midia privada e rotas nao sao cacheadas. */
const SHELL_CACHE = 'photointel-shell-v2';
const SHELL_ASSETS = ['/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !SHELL_ASSETS.includes(url.pathname)) return;
  // Network-first refreshes public icons; offline fallback only for these static files.
  event.respondWith(fetch(event.request, { cache: 'no-store' }).then((response) => {
    if (response.ok) void caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});


