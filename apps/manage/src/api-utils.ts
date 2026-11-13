import { ApiError, json, redact } from './auth';

// Constantes centralizadas (Eliminando variáveis mágicas)
export const PATTERNS = {
  ID: /^[1-9][0-9]{0,15}$/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  GCP_JOB_NAME: /^photointel-[a-z0-9-]{1,48}$/,
  VARIABLE_NAME: /^[A-Z_][A-Z0-9_]{0,99}$/,
  SENTRY_ORG: /^[a-z0-9-]{1,64}$/,
  SECRET_SENSITIVE: /(?:github_pat_|ghp_|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,
};

export const LIMITS = {
  LOG_MAX_BYTES: 400_000,
  LOG_SLICE_LENGTH: 100_000,
  LOG_FINAL_LENGTH: 65_000,
  CONFIG_MAX_LENGTH: 120_000,
  SENTRY_ISSUES_LIMIT: 100,
  TIMEOUT_DEFAULT: 10_000,
  TIMEOUT_PREVIEW: 15_000,
};

export const DEFAULTS = {
  PROJECT_ID: 'photointel',
  REGION: 'us-central1',
  GITHUB_REPO: 'rodkisten/photointel',
};

export type Item = Record<string, any>;

export function safeList(data: unknown, key: string): Item[] {
  const v = data as Record<string, unknown>;
  return Array.isArray(v?.[key]) ? (v[key] as Item[]) : [];
}

export function sanitizeLog(message: unknown, maxLength: number = 450): string {
  return redact(String(message || '')).slice(0, maxLength);
}
