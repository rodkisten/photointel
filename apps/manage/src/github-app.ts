import { ApiError } from './auth';
import type { Env } from './auth';
import { provider } from './providers';

// TODO extract to file src/config/api-constants.ts
const GITHUB_APP_CONFIG = {
  API_BASE: 'https://api.github.com',
  API_VERSION: '2022-11-28',
  ACCEPT_HEADER: 'application/vnd.github+json',
  JWT: {
    ALGORITHM: 'RS256',
    TYPE: 'JWT',
    WEB_CRYPTO_ALGO: 'RSASSA-PKCS1-v1_5',
    WEB_CRYPTO_HASH: 'SHA-256',
    KEY_FORMAT: 'pkcs8' as const,
    CLOCK_SKEW_SECONDS: 60,
    TTL_SECONDS: 540,
  },
  CACHE_SAFETY_BUFFER_MS: 60_000,
  PEM_STRIP_REGEX: /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
  ESCAPED_NEWLINE_REGEX: /\\n/g,
  NUMERIC_ID_REGEX: /^\d+$/,
} as const;

const GITHUB_APP_HEADERS = {
  Accept: GITHUB_APP_CONFIG.ACCEPT_HEADER,
  'X-GitHub-Api-Version': GITHUB_APP_CONFIG.API_VERSION,
} as const;

type InstallationTokenResponse = { token: string; expires_at: string };
type GitHubAppResponse = { id: number; slug: string; name: string };
type CachedToken = { token: string; until: number };

const tokenCache = new Map<string, CachedToken>();

// TODO extract to file src/utils/encoding.ts
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizePemKey(rawPem: string): string {
  return rawPem.replace(GITHUB_APP_CONFIG.ESCAPED_NEWLINE_REGEX, '\n');
}

function getAppCredentials(env: Env): { appId?: string; installationId?: string; privateKey?: string } {
  const rawKey = env.MANAGE_GITHUB_APP_PRIVATE_KEY;
  return {
    appId: env.MANAGE_GITHUB_APP_ID?.trim(),
    installationId: env.MANAGE_GITHUB_APP_INSTALLATION_ID?.trim(),
    privateKey: rawKey ? normalizePemKey(rawKey) : undefined,
  };
}

function githubAppProvider<T>(endpoint: string, jwt: string, init: RequestInit = {}): Promise<T> {
  return provider(`${GITHUB_APP_CONFIG.API_BASE}${endpoint}`, jwt, {
    ...init,
    headers: {
      ...GITHUB_APP_HEADERS,
      ...(init.headers || {}),
    },
  }) as Promise<T>;
}

// TODO extract to file src/auth/github-app.ts
export async function appJwt(appId: string, pem: string): Promise<string> {
  const body = pem.replace(GITHUB_APP_CONFIG.PEM_STRIP_REGEX, '');
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new ApiError(503, 'GITHUB_APP_KEY', 'Chave PKCS#8 inválida');
  }

  const key = await crypto.subtle.importKey(
    GITHUB_APP_CONFIG.JWT.KEY_FORMAT,
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    {
      name: GITHUB_APP_CONFIG.JWT.WEB_CRYPTO_ALGO,
      hash: GITHUB_APP_CONFIG.JWT.WEB_CRYPTO_HASH,
    },
    false,
    ['sign'],
  );

  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = base64url(
    encoder.encode(
      JSON.stringify({
        alg: GITHUB_APP_CONFIG.JWT.ALGORITHM,
        typ: GITHUB_APP_CONFIG.JWT.TYPE,
      }),
    ),
  );
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        iat: now - GITHUB_APP_CONFIG.JWT.CLOCK_SKEW_SECONDS,
        exp: now + GITHUB_APP_CONFIG.JWT.TTL_SECONDS,
        iss: appId,
      }),
    ),
  );

  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    GITHUB_APP_CONFIG.JWT.WEB_CRYPTO_ALGO,
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/** Installation-scoped token; never return it to the browser or store it in D1. */
export async function githubToken(env: Env): Promise<string> {
  const { appId, installationId, privateKey } = getAppCredentials(env);
  const configuredCount = [appId, installationId, privateKey].filter(Boolean).length;

  if (configuredCount !== 3) {
    if (configuredCount > 0) {
      throw new ApiError(503, 'GITHUB_APP_INCOMPLETE', 'Credenciais do GitHub App incompletas');
    }
    if (env.GITHUB_API_TOKEN) return env.GITHUB_API_TOKEN;
    throw new ApiError(503, 'GITHUB_AUTH', 'Configure GitHub App ou token legado');
  }

  if (
    !GITHUB_APP_CONFIG.NUMERIC_ID_REGEX.test(appId!) ||
    !GITHUB_APP_CONFIG.NUMERIC_ID_REGEX.test(installationId!)
  ) {
    throw new ApiError(503, 'GITHUB_APP_CONFIG', 'GitHub App ID ou instalação inválida');
  }

  const cacheKey = `${appId}:${installationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.until > Date.now() + GITHUB_APP_CONFIG.CACHE_SAFETY_BUFFER_MS) {
    return cached.token;
  }

  const jwt = await appJwt(appId!, privateKey!);
  const response = await githubAppProvider<InstallationTokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );

  if (!response.token || !response.expires_at) {
    throw new ApiError(503, 'GITHUB_APP_TOKEN', 'GitHub App não retornou token');
  }

  tokenCache.set(cacheKey, { token: response.token, until: Date.parse(response.expires_at) });
  return response.token;
}

/** Verify the configured App identity using an App JWT, never an installation PAT. */
export async function githubAppIdentity(env: Env): Promise<GitHubAppResponse> {
  const { appId, privateKey } = getAppCredentials(env);
  if (!appId || !privateKey) {
    throw new ApiError(503, 'GITHUB_APP_CONFIG', 'GitHub App não configurado');
  }

  const jwt = await appJwt(appId, privateKey);
  const app = await githubAppProvider<GitHubAppResponse>('/app', jwt);

  if (!app.id || !app.slug) {
    throw new ApiError(502, 'GITHUB_APP_IDENTITY', 'Identidade do App inválida');
  }
  if (String(app.id) !== appId) {
    throw new ApiError(403, 'GITHUB_APP_MISMATCH', 'A chave não pertence ao App configurado');
  }

  return { id: app.id, slug: app.slug, name: app.name };
}
