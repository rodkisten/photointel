/**
 * Read-only diagnostics using the credentials installed in the running Manage Worker.
 * Results contain only fixed reason codes and safe GitHub permissions metadata.
 * Never return HTTP bodies, credentials, Authorization, identity, JWT or request URLs.
 */
import type { Env } from './auth';

export type ProbeResult = {
  provider: 'github' | 'cloudflare';
  check: string;
  ok: boolean;
  status: number;
  reason: string;
  hint: string;
  accepted_permissions?: string;
};

const ghAccept = /^[a-z_]+=(?:read|write|admin|none)(?:[,; ][a-z_]+=(?:read|write|admin|none))*$/i;

function githubReason(status: number, headers: Headers, body: string): [string, string] {
  const rate = headers.get('X-RateLimit-Remaining');
  if (rate === '0') return ['rate_limited', 'GitHub: limite de API atingido. Tente novamente depois da reposição.'];
  if (headers.has('X-GitHub-SSO')) return ['sso_authorization', 'GitHub exige autorização SSO para o token.'];
  let message = '';
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') message = parsed.message.toLowerCase();
  } catch { /* untrusted response */ }
  if (status === 401 || message.includes('bad credentials'))
    return ['invalid_token', 'GitHub não reconhece o token instalado no Worker. Confira a versão do Secret Manager e republique o Manage.'];
  if (message.includes('resource not accessible by personal access token') ||
      message.includes('resource not accessible by integration'))
    return ['insufficient_permissions', 'O token existe, mas o GitHub recusou a permissão deste endpoint. Confira o repositório selecionado e as permissões indicadas abaixo.'];
  if (status === 403)
    return ['forbidden', 'GitHub recusou esta operação (403). Verifique o escopo do token, acesso ao repositório e headers de permissões.'];
  if (status === 404)
    return ['not_found_or_hidden', 'Repositório ou recurso não visível com este token (404).'];
  return ['http_' + status, 'GitHub retornou HTTP ' + status + '.'];
}

function cloudflareReason(status: number, body: string): [string, string] {
  let code = 0;
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown }> };
    const parsedCode = parsed?.errors?.[0]?.code;
    if (typeof parsedCode === 'number' && Number.isSafeInteger(parsedCode)) code = parsedCode;
  } catch { /* never expose response */ }
  if (code === 9106)
    return ['authentication_9106', 'Cloudflare 9106: autenticação não reconhecida ou cabeçalho Authorization ausente no upstream. Confira o secret implantado, não a conta no GitHub.'];
  if (code === 10000)
    return ['authentication_10000', 'Cloudflare recusou a autenticação. Confira escopo, expiração e a conta vinculada ao token.'];
  if (status === 403)
    return ['forbidden', 'Cloudflare 403: token autenticado, mas sem acesso ao recurso solicitado.'];
  return [code ? 'cloudflare_' + code : 'http_' + status, 'Cloudflare retornou HTTP ' + status + (code ? ', código ' + code : '') + '.'];
}

async function probe(
  provider: 'github' | 'cloudflare',
  check: string,
  url: string,
  token: string | undefined,
): Promise<ProbeResult> {
  if (!token?.trim())
    return { provider, check, ok: false, status: 0, reason: 'missing_token', hint: 'O secret não está instalado no Manage Worker.' };
  try {
    const headers = new Headers({ Accept: 'application/json', Authorization: 'Bearer ' + token.trim() });
    if (provider === 'github') headers.set('X-GitHub-Api-Version', '2022-11-28');
    const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(9000) });
    const status = response.status;
    const permissions = provider === 'github'
      ? response.headers.get('X-Accepted-GitHub-Permissions')?.trim() || ''
      : '';
    const accepted_permissions = ghAccept.test(permissions) && permissions.length <= 180
      ? permissions : undefined;
    if (response.ok)
      return { provider, check, ok: true, status, reason: 'ok', hint: 'Acesso verificado pelo provedor.', ...(accepted_permissions ? { accepted_permissions } : {}) };
    const body = (await response.text()).slice(0, 2048);
    const [reason, hint] = provider === 'github'
      ? githubReason(status, response.headers, body)
      : cloudflareReason(status, body);
    return { provider, check, ok: false, status, reason, hint, ...(accepted_permissions ? { accepted_permissions } : {}) };
  } catch {
    return { provider, check, ok: false, status: 0, reason: 'network_failure', hint: 'Falha de rede ou timeout ao contactar o provedor.' };
  }
}

export async function runManageDiagnostics(env: Env): Promise<{ checks: ProbeResult[]; github_secret_version: string | null; checked_at: string }> {
  const repository = env.GITHUB_REPO || 'rodkisten/photointel';
  if (!/^[\w-]+\/[\w.-]+$/.test(repository))
    return { checks: [], github_secret_version: null, checked_at: new Date().toISOString() };
  const github = 'https://api.github.com/repos/' + repository;
  const account = env.CLOUDFLARE_ACCOUNT_ID || '';
  const cloudflare = /^[a-f0-9]{32}$/i.test(account)
    ? 'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts'
    : null;
  const checks = await Promise.all([
    probe('github', 'Repositório', github, env.GITHUB_API_TOKEN),
    probe('github', 'Actions · execuções', github + '/actions/runs?per_page=1', env.GITHUB_API_TOKEN),
    probe('github', 'Actions · workflows', github + '/actions/workflows?per_page=1', env.GITHUB_API_TOKEN),
    probe('github', 'Environment · variável', github + '/environments/' +
      encodeURIComponent(env.GITHUB_ENVIRONMENT || 'production') + '/variables/GCP_CONFIG_ENV', env.GITHUB_API_TOKEN),
    ...(cloudflare ? [probe('cloudflare', 'Workers · listagem', cloudflare, env.CLOUDFLARE_API_TOKEN)] :
      [Promise.resolve({ provider: 'cloudflare' as const, check: 'Workers · listagem', ok: false,
        status: 0, reason: 'account_id_missing', hint: 'Cloudflare account ID não configurado.' })]),
  ]);
  return {
    checks,
    github_secret_version: /^\d{1,10}$/.test(env.GITHUB_TOKEN_SECRET_VERSION || '')
      ? env.GITHUB_TOKEN_SECRET_VERSION! : null,
    checked_at: new Date().toISOString(),
  };
}
