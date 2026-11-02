import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { ApiError } from '../api/error';
import { request } from '../api/client';
import { readAsset } from '../api/generated-client';
import { reportDiagnostic } from '../lib/diagnostics';

vi.mock('@sentry/react', () => ({
  isEnabled: vi.fn(() => true),
  captureException: vi.fn(() => 'a'.repeat(32)),
  browserTracingIntegration: vi.fn(() => ({})),
  init: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Sentry origin classification', () => {
  it('labels transport failures api.network and captures the same failure only once', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let error: unknown;
    try {
      await request('/v1/catalog?token=DO_NOT_UPLOAD');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
    expect((error as ApiError).path).toBe('/v1/catalog');
    const first = reportDiagnostic(error, 'api');
    const second = reportDiagnostic(error, 'promise');
    expect(second).toBe(first);
    expect(first.category).toBe('api.network');
    expect(first.source).toBe('cloudflare');
    expect(first.eventId).toBe('a'.repeat(32));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: expect.objectContaining({
          error_kind: 'api.network',
          phase: 'api',
          service: 'photointel-web',
          correlation_id: first.id,
        }),
        fingerprint: ['photointel', 'api.network', 'GET'],
      }),
    );
    // The event's tag/fingerprint must not contain request URLs or tokens.
    const options = vi.mocked(Sentry.captureException).mock.calls[0]?.[1];
    expect(JSON.stringify(options)).not.toContain('DO_NOT_UPLOAD');
    expect(fetcher).toHaveBeenCalledTimes(2); // API fetch plus sanitized Cloudflare diagnostics.
  });

  it('converts generated OpenAPI fetch rejections into api.network as well', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let error: unknown;
    try {
      await readAsset('asset-123');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
    const incident = reportDiagnostic(error, 'api');
    expect(incident.category).toBe('api.network');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: expect.objectContaining({ error_kind: 'api.network' }),
        fingerprint: ['photointel', 'api.network', 'GET'],
      }),
    );
  });

  it('does not duplicate origin HTTP errors, whether they have Sentry event IDs or not', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const withEvent = new ApiError(
      'Origin failed',
      500,
      'INTERNAL_ERROR',
      'b663f9ee-1699-4b2c-b157-ff5573f0316f',
      { source: 'gcp', eventId: 'b'.repeat(32) },
    );
    const withoutEvent = new ApiError('Origin unavailable', 503, 'DATABASE_UNAVAILABLE', undefined, {
      source: 'gcp',
    });
    const first = reportDiagnostic(withEvent, 'api');
    const second = reportDiagnostic(withoutEvent, 'api');
    expect(first.category).toBe('api.http');
    expect(first.eventId).toBe('b'.repeat(32));
    expect(second.category).toBe('api.http');
    expect(second.eventId).toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps React exceptions in frontend.render, without a network fingerprint', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Unexpected render issue');
    const incident = reportDiagnostic(error, 'render');
    expect(incident.category).toBe('frontend.render');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: expect.objectContaining({ error_kind: 'frontend.render' }),
      }),
    );
    const options = vi.mocked(Sentry.captureException).mock.calls[0]?.[1];
    expect(options).not.toEqual(expect.objectContaining({ fingerprint: expect.anything() }));
  });

  it('does not treat an intentionally aborted request as a network error', async () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abort;
      }),
    );
    await expect(request('/v1/assets')).rejects.toBe(abort);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
