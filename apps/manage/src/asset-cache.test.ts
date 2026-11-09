import { describe, expect, it } from 'vitest';
import { manageAssetCachePolicy } from './asset-cache';

describe('Manage private asset caching', () => {
  it('never caches HTML, API results or failures', () => {
    const html = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    expect(manageAssetCachePolicy('/triggers', html)).toContain('no-store');
    expect(manageAssetCachePolicy('/assets/index-aabbccdd.js', html)).toContain('no-store');
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(manageAssetCachePolicy('/api/logs', json)).toContain('no-store');
    expect(manageAssetCachePolicy('/assets/app-aabbccdd.js', new Response('missing', { status: 404 }))).toContain('no-store');
  });

  it('pins hashed bundles in the device only', () => {
    const js = new Response('export {}', { headers: { 'content-type': 'application/javascript' } });
    expect(manageAssetCachePolicy('/assets/index-AB12cd34.js', js)).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(manageAssetCachePolicy('/icon.svg', new Response('<svg/>'))).toContain('max-age=604800');
    expect(manageAssetCachePolicy('/sw.js', js)).toContain('no-store');
  });
});
