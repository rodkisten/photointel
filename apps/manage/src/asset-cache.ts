/**
 * Only compiled static files may survive an offline refresh.
 * Cloudflare Access is checked by the Worker on every online request, so
 * shared CDN caches are disabled even for immutable JS/CSS.
 */
const FINGERPRINTED = /^\/assets\/.+[-.][A-Za-z0-9_-]{8,}\.(?:js|mjs|css|png|jpe?g|svg|webp|avif|woff2?|ico)$/i;
const PUBLIC_IMAGES = /\.(?:png|jpe?g|svg|webp|avif|gif|ico|woff2?|ttf)$/i;

export function manageAssetCachePolicy(path: string, response: Response): string {
  if (response.status !== 200 || /text\/html/i.test(response.headers.get('content-type') || '')) {
    return 'private, no-store';
  }
  if (FINGERPRINTED.test(path)) return 'private, max-age=31536000, immutable';
  if (PUBLIC_IMAGES.test(path)) return 'private, max-age=604800, stale-while-revalidate=86400';
  return 'private, no-store';
}
