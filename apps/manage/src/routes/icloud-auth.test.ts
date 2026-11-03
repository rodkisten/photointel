import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, Identity } from '../auth';
import { ApiError } from '../auth';
import { icloudAuthRoute } from './icloud-auth';
import { gcp } from '../providers';

vi.mock('../providers', () => ({
  gcp: vi.fn(),
  gcpBase: () => 'https://run.googleapis.com/v2/projects/photointel/locations/us-central1',
}));

const env = {} as Env;
const identity = { email: 'admin@example.com', jwt: 'signed-manage-access-jwt' } as Identity;

function request(phase: string, body: unknown): Request {
  return new Request('https://photos-manage.migos.club/api/icloud/auth/' + phase, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('iCloud password and 2FA gateway', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.mocked(gcp).mockResolvedValue({ uri: 'https://photointel-api-abcdef-uc.a.run.app' });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends the Apple password only over TLS to the fixed Cloud Run endpoint', async () => {
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://photointel-api-abcdef-uc.a.run.app/v1/ingestion/web-auth/start');
      expect(init.redirect).toBe('manual');
      expect(init.headers).toEqual(expect.objectContaining({
        'Cf-Access-Jwt-Assertion': identity.jwt,
        'Cache-Control': 'no-store',
      }));
      expect(JSON.parse(String(init.body))).toEqual({ password: 'not-a-real-password' });
      return new Response(JSON.stringify({
        state: 'verification_required', challenge: 'encrypted-opaque-challenge',
        mode: '2fa', expires_in: 600, message: 'Digite o código.',
      }), { status: 200 });
    });
    globalThis.fetch = upstream as typeof fetch;
    const result = await icloudAuthRoute(request('start', { password: 'not-a-real-password' }), env, identity);
    expect(result?.status).toBe(200);
    expect(await result?.json()).toEqual(expect.objectContaining({ state: 'verification_required' }));
    expect(gcp).toHaveBeenCalledOnce();
  });

  it('accepts short Apple passwords, independently of 32-byte AES keys', async () => {
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ password: 'shortpass' });
      return new Response(JSON.stringify({
        state: 'verification_required', challenge: 'A'.repeat(100), mode: '2fa',
        expires_in: 600, message: 'Digite o código Apple',
      }), { status: 200 });
    });
    globalThis.fetch = upstream as typeof fetch;
    const result = await icloudAuthRoute(request('start', { password: 'shortpass' }), env, identity);
    expect((await result?.json()).state).toBe('verification_required');
  });

  it('checks iCloud readiness via GET without sending a password or a code', async () => {
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://photointel-api-abcdef-uc.a.run.app/v1/ingestion/web-auth/status');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      return new Response(JSON.stringify({ ready: false, code: 'ICLOUD_SESSION_KEY_UNAVAILABLE',
        message: 'Chave técnica indisponível' }), { status: 200 });
    });
    globalThis.fetch = upstream as typeof fetch;
    const req = new Request('https://photos-manage.migos.club/api/icloud/auth/status');
    const result = await icloudAuthRoute(req, env, identity);
    expect(await result?.json()).toEqual({
      ready: false, code: 'ICLOUD_SESSION_KEY_UNAVAILABLE', message: 'Chave técnica indisponível',
    });
  });

  it('completes 2FA without forwarding any password', async () => {
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ challenge: 'A'.repeat(40), code: '123456' });
      return new Response(JSON.stringify({
        state: 'connected', valid: true, session_published: true, checked_at: '2026-11-03',
        library: 'PrimarySync', message: 'Conectado.',
      }), { status: 200 });
    });
    globalThis.fetch = upstream as typeof fetch;
    const result = await icloudAuthRoute(request('verify', { challenge: 'A'.repeat(40), code: '123456' }), env, identity);
    expect((await result?.json()).session_published).toBe(true);
  });

  it('rejects injection and untrusted upstream origins before sending secrets', async () => {
    const upstream = vi.fn();
    globalThis.fetch = upstream as typeof fetch;
    await expect(icloudAuthRoute(request('verify', { challenge: 'invalid', code: 'abc123' }), env, identity))
      .rejects.toBeInstanceOf(ApiError);
    vi.mocked(gcp).mockResolvedValue({ uri: 'https://evil.example.com' });
    await expect(icloudAuthRoute(request('start', { password: 'test' }), env, identity))
      .rejects.toBeInstanceOf(ApiError);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('does not expose Apple upstream error bodies or secrets', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Confira a senha' }, password: 'secret-leak' }),
      { status: 422 },
    )) as typeof fetch;
    await expect(icloudAuthRoute(request('start', { password: 'test' }), env, identity))
      .rejects.toThrow('Confira a senha');
  });
});
