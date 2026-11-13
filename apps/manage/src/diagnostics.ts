/**
 * Read-only diagnostics using the credentials installed in the running Manage Worker.
 * Results contain only fixed reason codes and safe GitHub permissions metadata.
 * Never return HTTP bodies, credentials, Authorization, identity, JWT or request URLs.
 */
import type { Env } from './auth';

// --- TYPES & INTERFACES ---

export type ProviderType = 'github' | 'cloudflare';

export type ProbeResult = {
  provider: ProviderType;
  check: string;
  ok: boolean;
  status: number;
  reason: string;
  hint: string;
  accepted_permissions?: string;
};

export interface ManageDiagnosticsReport {
  checks: ProbeResult[];
  github_secret_version: string | null;
  checked_at: string;
}

// --- CONFIGURATION & CONSTANTS ---

const DIAGNOSTICS_CONFIG = {
  GITHUB_API_BASE: 'https://api.github.com/repos/',
  CLOUDFLARE_API_BASE: 'https://api.cloudflare.com/client/v4/accounts/',
  DEFAULT_REPO: 'rodkisten/photointel',
  DEFAULT_ENV: 'production',
  TIMEOUT_MS: 9000,
  MAX_BODY_LENGTH: 2048,
  MAX_PERMISSIONS_LENGTH: 180,
} as const;

const PATTERNS = {
  GITHUB_ACCEPT_HEADER: /^[a-z_]+=(?:read|write|admin|none)(?:[,; ][a-z_]+=(?:read|write|admin|none))*$/i,
  REPOSITORY: /^[\w-]+\/[\w.-]+$/,
  CLOUDFLARE_ACCOUNT: /^[a-f0-9]{32}$/i,
  SECRET_VERSION: /^\d{1,10}$/,
};

// --- REASON PARSERS ---

function githubReason(status: number, headers: Headers, body: string): [string, string] {
  const rateLimitRemaining = headers.get('X-RateLimit-Remaining');
  if (rateLimitRemaining === '0') {
    return ['rate_limited', 'GitHub: limite de API atingido. Tente novamente depois da reposição.'];
  }
  if (headers.has('X-GitHub-SSO')) {
    return ['sso_authorization', 'GitHub exige autorização SSO para o token.'];
  }

  let message = '';
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') {
      message = parsed.message.toLowerCase();
    }
  } catch {
    /* untrusted response */
  }

  if (status === 401 || message.includes('bad credentials')) {
    return [
      'invalid_token',
      'GitHub não reconhece o token instalado no Worker. Confira a versão do Secret Manager e republique o Manage.',
    ];
  }

  if (
    message.includes('resource not accessible by personal access token') ||
    message.includes('resource not accessible by integration')
  ) {
    return [
      'insufficient_permissions',
      'O token existe, mas o GitHub recusou a permissão deste endpoint. Confira o repositório selecionado e as permissões indicadas abaixo.',
    ];
  }

  if (status === 403) {
    return [
      'forbidden',
      'GitHub recusou esta operação (403). Verifique o escopo do token, acesso ao repositório e headers de permissões.',
    ];
  }

  if (status === 404) {
    return ['not_found_or_hidden', 'Repositório ou recurso não visível com este token (404).'];
  }

  return ['http_' + status, 'GitHub retornou HTTP ' + status + '.'];
}

function cloudflareReason(status: number, body: string): [string, string] {
  let code = 0;
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown }> };
    const parsedCode = parsed?.errors?.[0]?.code;
    if (typeof parsedCode === 'number' && Number.isSafeInteger(parsedCode)) {
      code = parsedCode;
    }
  } catch {
    /* never expose response */
  }

  if (code === 9106) {
    return [
      'authentication_9106',
      'Cloudflare 9106: autenticação não reconhecida ou cabeçalho Authorization ausente no upstream. Confira o secret implantado, não a conta no GitHub.',
    ];
  }

  if (code === 10000) {
    return [
      'authentication_10000',
      'Cloudflare recusou a autenticação. Confira escopo, expiração e a conta vinculada ao token.',
    ];
  }

  if (status === 403) {
    return ['forbidden', 'Cloudflare 403: token autenticado, mas sem acesso ao recurso solicitado.'];
  }

  return [
    code ? 'cloudflare_' + code : 'http_' + status,
    'Cloudflare retornou HTTP ' + status + (code ? ', código ' + code : '') + '.',
  ];
}

// --- PROBE EXECUTOR ---

async function probe(
  provider: ProviderType,
  check: string,
  url: string,
  token: string | undefined,
): Promise<ProbeResult> {
  const trimmedToken = token?.trim();

  if (!trimmedToken) {
    return {
      provider,
      check,
      ok: false,
      status: 0,
      reason: 'missing_token',
      hint: 'O secret não está instalado no Manage Worker.',
    };
  }

  try {
    const headers = new Headers({ 
      Accept: 'application/json', 
      Authorization: 'Bearer ' + trimmedToken 
    });

    if (provider === 'github') {
      headers.set('X-GitHub-Api-Version', '2022-11-28');
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(DIAGNOSTICS_CONFIG.TIMEOUT_MS),
    });

    const status = response.status;
    const permissions = provider === 'github' 
      ? response.headers.get('X-Accepted-GitHub-Permissions')?.trim() || '' 
      : '';

    const accepted_permissions = 
      PATTERNS.GITHUB_ACCEPT_HEADER.test(permissions) && 
      permissions.length <= DIAGNOSTICS_CONFIG.MAX_PERMISSIONS_LENGTH 
        ? permissions 
        : undefined;

    if (response.ok) {
      return {
        provider,
        check,
        ok: true,
        status,
        reason: 'ok',
        hint: 'Acesso verificado pelo provedor.',
        ...(accepted_permissions ? { accepted_permissions } : {}),
      };
    }

    const body = (await response.text()).slice(0, DIAGNOSTICS_CONFIG.MAX_BODY_LENGTH);
    const [reason, hint] = provider === 'github' 
      ? githubReason(status, response.headers, body) 
      : cloudflareReason(status, body);

    return {
      provider,
      check,
      ok: false,
      status,
      reason,
      hint,
      ...(accepted_permissions ? { accepted_permissions } : {}),
    };
  } catch {
    return {
      provider,
      check,
      ok: false,
      status: 0,
      reason: 'network_failure',
      hint: 'Falha de rede ou timeout ao contactar o provedor.',
    };
  }
}

// --- MAIN DIAGNOSTICS RUNNER ---

export async function runManageDiagnostics(
  env: Env,
): Promise<ManageDiagnosticsReport> {
  const repository = env.GITHUB_REPO || DIAGNOSTICS_CONFIG.DEFAULT_REPO;
  
  if (!PATTERNS.REPOSITORY.test(repository)) {
    return { 
      checks: [], 
      github_secret_version: null, 
      checked_at: new Date().toISOString() 
    };
  }

  const githubBaseUrl = DIAGNOSTICS_CONFIG.GITHUB_API_BASE + repository;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
  
  const cloudflareBaseUrl = PATTERNS.CLOUDFLARE_ACCOUNT.test(accountId)
    ? `${DIAGNOSTICS_CONFIG.CLOUDFLARE_API_BASE}${accountId}/workers/scripts`
    : null;

  const githubEnvironment = env.GITHUB_ENVIRONMENT || DIAGNOSTICS_CONFIG.DEFAULT_ENV;

  const checks = await Promise.all([
    probe('github', 'Repositório', githubBaseUrl, env.GITHUB_API_TOKEN),
    probe('github', 'Actions · execuções', `${githubBaseUrl}/actions/runs?per_page=1`, env.GITHUB_API_TOKEN),
    probe('github', 'Actions · workflows', `${githubBaseUrl}/actions/workflows?per_page=1`, env.GITHUB_API_TOKEN),
    probe(
      'github',
      'Environment · variável',
      `${githubBaseUrl}/environments/${encodeURIComponent(githubEnvironment)}/variables/GCP_CONFIG_ENV`,
      env.GITHUB_API_TOKEN,
    ),
    ...(cloudflareBaseUrl
      ? [probe('cloudflare', 'Workers · listagem', cloudflareBaseUrl, env.CLOUDFLARE_API_TOKEN)]
      : [
          Promise.resolve({
            provider: 'cloudflare' as const,
            check: 'Workers · listagem',
            ok: false,
            status: 0,
            reason: 'account_id_missing',
            hint: 'Cloudflare account ID não configurado.',
          }),
        ]),
  ]);

  const rawSecretVersion = env.GITHUB_TOKEN_SECRET_VERSION || '';
  const github_secret_version = PATTERNS.SECRET_VERSION.test(rawSecretVersion) 
    ? rawSecretVersion 
    : null;

  return {
    checks,
    github_secret_version,
    checked_at: new Date().toISOString(),
  };
}
