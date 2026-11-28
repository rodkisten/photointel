import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchManifest, releasePolicy } from './runtime';
vi.mock('@module-federation/enhanced/runtime', () => ({ loadRemote: vi.fn(), registerRemotes: vi.fn() }));
const sha = 'a'.repeat(40);
const code = {
  schemaVersion: 1,
  id: 'code',
  name: 'rod_code',
  version: '0.2.0',
  gitSha: sha,
  contractMajor: 1,
  entry: `https://shell.migos.club/modules/code/${sha}/mf-manifest.json`,
  standaloneUrl: 'https://shell.migos.club/workflow/',
  exposes: ['./App'],
  capabilities: ['workflow.edit'],
};
afterEach(() => vi.unstubAllGlobals());
describe('per-module trusted release policy', () => {
  it('rejects PR origins and cross-module pointers before requesting them', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    for (const path of [
      'https://pr-28.preview.shell.migos.club/workflow/rod-module.json',
      'https://sandbox.migos.club/rod-module.json',
      `https://shell.migos.club/modules/sandbox/${sha}/rod-module.json`,
    ])
      await expect(fetchManifest(path, new AbortController().signal, releasePolicy('code'))).rejects.toThrow(
        'Untrusted manifest',
      );
    expect(request).not.toHaveBeenCalled();
  });
  it('accepts pinned immutable Code artifacts and rejects swapped identities', async () => {
    const request = vi.fn(async () => Response.json(code));
    vi.stubGlobal('fetch', request);
    const url = `https://shell.migos.club/modules/code/${sha}/rod-module.json`;
    expect((await fetchManifest(url, new AbortController().signal, releasePolicy('code'))).gitSha).toBe(sha);
    request.mockImplementation(async () => Response.json({ ...code, id: 'sandbox' }));
    await expect(fetchManifest(url, new AbortController().signal, releasePolicy('code'))).rejects.toThrow();
  });
});
