import type { Env } from './auth';

/**
 * Read only the exact credentials installed in this Cloudflare Worker.
 * No GitHub, GCP, or Cloudflare API calls are needed to identify a token.
 * Never return a full token, Authorization header or secret payload.
 */
export type CredentialIdentity = {
  id: 'github' | 'cloudflare' | 'sentry';
  label: string;
  installed: boolean;
  masked: string | null;
  fingerprint: string | null;
  expected_matches_runtime: boolean | null;
  referenced_version: string | null;
};

function mask(value: string): string {
  if (value.length < 12) return '••••••••';
  return value.slice(0, 3) + '••••••••' + value.slice(-3);
}

export async function tokenFingerprint(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function installedCredentialIdentities(env: Env): Promise<{
  checked_at: string;
  credentials: CredentialIdentity[];
}> {
  const descriptions: Array<{
    id: CredentialIdentity['id']; label: string; token: string | undefined;
    expected: string | undefined; version: string | undefined;
  }> = [
    { id: 'github', label: 'GitHub PAT do Manage', token: env.GITHUB_API_TOKEN,
      expected: env.GITHUB_TOKEN_EXPECTED_SHA256, version: env.GITHUB_TOKEN_SECRET_VERSION },
    { id: 'cloudflare', label: 'Cloudflare API Token do Manage',
      token: env.CLOUDFLARE_API_TOKEN,
      expected: env.CLOUDFLARE_TOKEN_EXPECTED_SHA256,
      version: env.CLOUDFLARE_TOKEN_SECRET_VERSION },
    { id: 'sentry', label: 'Sentry API Token do Manage',
      token: env.SENTRY_API_TOKEN, expected: env.SENTRY_TOKEN_EXPECTED_SHA256,
      version: env.SENTRY_TOKEN_SECRET_VERSION },
  ];
  const credentials = await Promise.all(descriptions.map(async item => {
    const token = item.token?.trim() || '';
    const fingerprint = token ? await tokenFingerprint(token) : null;
    const expected = item.expected?.trim().toLowerCase() || '';
    const validExpected = /^[a-f0-9]{64}$/.test(expected);
    return {
      id: item.id, label: item.label, installed: Boolean(token),
      masked: token ? mask(token) : null,
      // A short digest disambiguates tokens with matching start/end. SHA-256
      // never makes a high-entropy PAT recoverable.
      fingerprint: fingerprint ? fingerprint.slice(0, 12) : null,
      expected_matches_runtime: fingerprint && validExpected ? fingerprint === expected : null,
      referenced_version: /^\d{1,10}$/.test(item.version || '') ? item.version! : null,
    } satisfies CredentialIdentity;
  }));
  return { checked_at: new Date().toISOString(), credentials };
}
