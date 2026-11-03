import { afterEach, describe, expect, it, vi } from 'vitest';
import { runManageDiagnostics } from './diagnostics';
import type { Env } from './auth';

afterEach(() => vi.unstubAllGlobals());

describe('read-only runtime credential diagnostics', () => {
  it('classifies GitHub permission failures and Cloudflare 9106 without exposing token values', async () => {
    const githubToken = 'github-secret-value-never-returned';
    const cloudflareToken = 'cloudflare-secret-value-never-returned';
    const requested: Array<{ path: string; auth: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        const path = String(url);
        const auth = new Headers(options.headers).get('Authorization') || '';
        requested.push({ path, auth });
        expect(options.method).toBe('GET');
        if (path.includes('actions/runs')) {
          return new Response(
            JSON.stringify({ message: 'Resource not accessible by personal access token' }),
            {
              status: 403,
              headers: { 'X-Accepted-GitHub-Permissions': 'actions=read' },
            },
          );
        }
        if (path.includes('workers/scripts')) {
          return new Response(
            JSON.stringify({ errors: [{ code: 9106, message: 'Authentication failed' }] }),
            {
              status: 400,
            },
          );
        }
        return Response.json({ ok: true });
      }),
    );
    const env = {
      GITHUB_REPO: 'rodkisten/photointel',
      GITHUB_ENVIRONMENT: 'production',
      GITHUB_API_TOKEN: githubToken,
      GITHUB_TOKEN_SECRET_VERSION: '2',
      CLOUDFLARE_API_TOKEN: cloudflareToken,
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    } as Env;
    const result = await runManageDiagnostics(env);
    const actions = result.checks.find((item) => item.check === 'Actions · execuções');
    expect(actions?.reason).toBe('insufficient_permissions');
    expect(actions?.accepted_permissions).toBe('actions=read');
    expect(result.checks.find((item) => item.provider === 'cloudflare')?.reason).toBe('authentication_9106');
    expect(result.github_secret_version).toBe('2');
    expect(requested).toHaveLength(5);
    expect(requested.every((item) => item.auth.startsWith('Bearer '))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(githubToken);
    expect(JSON.stringify(result)).not.toContain(cloudflareToken);
  });

  it('reports missing tokens without contacting external APIs', async () => {
    const called = vi.fn();
    vi.stubGlobal('fetch', called);
    const result = await runManageDiagnostics({
      GITHUB_REPO: 'rodkisten/photointel',
      CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
    } as Env);
    expect(result.checks.every((item) => item.reason === 'missing_token')).toBe(true);
    expect(called).not.toHaveBeenCalled();
  });
});
