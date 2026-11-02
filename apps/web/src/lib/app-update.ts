/** Update the SPA without caching HTML, private media or API responses. */
import { FRONTEND_RELEASE_ID } from './release';

export async function checkForUpdate(): Promise<boolean> {
  if (!FRONTEND_RELEASE_ID) return false;
  const response = await fetch('/__app/version?check=' + Date.now(), {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) return false;
  const data = (await response.json()) as { release?: unknown };
  return (
    typeof data.release === 'string' &&
    /^[0-9a-f]{40}$/.test(data.release) &&
    data.release !== FRONTEND_RELEASE_ID
  );
}

export async function refreshApplication(): Promise<void> {
  // The SW only caches public icons. Never touch private API/media storage.
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => registration.scope === new URL('/', location.origin).href)
        .map(async (registration) => {
          await registration.update().catch(() => undefined);
          registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
        }),
    );
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith('photointel-shell-')).map((key) => caches.delete(key)),
    );
  }
  const url = new URL(location.href);
  url.searchParams.set('__refresh', String(Date.now()));
  location.replace(url.href);
}
