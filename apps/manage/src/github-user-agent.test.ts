import { afterEach, describe, expect, it, vi } from 'vitest';
import { provider } from './providers';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub REST request compatibility from Cloudflare Worker', () => {
  it('sets the mandatory GitHub User-Agent without changing non-GitHub requests', async () => {
    const headers: Array<{ host: string; userAgent: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      headers.push({
        host: new URL(url).hostname,
        userAgent: new Headers(init.headers).get('User-Agent'),
      });
      return Response.json({ ok: true });
    }));
    await provider('https://api.github.com/repos/rodkisten/photointel', '');
    await provider('https://example.com/', '');
    expect(headers).toEqual([
      { host: 'api.github.com', userAgent: 'PhotoIntel-Manage' },
      { host: 'example.com', userAgent: null },
    ]);
  });
});
