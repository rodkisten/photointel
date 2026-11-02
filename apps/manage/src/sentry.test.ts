import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './auth';
import { captureManageError, manageSentryEndpoint, safeManageMessage } from './sentry';
import type { Env } from './auth';

const DSN = 'https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/456';

afterEach(() => vi.unstubAllGlobals());

describe('Manage Sentry transport', () => {
  it('requires only a public ingest DSN and never another token', async () => {
    const sent = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', sent);
    const env = { SENTRY_DSN: DSN, SENTRY_ORG: 'migos-club' } as Env;
    const fault = new ApiError(503, 'GITHUB_401', 'GitHub token recusado: HTTP 401');
    const incident = captureManageError(env, fault, {
      correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      route: '/api/overview',
      method: 'GET',
      provider: 'github',
    });
    expect(incident?.eventId).toMatch(/^[a-f0-9]{32}$/);
    await incident?.delivered;
    expect(sent).toHaveBeenCalledOnce();
    const [url, options] = sent.mock.calls[0];
    expect(url).toBe('https://o123.ingest.sentry.io/api/456/envelope/');
    const payload = String(options.body).split('\n');
    const event = JSON.parse(payload[2]);
    expect(event.exception.values[0].value).toContain('HTTP 401');
    expect(event.tags.error_code).toBe('GITHUB_401');
    expect(event.tags.correlation_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(payload[2]).not.toContain('Authorization');
  });

  it('strips credentials, signed URLs, identities and private paths', () => {
    const message = 'Request https://example.org/path?token=SECRET failed: Bearer secret ' +
      'password=PRIVATE user@example.org /home/rod/private/file.heic';
    const clean = safeManageMessage(message);
    for (const secret of ['token=SECRET', 'Bearer secret', 'password=PRIVATE', 'user@example.org', '/home/rod']) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain('failed');
    expect(manageSentryEndpoint('https://evil.invalid/123')).toBeUndefined();
    expect(manageSentryEndpoint(undefined)).toBeUndefined();
  });

  it('does not send errors without the DSN', () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    expect(captureManageError({} as Env, new Error('unavailable'), {
      correlationId: crypto.randomUUID(), route: '/api/overview', method: 'GET',
    })).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
