import { ApiError } from './auth';
import type { Env } from './auth';
import { provider } from './providers';

type InstallationToken = { token: string; expires_at: string };
const cache = new Map<string, { token: string; until: number }>();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function appJwt(appId: string, pem: string): Promise<string> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  let binary: string;
  try { binary = atob(body); } catch { throw new ApiError(503, 'GITHUB_APP_KEY', 'Chave PKCS#8 inválida'); }
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(binary, char => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const unsigned = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) + '.' +
    base64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return unsigned + '.' + base64url(new Uint8Array(signature));
}

/** Installation-scoped token; never return it to the browser or store it in D1. */
export async function githubToken(env: Env): Promise<string> {
  const appId = env.MANAGE_GITHUB_APP_ID?.trim();
  const installation = env.MANAGE_GITHUB_APP_INSTALLATION_ID?.trim();
  const key = env.MANAGE_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const configured = [appId, installation, key].filter(Boolean).length;
  if (configured !== 3) {
    if (configured > 0) throw new ApiError(503, 'GITHUB_APP_INCOMPLETE', 'Credenciais do GitHub App incompletas');
    if (env.GITHUB_API_TOKEN) return env.GITHUB_API_TOKEN;
    throw new ApiError(503, 'GITHUB_AUTH', 'Configure GitHub App ou token legado');
  }
  if (!/^\d+$/.test(appId!) || !/^\d+$/.test(installation!))
    throw new ApiError(503, 'GITHUB_APP_CONFIG', 'GitHub App ID ou instalação inválida');
  const cacheKey = appId + ':' + installation;
  const cached = cache.get(cacheKey);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const jwt = await appJwt(appId!, key!);
  const response = await provider('https://api.github.com/app/installations/' + installation + '/access_tokens', jwt, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({}),
  }) as InstallationToken;
  if (!response.token || !response.expires_at) throw new ApiError(503, 'GITHUB_APP_TOKEN', 'GitHub App não retornou token');
  cache.set(cacheKey, { token: response.token, until: Date.parse(response.expires_at) });
  return response.token;
}

/** Verify the configured App identity using an App JWT, never an installation PAT. */
export async function githubAppIdentity(env: Env): Promise<{ id: number; slug: string; name: string }> {
  if (!env.MANAGE_GITHUB_APP_ID || !env.MANAGE_GITHUB_APP_PRIVATE_KEY)
    throw new ApiError(503, 'GITHUB_APP_CONFIG', 'GitHub App não configurado');
  const jwt = await appJwt(env.MANAGE_GITHUB_APP_ID, env.MANAGE_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const app = await provider('https://api.github.com/app', jwt, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  }) as { id: number; slug: string; name: string };
  if (!app.id || !app.slug) throw new ApiError(502, 'GITHUB_APP_IDENTITY', 'Identidade do App inválida');
  if (String(app.id) !== env.MANAGE_GITHUB_APP_ID)
    throw new ApiError(403, 'GITHUB_APP_MISMATCH', 'A chave não pertence ao App configurado');
  return { id: app.id, slug: app.slug, name: app.name };
}
