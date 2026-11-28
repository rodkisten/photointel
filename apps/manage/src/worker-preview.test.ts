import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ api: vi.fn() }));
import worker from './worker';
import { api } from './api';
import type { Env } from './auth';
import { ISOLATED_CODE_ORIGIN, ISOLATED_SANDBOX_ORIGIN } from './features/modules/security';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('isolated module host protocol', () => {
  it('publishes both paired remote origins without consulting infrastructure', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const response = await worker.fetch(
      new Request('https://pr-263-photointel-manage.kisten.workers.dev/module-host.json'),
      { PHOTOINTEL_PREVIEW: 'true' } as Env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mode: 'isolated-preview',
      sandboxOrigin: ISOLATED_SANDBOX_ORIGIN,
      codeOrigin: ISOLATED_CODE_ORIGIN,
    });
    expect(network).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });
  it('keeps runtime APIs and mutation unavailable on the isolated host', async () => {
    const env = { PHOTOINTEL_PREVIEW: 'true' } as Env;
    const base = 'https://pr-263-photointel-manage.kisten.workers.dev';
    expect(
      (await worker.fetch(new Request(base + '/api/runtime/targets?workspaceId=test'), env)).status,
    ).toBe(404);
    expect(
      (await worker.fetch(new Request(base + '/module-host.json', { method: 'POST' }), env)).status,
    ).toBe(405);
    expect(api).not.toHaveBeenCalled();
  });
});
