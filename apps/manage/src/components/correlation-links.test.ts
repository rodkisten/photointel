import { describe, expect, it } from 'vitest';
import {
  correlationCloudflareUrl,
  correlationExplorerUrl,
  correlationManageUrl,
  correlationSentryUrl,
  isCorrelationKey,
} from './correlation-links';

const correlation = '4d0977df-e6c9-46a9-a8ea-5c5cca15778c';

describe('correlation investigation links', () => {
  it('detects correlation fields, not unrelated UUIDs', () => {
    expect(isCorrelationKey('correlation_id')).toBe(true);
    expect(isCorrelationKey('correlationId')).toBe(true);
    expect(isCorrelationKey('error.correlation-id')).toBe(true);
    expect(isCorrelationKey('asset_id')).toBe(false);
  });

  it('builds a properly encoded Cloud Logging search scoped to the project', () => {
    const url = correlationExplorerUrl(correlation, 'photointel');
    expect(url).toContain('SEARCH(%224d0977df-e6c9-46a9-a8ea-5c5cca15778c%22)');
    expect(url).toContain('duration=P7D?project=photointel');
  });

  it('searches an indexed Sentry tag and validates the organization slug', () => {
    const url = correlationSentryUrl(correlation, 'photointel');
    expect(url).toBe(
      'https://photointel.sentry.io/issues/?query=tags%5Bcorrelation_id%5D%3A' + correlation,
    );
    expect(correlationSentryUrl(correlation, 'bad.example.com')).toBeNull();
  });

  it('opens account-scoped Cloudflare Observability', () => {
    expect(correlationCloudflareUrl('0123456789abcdef0123456789abcdef')).toBe(
      'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/observability',
    );
    expect(correlationCloudflareUrl('untrusted/path')).toBeNull();
  });

  it('deep-links the Manage logs with its API search applied', () => {
    expect(correlationManageUrl(correlation, 'cloudflare')).toBe(
      '/?tab=logs&source=cloudflare&correlation=' + correlation,
    );
    expect(correlationManageUrl(correlation, 'gcp')).toContain('source=gcp');
    expect(correlationExplorerUrl('not-a-uuid')).toBeNull();
  });
});
