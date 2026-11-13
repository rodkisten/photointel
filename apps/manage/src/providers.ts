import { parseConfiguration } from './config-reconcile';
import { ApiError, redact } from './auth';
import type { Env, Identity } from './auth';

// --- TYPES & INTERFACES ---

export interface WorkflowInputsMap {
  [workflowFile: string]: Record<string, string[]>;
}

export interface CloudRunLogEntry {
  timestamp?: string;
  severity?: string;
  resource?: {
    type?: string;
    labels?: {
      service_name?: string;
      job_name?: string;
    };
  };
  jsonPayload?: unknown;
  textPayload?: unknown;
  protoPayload?: unknown;
  httpRequest?: {
    requestMethod?: string;
    status?: number;
    latency?: string;
    responseSize?: string;
    protocol?: string;
    requestUrl?: string;
  };
  operation?: unknown;
  sourceLocation?: unknown;
  insertId?: string;
}

// --- CONFIGURATION & CONSTANTS ---

export const PROVIDER_CONFIG = {
  GITHUB_API_VERSION: '2022-11-28',
  USER_AGENT: 'PhotoIntel-Manage',
  TIMEOUT_MS: 12_000,
  MAX_BODY_SLICE_BYTES: 4096,
  MAX_RESPONSE_SIZE_BYTES: 2_000_000, // 2 MB
  DEFAULT_PROJECT: 'photointel',
  DEFAULT_REGION: 'us-central1',
  DEFAULT_REPO: 'rodkisten/photointel',
  MAX_LOG_ITEMS: 70,
  MAX_LOG_MESSAGE_LENGTH: 20_000,
  TELEGRAM_TOKEN_MAX_LENGTH: 8192,
  CONFIG_MAX_LENGTH: 120_000,
} as const;

export const PATTERNS = {
  REPOSITORY: /^[\w-]+\/[\w.-]+$/,
  WIF_AUDIENCE: /^\/\/iam.googleapis.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[\w-]+\/providers\/[\w-]+$/,
  SERVICE_ACCOUNT: /^[a-z][\w-]{2,70}@[a-z][\w-]{4,60}\.iam\.gserviceaccount\.com$/,
  REGION: /^[a-z]{2,20}-[a-z0-9-]{2,40}[0-9]$/,
  SECRET_VERSION: /^\d{1,10}$/,
  INLINE_SECRET: /(?:github_pat_|ghp_|-----BEGIN PRIVATE KEY-----)/,
  UPSTREAM_ERROR: /^[a-z_]{3,60}$/i,
};

// --- WORKFLOW DEFINITIONS ---

export const WORKFLOW_INPUTS: WorkflowInputsMap = {
  'gcp-deploy.yml': {
    action: ['release', 'build', 'jobs-deploy', 'migrate', 'deploy', 'scheduler', 'cleanup'],
    migration_mode: ['plan', 'apply', 'diagnose'],
    migration_database: ['unselected', 'initial-empty', 'existing-with-backup'],
    migration_backup_prefix: [],
  },
  'cloudflare-setup.yml': { mode: ['plan', 'apply'] },
  'gcp-health.yml': {},
  'deploy-worker.yml': {},
  'gcp-migrate.yml': {
    migration_mode: ['plan', 'apply', 'diagnose'],
    migration_database: ['unselected', 'initial-empty', 'existing-with-backup'],
    migration_backup_prefix: [],
  },
  'gcp-validation.yml': {},
  'icloud-validation.yml': {},
  'icloud-setup.yml': {},
  'backend-smoke.yml': {},
};

// --- FAULT CLASSIFICATION ---

/** Classify provider faults without returning remote response bodies or credentials. */
function providerFault(url: string, status: number, body: string, responseHeaders: Headers): ApiError {
  const host = new URL(url).hostname;
  let upstream = '';
  let numericCode = '';

  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      errors?: Array<{ code?: unknown }>;
    };
    if (typeof parsed.error === 'string' && PATTERNS.UPSTREAM_ERROR.test(parsed.error)) {
      upstream = parsed.error.toLowerCase();
    }
    const first = parsed.errors?.[0]?.code;
    if (typeof first === 'number' && Number.isSafeInteger(first)) {
      numericCode = String(first);
    }
  } catch {
    /* provider sent HTML or non-JSON, never echo its contents */
  }

  if (host === 'sts.googleapis.com') {
    const reason =
      upstream === 'invalid_target'
        ? 'Federação GCP: provider WIF inexistente ou audience não corresponde ao provider.'
        : upstream === 'invalid_grant'
          ? 'Federação GCP: Cloudflare Access JWT recusado. Verifique issuer, allowed audiences e condição WIF.'
          : 'Falha na troca STS. Confira WIF, issuer, audience e atributos do Cloudflare Access.';
    return new ApiError(503, 'GCP_STS_' + (upstream || status), reason);
  }

  if (host === 'iamcredentials.googleapis.com') {
    return new ApiError(
      503,
      'GCP_IMPERSONATE_' + status,
      'GCP recusou a impersonação. Confira roles/iam.workloadIdentityUser no photointel-manage e o principal WIF exato.',
    );
  }

  if (host === 'api.github.com') {
    const permissions = (responseHeaders.get('X-Accepted-GitHub-Permissions') || '').trim();
    const allowedPermissions =
      /^[a-z_]+=(?:read|write|admin)(?:(?:,|;)[ ]?[a-z_]+=(?:read|write|admin))*$/i.test(permissions)
        ? permissions.slice(0, 180)
        : '';
    
    let upstreamMessage = '';
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === 'string') {
        upstreamMessage = parsed.message.toLowerCase();
      }
    } catch {
      /* untrusted provider body */
    }

    const classification =
      status === 401 || upstreamMessage.includes('bad credentials')
        ? 'GitHub rejeitou a credencial instalada no Worker.'
        : responseHeaders.has('X-GitHub-SSO')
          ? 'GitHub exige autorização SSO para esta credencial.'
          : upstreamMessage.includes('resource not accessible by personal access token') ||
              upstreamMessage.includes('resource not accessible by integration')
            ? 'O token foi reconhecido, mas falta acesso a esta operação ou a este repositório.'
            : status === 403
              ? 'GitHub recusou o acesso (403). Confirme permissões e visibilidade do repositório.'
              : 'GitHub API recusou a operação (HTTP ' + status + ').';
              
    return new ApiError(
      503,
      'GITHUB_' + status,
      classification + (allowedPermissions ? ' Permissões exigidas: ' + allowedPermissions + '.' : ''),
    );
  }

  if (host === 'secretmanager.googleapis.com') {
    const reason = status === 403
      ? 'Secret Manager recusou o acesso. Execute Setup GCP → permissions para atualizar as permissões do Manage.'
      : status === 404
        ? 'Secret ou versão não encontrada no projeto photointel.'
        : status === 409
          ? 'Esse secret já existe ou há conflito com outra operação.'
          : 'Google Secret Manager recusou a operação (HTTP ' + status + ').';
          
    return new ApiError(503, 'GCP_SECRET_MANAGER_' + status, reason);
  }

  if (host === 'api.cloudflare.com' && numericCode === '9106') {
    return new ApiError(
      503,
      'CLOUDFLARE_400_9106',
      'Cloudflare não reconheceu a autenticação (9106). O token do Manage pode estar inválido, desatualizado ou sem header Authorization no provedor.',
    );
  }

  if (host === 'api.cloudflare.com') {
    return new ApiError(
      503,
      'CLOUDFLARE_' + status + (numericCode ? '_' + numericCode : ''),
      'Cloudflare API recusou a operação (HTTP ' +
        status +
        (numericCode ? ', código ' + numericCode : '') +
        '). Confira conta, escopo do token e parâmetros da API.',
    );
  }

  return new ApiError(502, 'PROVIDER_' + status, 'Provedor recusou a operação (HTTP ' + status + ').');
}

// --- CORE PROVIDER TRANSPORT ---

export async function provider(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');

  const parsedUrl = new URL(url);
  if (parsedUrl.hostname === 'api.github.com') {
    headers.set('User-Agent', PROVIDER_CONFIG.USER_AGENT);
  }
  if (token?.trim()) {
    headers.set('Authorization', 'Bearer ' + token.trim());
  }

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROVIDER_CONFIG.TIMEOUT_MS),
  });

  if (!response.ok) {
    // Limit any inspection to 4 KB; do not log/return upstream bodies or tokens.
    const body = await response
      .text()
      .then((x) => x.slice(0, PROVIDER_CONFIG.MAX_BODY_SLICE_BYTES))
      .catch(() => '');
      
    throw providerFault(url, response.status, body, response.headers);
  }

  if (response.status === 204) return { ok: true };

  const contentLength = Number(response.headers.get('Content-Length') || 0);
  if (contentLength > PROVIDER_CONFIG.MAX_RESPONSE_SIZE_BYTES) {
    throw new ApiError(502, 'RESPONSE_SIZE', 'Resposta maior que 2 MB');
  }

  const text = await response.text();
  if (text.length > PROVIDER_CONFIG.MAX_RESPONSE_SIZE_BYTES) {
    throw new ApiError(502, 'RESPONSE_SIZE', 'Resposta muito grande');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(502, 'RESPONSE_JSON', 'Resposta externa inválida');
  }

  // Cloudflare REST can return 200 + success:false.
  if (parsedUrl.hostname === 'api.cloudflare.com') {
    const cf = parsed as { success?: boolean; errors?: Array<{ code?: unknown }> };
    if (cf?.success === false) {
      const code = cf.errors?.[0]?.code;
      throw new ApiError(
        503,
        'CLOUDFLARE_API' + (typeof code === 'number' ? '_' + code : ''),
        'Cloudflare respondeu success=false. Confira o código e o escopo do token.',
      );
    }
  }

  return parsed;
}

// --- GITHUB & CLOUDFLARE WRAPPERS ---

export function gh(env: Env, path: string, method = 'GET', payload?: unknown): Promise<unknown> {
  if (!env.GITHUB_API_TOKEN) {
    throw new ApiError(503, 'GITHUB_TOKEN', 'Configure GITHUB_API_TOKEN');
  }
  
  const repo = env.GITHUB_REPO || PROVIDER_CONFIG.DEFAULT_REPO;
  if (!PATTERNS.REPOSITORY.test(repo)) {
    throw new ApiError(503, 'GITHUB_REPO', 'Repositório inválido');
  }

  return provider('https://api.github.com/repos/' + repo + path, env.GITHUB_API_TOKEN, {
    method,
    headers: { 'X-GitHub-Api-Version': PROVIDER_CONFIG.GITHUB_API_VERSION, Accept: 'application/vnd.github+json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

export function cf(env: Env, path: string, method = 'GET', payload?: unknown): Promise<unknown> {
  if (!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) {
    throw new ApiError(503, 'CF_TOKEN', 'Configure Cloudflare account ID e API token');
  }

  return provider(
    'https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + path,
    env.CLOUDFLARE_API_TOKEN,
    { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) },
  );
}

// --- CONFIGURATION UTILITIES ---

export function configPath(env: Env): string {
  return (
    '/environments/' +
    encodeURIComponent(env.GITHUB_ENVIRONMENT || 'production') +
    '/variables/GCP_CONFIG_ENV'
  );
}

export async function digest(raw: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function readConfig(env: Env): Promise<{ value: string; version: string; updated_at?: string }> {
  const variable = (await gh(env, configPath(env))) as { value?: string; updated_at?: string };
  if (typeof variable.value !== 'string') {
    throw new ApiError(502, 'GCP_CONFIG_ENV', 'Variável production/GCP_CONFIG_ENV não encontrada');
  }
  return { value: variable.value, version: await digest(variable.value), updated_at: variable.updated_at };
}

export function validateConfig(value: string): void {
  try {
    parseConfiguration(value);
  } catch (error) {
    throw new ApiError(422, 'CONFIG_REFERENCE', error instanceof Error ? error.message : 'Configuração inválida');
  }

  if (!value.trim() || value.length > PROVIDER_CONFIG.CONFIG_MAX_LENGTH || value.includes('\0')) {
    throw new ApiError(422, 'CONFIG_SIZE', 'Valor precisa ter de 1 a 120.000 caracteres');
  }
  if (PATTERNS.INLINE_SECRET.test(value)) {
    throw new ApiError(422, 'INLINE_SECRET', 'Guarde credenciais no Secret Manager');
  }

  // Telegram relay tokens may be supplied inline in GCP_CONFIG_ENV.
  // This is an explicit exception; other secrets still require Secret Manager.
  const inlineTelegram = value
    .match(/^\s*(?:EXTRA_ENVIRONMENT__)?TELEGRAM_NOTIFICATION_API_TOKEN\s*=\s*(.*)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');

  if (inlineTelegram !== undefined && inlineTelegram.length === 0) {
    throw new ApiError(422, 'TELEGRAM_TOKEN_SIZE', 'O token do Telegram não pode estar vazio.');
  }

  if (value.trim().startsWith('{')) {
    let config: unknown;
    try {
      config = JSON.parse(value);
    } catch {
      throw new ApiError(422, 'CONFIG_JSON', 'JSON inválido');
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ApiError(422, 'CONFIG_JSON', 'Esperado objeto JSON');
    }

    const data = config as Record<string, unknown>;
    const extra = data.extra_environment;
    
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      if ('TELEGRAM_NOTIFICATION_API_TOKEN' in extra) {
        const token = (extra as Record<string, unknown>).TELEGRAM_NOTIFICATION_API_TOKEN;
        if (typeof token !== 'string' || token.length === 0 || token.length > PROVIDER_CONFIG.TELEGRAM_TOKEN_MAX_LENGTH) {
          throw new ApiError(422, 'TELEGRAM_TOKEN_SIZE', 'Token Telegram inválido.');
        }
      }
    }

    if (
      data.project_id !== PROVIDER_CONFIG.DEFAULT_PROJECT ||
      typeof data.region !== 'string' ||
      !data.secrets ||
      typeof data.secrets !== 'object' ||
      Array.isArray(data.secrets)
    ) {
      throw new ApiError(422, 'CONFIG_SCHEMA', 'Projeto, região ou referências Secret Manager inválidas');
    }
  } else {
    if (!/^\s*PROJECT_ID\s*=\s*photointel\s*$/m.test(value) || !/^\s*REGION\s*=/m.test(value)) {
      throw new ApiError(422, 'CONFIG_ENV', 'O .env precisa conter PROJECT_ID=photointel e REGION');
    }
  }
}

// --- GCP & WIF TOKEN EXCHANGES ---

export async function gcpToken(env: Env, identity: Identity): Promise<string> {
  if (!env.GCP_WIF_AUDIENCE) {
    throw new ApiError(503, 'GCP_WIF', 'Configure GCP_WIF_AUDIENCE para consultar Google Cloud');
  }
  if (!PATTERNS.WIF_AUDIENCE.test(env.GCP_WIF_AUDIENCE)) {
    throw new ApiError(503, 'GCP_WIF', 'Audiência WIF inválida');
  }

  const token = (await provider('https://sts.googleapis.com/v1/token', '', {
    method: 'POST',
    body: JSON.stringify({
      audience: env.GCP_WIF_AUDIENCE,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: identity.jwt,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    }),
  })) as { access_token?: string };

  if (!token.access_token) {
    throw new ApiError(503, 'GCP_STS', 'Federação OIDC recusada');
  }

  const account = env.GCP_IMPERSONATE_SERVICE_ACCOUNT;
  if (!account) return token.access_token;

  if (!PATTERNS.SERVICE_ACCOUNT.test(account)) {
    throw new ApiError(503, 'GCP_SA', 'Conta de serviço inválida');
  }

  const result = (await provider(
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
      encodeURIComponent(account) +
      ':generateAccessToken',
    token.access_token,
    {
      method: 'POST',
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/cloud-platform'],
        lifetime: '600s',
      }),
    },
  )) as { accessToken?: string };

  if (!result.accessToken) {
    throw new ApiError(503, 'GCP_SA', 'Impersonação de conta não autorizada');
  }

  return result.accessToken;
}

export async function gcp(env: Env, identity: Identity, url: string, body?: unknown): Promise<unknown> {
  const token = await gcpToken(env, identity);
  return provider(url, token, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
}

export function gcpBase(env: Env): string {
  const project = env.GCP_PROJECT_ID || PROVIDER_CONFIG.DEFAULT_PROJECT;
  const region = env.GCP_REGION || PROVIDER_CONFIG.DEFAULT_REGION;

  if (project !== PROVIDER_CONFIG.DEFAULT_PROJECT || !PATTERNS.REGION.test(region)) {
    throw new ApiError(503, 'GCP_SCOPE', 'Projeto/região fora do escopo do PhotoIntel');
  }

  return 'https://run.googleapis.com/v2/projects/' + project + '/locations/' + region;
}

// --- LOGGING & OBSERVABILITY UTILITIES ---

export function logsExplorer(env: Env, correlation: string): string {
  const query =
    '(resource.type="cloud_run_job" OR resource.type="cloud_run_revision") AND SEARCH("' + correlation + '")';
  return (
    'https://console.cloud.google.com/logs/query;query=' +
    encodeURIComponent(query) +
    ';duration=P7D?project=' +
    (env.GCP_PROJECT_ID || PROVIDER_CONFIG.DEFAULT_PROJECT)
  );
}

/** Cloud Logging can supply JSON, text, proto or HTTP-only entries. */
function hasLogBody(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function mapCloudLogs(items: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) return [];

  return items.slice(0, PROVIDER_CONFIG.MAX_LOG_ITEMS).map((entry: unknown) => {
    const e = entry as CloudRunLogEntry;
    
    // A missing JSON payload must never become a visible empty {} tree.
    const payload = [e.jsonPayload, e.textPayload, e.protoPayload].find(hasLogBody);
    const http = e.httpRequest;
    
    const fallback = hasLogBody(http)
      ? {
          httpRequest: {
            method: http?.requestMethod,
            status: http?.status,
            latency: http?.latency,
            responseSize: http?.responseSize,
            protocol: http?.protocol,
            requestUrl: http?.requestUrl,
          },
          operation: e.operation,
          sourceLocation: e.sourceLocation,
        }
      : '';

    const message = payload ?? fallback;

    return {
      timestamp: e.timestamp,
      severity: e.severity,
      resource: e.resource?.type,
      service: e.resource?.labels?.service_name || e.resource?.labels?.job_name,
      message: hasLogBody(message) ? redact(message).slice(0, PROVIDER_CONFIG.MAX_LOG_MESSAGE_LENGTH) : '',
      insertId: e.insertId,
    };
  });
}
