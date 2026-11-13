/* Verify signed Cloudflare Access JWT before serving any asset or API route. */
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface D1Binding { prepare(sql: string): D1Statement; }
export interface Env {
  DEPLOY_DB?: D1Binding;
  GITHUB_WEBHOOK_SECRET?: string;
  CIRCLECI_API_TOKEN?: string;
  CIRCLECI_CONTEXT_ID?: string;
  CIRCLECI_PROJECT_SLUG?: string;
  CIRCLECI_DEFINITION_ID?: string;
  GCP_BUILD_WEBHOOK_RELEASE_URL?: string;
  GCP_BUILD_WEBHOOK_PROVISION_URL?: string;
  GCP_BUILD_CALLBACK_SECRET?: string;
  XRELAY_NOTIFICATION_URL?: string;
  XRELAY_NOTIFICATION_TOKEN?: string;
  XRELAY_CHAT_ID?: string;
  ASSETS: { fetch(r: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ACCESS_ALLOWED_EMAILS: string;
  GITHUB_API_TOKEN?: string;
  /** Deployed Secret Manager version only, never the secret value. */
  GITHUB_TOKEN_SECRET_VERSION?: string;
  GITHUB_REPO: string;
  /** Isolated Cloudflare Worker Preview: never call live admin APIs. */
  PHOTOINTEL_PREVIEW?: string;
  GITHUB_ENVIRONMENT: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GCP_PROJECT_ID?: string;
  GCP_REGION?: string;
  /** Location:trigger-id allowlist. Only these connected Cloud Build triggers can be executed. */
  GCP_CLOUDBUILD_ALLOWED_TRIGGERS?: string;
  GCP_WIF_AUDIENCE?: string;
  GCP_IMPERSONATE_SERVICE_ACCOUNT?: string;
  SENTRY_ORG?: string;
  SENTRY_API_TOKEN?: string;
  /** Public DSN for the independent Manage Sentry project, not an API token. */
  SENTRY_DSN?: string;
  /** Optional billing integrations, all credentials remain server-side. */
  GITHUB_BILLING_OWNER?: string;
  GITHUB_BILLING_SCOPE?: string;
  GITHUB_ACTIONS_INCLUDED_USD?: string;
  GCP_BILLING_TABLE?: string;
  MODAL_BILLING_URL?: string;
  MODAL_BILLING_TOKEN?: string;
  PHOTOINTEL_API_ORIGIN?: string;
}
export type Identity = { email: string; jwt: string };
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManageApiError';
  }
}

// Configurable constants replacing magic numbers
const TIMEOUTS = {
  CERTS_FETCH: 6000,
};

const CACHE = {
  MAX_KEYS: 8,
  DURATION_MS: 10 * 60_000, // 10 minutes
};

const LIMITS = {
  JSON_BODY_MAX_BYTES: 120_000,
  REDACT_MAX_LENGTH: 100_000,
};

const JWT_CONFIG = {
  ALLOWED_SKEW_SECONDS: 30,
};

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
export function failure(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

const cached = new Map<string, { key: CryptoKey; expires: number }>();

function decode(part: string): Uint8Array {
  const raw = part.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(raw + '='.repeat((4 - (raw.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function jwtJson(part: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(decode(part))) as Record<string, unknown>;
  } catch {
    throw new ApiError(401, 'ACCESS_INVALID', 'Sessão Access inválida');
  }
}

export async function verifyAccess(request: Request, env: Env): Promise<Identity> {
  // 1. Ensure Cloudflare Access environment is properly configured
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN || '') ||
    !/^[\w-]{20,128}$/.test(env.ACCESS_AUDIENCE || '') ||
    !env.ACCESS_ALLOWED_EMAILS
  )
    throw new ApiError(503, 'ACCESS_SETUP', 'Configure Cloudflare Access e a allowlist');

  // 2. Extract JWT from headers or cookies
  const jwt =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    request.headers.get('Cookie')?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!jwt) throw new ApiError(401, 'ACCESS_REQUIRED', 'Login Cloudflare Access necessário');

  const parts = jwt.split('.');
  if (parts.length !== 3) throw new ApiError(401, 'ACCESS_INVALID', 'JWT inválido');

  const header = jwtJson(parts[0]),
    payload = jwtJson(parts[1]),
    now = Date.now() / 1000;
  const issuer = 'https://' + env.ACCESS_TEAM_DOMAIN;

  // 3. Validate claims (Algorithm, Issuer, Audience, Expiration, NBF)
  if (
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    payload.iss !== issuer ||
    !(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).includes(env.ACCESS_AUDIENCE) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now ||
    (typeof payload.nbf === 'number' && payload.nbf > now + JWT_CONFIG.ALLOWED_SKEW_SECONDS)
  )
    throw new ApiError(401, 'ACCESS_CLAIMS', 'Token Access inválido ou expirado');

  // 4. Verify Identity against Allowlist
  let allow: string[] = [];
  try {
    const parsed: unknown = JSON.parse(env.ACCESS_ALLOWED_EMAILS);
    if (Array.isArray(parsed)) allow = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    allow = env.ACCESS_ALLOWED_EMAILS.split(',');
  }

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (!email || !allow.map((x) => x.trim().toLowerCase()).includes(email))
    throw new ApiError(403, 'ACCESS_DENIED', 'Conta não autorizada');

  // 5. Manage JWK Caching
  const keyId = env.ACCESS_TEAM_DOMAIN + ':' + header.kid;
  let entry = cached.get(keyId);
  
  if (!entry || entry.expires < Date.now()) {
    // 6. Fetch Public Certs if cache misses or expires
    const result = await fetch(issuer + '/cdn-cgi/access/certs', {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUTS.CERTS_FETCH),
    });
    if (!result.ok) throw new ApiError(503, 'ACCESS_CERTS', 'Chaves Access indisponíveis');
    
    const certs = (await result.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = certs.keys?.find((k) => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) throw new ApiError(401, 'ACCESS_KEY', 'Chave Access não encontrada');
    
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    entry = { key, expires: Date.now() + CACHE.DURATION_MS };
    if (cached.size > CACHE.MAX_KEYS) cached.clear();
    cached.set(keyId, entry);
  }

  // 7. Verify Cryptographic Signature
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    entry.key,
    decode(parts[2]) as BufferSource,
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  if (!ok) throw new ApiError(401, 'ACCESS_SIGNATURE', 'Assinatura JWT inválida');
  
  return { email, jwt };
}

export async function bodyJson<T>(request: Request, max = LIMITS.JSON_BODY_MAX_BYTES): Promise<T> {
  // Validate Content-Type
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')
    throw new ApiError(415, 'CONTENT_TYPE', 'Use application/json');

  // Pre-emptive length check via headers
  if (Number(request.headers.get('Content-Length') || 0) > max)
    throw new ApiError(413, 'BODY_LIMIT', 'Corpo muito grande');

  // Absolute length check on text payload
  const text = await request.text();
  if (text.length > max) throw new ApiError(413, 'BODY_LIMIT', 'Corpo muito grande');

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, 'JSON', 'JSON inválido');
  }
}

export function requireOrigin(request: Request): void {
  // Prevents CSRF by strictly enforcing the origin header
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    throw new ApiError(403, 'CSRF', 'Origem não permitida');
}

export function redact(value: unknown): string {
  // Replaces sensitive tokens and private URLs before logging or displaying
  return (typeof value === 'string' ? value : JSON.stringify(value) || '')
    .slice(0, LIMITS.REDACT_MAX_LENGTH)
    // Redact complete JSON credential values before the generic Bearer substitution.
    .replace(/("(?:password|token|secret|authorization|cookie)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:password|token|secret|authorization|cookie)\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"']+\?[^\s"']+/gi, '[URL privada]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[JWT omitted]');
}
