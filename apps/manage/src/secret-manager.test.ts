import { describe, expect, it } from 'vitest';
import {
  listReferences, replaceReference, secretFragment, validateSecretValue,
} from './secret-manager';

describe('Manage Secret Manager all-secrets editor', () => {
  const dotenv = [
    '# Production comments stay byte-for-byte intact',
    'PROJECT_ID=photointel',
    'SECRETS__ICLOUD_SESSION_KEY__NAME=photointel-session-aead-key',
    'SECRETS__ICLOUD_SESSION_KEY__VERSION=1 # keep old versions',
    'SECRETS__DATABASE_URL__NAME=photointel-database-url',
    'SECRETS__DATABASE_URL__VERSION=3',
    'WORKFLOW_SECRETS__MANAGE_GITHUB_API_TOKEN__NAME=photointel-manage-github-token',
    'WORKFLOW_SECRETS__MANAGE_GITHUB_API_TOKEN__VERSION=2',
    '# Shared credential, referenced by more than one service',
    'WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__NAME=photointel-pages-token',
    'WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__VERSION=2',
    '# End-of-file stays intact',
  ].join('\n');

  it('finds all API/jobs and workflow secrets, including iCloud and database', () => {
    const result = listReferences(dotenv);
    expect(result).toHaveLength(4);
    expect(result.find((x) => x.key === 'ICLOUD_SESSION_KEY')).toEqual({
      key: 'ICLOUD_SESSION_KEY',
      scope: 'secrets',
      name: 'photointel-session-aead-key',
      version: '1',
    });
    expect(result.find((x) => x.key === 'DATABASE_URL')?.name).toBe('photointel-database-url');
    expect(result.find((x) => x.key === 'CLOUDFLARE_API_TOKEN')?.scope).toBe('workflow_secrets');
    expect(result.find((x) => x.key === 'MANAGE_GITHUB_API_TOKEN')?.version).toBe('2');
  });

  it('preserves dotenv comments, unrelated references and CRLF line endings', () => {
    const updated = replaceReference(dotenv, 'ICLOUD_SESSION_KEY', '1', '4', 'secrets');
    expect(updated).toContain('SECRETS__ICLOUD_SESSION_KEY__VERSION=4 # keep old versions');
    expect(updated).toContain('SECRETS__DATABASE_URL__VERSION=3');
    expect(updated).toContain('# End-of-file stays intact');
    expect(updated.replace(
      'SECRETS__ICLOUD_SESSION_KEY__VERSION=4', 'SECRETS__ICLOUD_SESSION_KEY__VERSION=1',
    )).toBe(dotenv);
    const crlf = dotenv.replaceAll('\n', '\r\n');
    expect(replaceReference(crlf, 'MANAGE_GITHUB_API_TOKEN', '2', '5')).toContain('\r\n');
  });

  it('fails closed for stale references instead of updating a different version', () => {
    expect(() => replaceReference(dotenv, 'ICLOUD_SESSION_KEY', '99', '5', 'secrets')).toThrow();
  });

  it('reads and updates JSON config in both scopes', () => {
    const raw = JSON.stringify({
      secrets: {
        ICLOUD_SESSION_KEY: { name: 'photointel-session-aead-key', version: '1' },
      },
      workflow_secrets: {
        SENTRY_AUTH_TOKEN: { name: 'photointel-sentry-build-token', version: '3' },
      },
    });
    expect(listReferences(raw)).toHaveLength(2);
    const next = replaceReference(raw, 'ICLOUD_SESSION_KEY', '1', '2', 'secrets');
    expect(JSON.parse(next).secrets.ICLOUD_SESSION_KEY.version).toBe('2');
    expect(JSON.parse(next).workflow_secrets.SENTRY_AUTH_TOKEN.version).toBe('3');
  });

  it('does not return full or tiny secret values in previews', () => {
    const secret = 'verySensitiveBearerValue123';
    const masked = secretFragment(secret);
    expect(masked).toBe('ver••••••••123');
    expect(masked).not.toContain('Sensitive');
    expect(secretFragment('abc')).toBe('••••••••');
    expect(secretFragment('multiple\nlines')).toBe('••••••••');
    expect(secretFragment('\u0000binary')).toBe('••••••••');
  });

  it('accepts 32-byte iCloud base64 key and rejects Apple passwords or incorrect AES key sizes', () => {
    const aes = btoa('k'.repeat(32));
    expect(() => validateSecretValue('photointel-session-aead-key', aes)).not.toThrow();
    expect(() => validateSecretValue('photointel-session-aead-key', 'my-apple-password')).toThrow(
      /32 bytes/,
    );
    expect(() => validateSecretValue('photointel-session-aead-key', btoa('k'.repeat(16)))).toThrow();
  });

  it('allows multiline certificates and JSON within 64 KiB but rejects empty or oversized values', () => {
    expect(() => validateSecretValue('photointel-example', 'line 1\nline 2')).not.toThrow();
    expect(() => validateSecretValue('photointel-example', '{"nested":true}')).not.toThrow();
    expect(() => validateSecretValue('photointel-example', '')).toThrow();
    expect(() => validateSecretValue('photointel-example', 'a'.repeat(65_537))).toThrow();
    expect(() => validateSecretValue('photointel-example', 'hello\0world')).toThrow();
  });
});
