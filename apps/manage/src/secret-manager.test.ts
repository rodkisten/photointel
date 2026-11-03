import { describe, expect, it } from 'vitest';
import { listReferences, replaceReference, secretFragment } from './secret-manager';

describe('Manage Secret Manager safe version editor', () => {
  const dotenv = [
    '# Production comments stay byte-for-byte intact',
    'PROJECT_ID=photointel',
    'WORKFLOW_SECRETS__MANAGE_GITHUB_API_TOKEN__NAME=photointel-manage-github-token',
    'WORKFLOW_SECRETS__MANAGE_GITHUB_API_TOKEN__VERSION=2',
    '# Cloudflare runtime, not deploy identity',
    'WORKFLOW_SECRETS__MANAGE_CLOUDFLARE_API_TOKEN__NAME=photointel-manage-cloudflare-token',
    'WORKFLOW_SECRETS__MANAGE_CLOUDFLARE_API_TOKEN__VERSION=1 # pinned',
    'WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__NAME=photointel-pages-token',
    'WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__VERSION=2',
    '# End-of-file stays intact',
  ].join('\n');

  it('lists only explicitly allowlisted MANAGE_ workflow secrets', () => {
    const result = listReferences(dotenv);
    expect(result).toHaveLength(2);
    expect(result.every((x) => x.key.startsWith('MANAGE_'))).toBe(true);
    expect(result.map((x) => x.name)).toContain('photointel-manage-cloudflare-token');
    expect(result.map((x) => x.name)).not.toContain('photointel-pages-token');
  });

  it('preserves comments, other references and line endings when updating a pinned version', () => {
    const updated = replaceReference(dotenv, 'MANAGE_CLOUDFLARE_API_TOKEN', '1', '3');
    expect(updated).toContain('WORKFLOW_SECRETS__MANAGE_CLOUDFLARE_API_TOKEN__VERSION=3 # pinned');
    expect(updated).toContain('WORKFLOW_SECRETS__MANAGE_GITHUB_API_TOKEN__VERSION=2');
    expect(updated).toContain('# Production comments stay byte-for-byte intact');
    expect(updated).toContain('# End-of-file stays intact');
    expect(
      updated.replace(
        'WORKFLOW_SECRETS__MANAGE_CLOUDFLARE_API_TOKEN__VERSION=3',
        'WORKFLOW_SECRETS__MANAGE_CLOUDFLARE_API_TOKEN__VERSION=1',
      ),
    ).toBe(dotenv);
    const crlf = dotenv.replaceAll('\n', '\r\n');
    expect(replaceReference(crlf, 'MANAGE_CLOUDFLARE_API_TOKEN', '1', '3')).toContain('\r\n');
  });

  it('fails closed when a pinned version is stale', () => {
    expect(() => replaceReference(dotenv, 'MANAGE_GITHUB_API_TOKEN', '99', '3')).toThrow();
  });

  it('supports the existing JSON configuration without including unrelated secrets', () => {
    const raw = JSON.stringify({
      workflow_secrets: {
        MANAGE_SENTRY_API_TOKEN: { name: 'photointel-manage-sentry-token', version: '1' },
        SENTRY_AUTH_TOKEN: { name: 'photointel-sentry-build-token', version: '3' },
      },
    });
    expect(listReferences(raw)).toEqual([
      { key: 'MANAGE_SENTRY_API_TOKEN', name: 'photointel-manage-sentry-token', version: '1' },
    ]);
    const next = replaceReference(raw, 'MANAGE_SENTRY_API_TOKEN', '1', '2');
    expect(JSON.parse(next).workflow_secrets.MANAGE_SENTRY_API_TOKEN.version).toBe('2');
  });

  it('returns no full or tiny secret values in previews', () => {
    const secret = 'verySensitiveBearerValue123';
    const masked = secretFragment(secret);
    expect(masked.startsWith('ver')).toBe(true);
    expect(masked.endsWith('123')).toBe(true);
    expect(masked).not.toContain('Sensitive');
    expect(secretFragment('abc')).toBe('••••••••');
    expect(secretFragment('\u0000binary')).toBe('••••••••');
  });
});
