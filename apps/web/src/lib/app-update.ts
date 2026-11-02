/** Refresh app while preserving the last verified offline shell and immutable assets. */
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
  // The new SW pre-caches the complete release before activation.
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
  const url = new URL(location.href);
  url.searchParams.set('__refresh', String(Date.now()));
  location.replace(url.href);
}
