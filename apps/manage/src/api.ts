import { githubAppIdentity, githubToken } from './github-app';
import { projectCatalogRoute } from './project-catalog';
import { terminalCatalogRoute } from './features/terminal/catalog';
import { terminalSessionRoute } from './features/terminal/protocol';
import { terminalPreflightRoute } from './features/terminal/preflight';
import { terminalTicketRoute } from './features/terminal/ticket';
import { terminalFilesRoute } from './features/terminal/files';
import { cloudRunJobsRoute } from './cloud-run-jobs';
import { workflowStudioRoute } from './workflow-studio-api';
import { parseWorkflowInputs } from './workflow-yaml';
import { diffNestedEnv } from './nested-env-diff';
import { notificationSettingsRoute } from './notification-settings';
import { workflowTemplateRoute } from './workflow-message';
import { workflowFailureRoute } from './workflow-failures';
import { ApiError, bodyJson, json, redact, requireOrigin } from './auth';
import { cloudflareRoute } from './cloudflare-management';
import { routerApi } from './deploy-router/service';
import { costRoute } from './costs';
import { infrastructureRoute } from './infrastructure';
import { planConfigChange } from './config-reconcile';
import { runManageDiagnostics } from './diagnostics';
import { parseLogRequest, gcpLogFilter } from './log-query';
import { secretRoutes } from './routes/secrets';
import { icloudAuthRoute } from './routes/icloud-auth';
import { handleIcloudDiagnostics } from './api-handlers';
import { PATTERNS, LIMITS, DEFAULTS, safeList, safeArray } from './api-utils';
import type {
  CloudRunExecution, CloudRunJob, CloudRunService, CloudSchedulerJob,
  CloudflareLogEvent, CloudflareWorkerDomain, CloudflareWorkerScript, GitHubWorkflowRun,
} from './api-utils';
import type { Env, Identity } from './auth';
import {
  WORKFLOW_INPUTS,
  cf,
  configPath,
  digest,
  gcp,
  gcpBase,
  gcpToken,
  gh,
  logsExplorer,
  mapCloudLogs,
  readConfig,
  validateConfig,
  provider,
} from './providers';

// TODO extract to file src/config/api-constants.ts
const API_CONFIG = {
  GITHUB: {
    API_BASE: 'https://api.github.com',
    API_VERSION: '2022-11-28',
    ACCEPT_HEADER: 'application/vnd.github+json',
    RAW_USERCONTENT_SUFFIX: '.githubusercontent.com',
    ACTIONS_USERCONTENT_SUFFIX: '.actions.githubusercontent.com',
    DEFAULT_BRANCH: 'main',
    WORKFLOWS_DIR: '.github/workflows',
    DEFAULT_ENVIRONMENT: 'production',
    REPOS_DELIMITER_REGEX: /[\s,;]+/,
    MAX_CATALOG_REPOS: 30,
    MAX_WORKFLOWS_PER_PAGE: 100,
    MAX_RUNS_PER_PAGE: 50,
    MAX_SCOPED_RUNS_PER_PAGE: 10,
    MAX_OVERVIEW_RUNS: 12,
    MAX_VARIABLE_PAGES: 20,
    MAX_TRIGGER_RULES: 100,
    MAX_TRIGGER_WORKFLOWS: 10,
    MAX_WORKFLOW_YAML_BYTES: 200_000,
    MAX_INPUT_VALUE_LENGTH: 1000,
    MAX_COST_ALERT_USD: 100_000,
    CONFIRMATION_KEYWORD: 'confirma',
    DISPATCH_CONFIRM_PREFIX: 'DEPLOY ',
    RETRY_CONFIRM_PREFIX: 'RETRY ',
    ALLOWED_RELAY_PREFIX: 'https://relay.migos.club/',
    WEBHOOK_TIMEOUT_MS: 8000,
    SPECIAL_VARS: {
      CONFIG_ENV: 'GCP_CONFIG_ENV',
      ENV_VARS: 'GCP_ENV_VARS',
      ENV_VARS_PREFIX: 'GCP_ENV_VARS__',
      COST_ALERT_USD: 'GCP_COST_ALERT_USD',
      VARIABLE_TRIGGERS: 'MANAGE_VARIABLE_TRIGGERS',
    },
    WORKFLOW_FILES: {
      MANAGE_DEPLOY: 'manage-deploy.yml',
      CONFIG_SYNC: 'config-sync.yml',
    },
    REQUIRED_APP_SECRETS: [
      'MANAGE_GITHUB_APP_ID',
      'MANAGE_GITHUB_APP_INSTALLATION_ID',
      'MANAGE_GITHUB_APP_PRIVATE_KEY',
    ] as const,
  },
  CLOUDFLARE: {
    LOG_QUERY_ID: 'photointel-manage-logs',
    LOG_DATASET: 'cloudflare-workers',
    LOG_LIMIT_SEARCH: 100,
    LOG_LIMIT_DEFAULT: 70,
    LOG_MESSAGE_MAX_LENGTH: 10_000,
    MAX_CRONS_PER_WORKER: 10,
    MAX_LISTED_WORKERS: 30,
  },
  GCP: {
    SCHEDULER_API_BASE: 'https://cloudscheduler.googleapis.com/v1',
    LOGGING_API_URL: 'https://logging.googleapis.com/v2/entries:list',
    CONSOLE_LOGS_URL: 'https://console.cloud.google.com/logs/query',
    PRIMARY_API_SERVICE: 'photointel-api',
    RESOURCE_PREFIX: 'photointel-',
    SERVICES_PAGE_SIZE: 40,
    OVERVIEW_SERVICES_PAGE_SIZE: 20,
    JOBS_PAGE_SIZE: 60,
    EXECUTIONS_PAGE_SIZE: 30,
    SCHEDULER_PAGE_SIZE: 60,
    LOGS_PAGE_SIZE: 500,
  },
  SENTRY: {
    API_BASE: 'https://sentry.io/api/0/organizations',
    DOMAIN_SUFFIX: '.sentry.io/issues/',
    ISSUES_LIMIT: 100,
    TITLE_MAX_LENGTH: 180,
    CULPRIT_MAX_LENGTH: 140,
  },
  UPSTREAM: {
    PHOTOS_CONTROL_PATH: '/v1/manage/jobs/control',
    CONFIG_PREVIEW_PATH: '/v1/manage/config/preview',
    MAX_PREVIEW_BYTES: 150_000,
    MAX_PHOTOS_CONTROL_BYTES: 30_000,
  },
  PAYLOAD_LIMITS: {
    DEFAULT_JSON: 12_000,
    VARIABLE_COPY: 4096,
    VARIABLE_UPDATE: 130_000,
    RERUN: 1000,
  },
  VALIDATION: {
    HTTPS_ORIGIN: /^https:\/\/[^/?#]+$/,
    HTTPS_URL: /^https:\/\//,
    WEBHOOK_URL: /^https:\/\/[a-z0-9.-]+(?:\/[a-zA-Z0-9/_-]*)?$/,
    WORKFLOW_FILENAME: /^[A-Za-z0-9_.-]+\.ya?ml$/,
    WORKFLOW_PATH: /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,
    ENV_VAR_NAME: /^[A-Z_][A-Z0-9_]{0,99}$/,
    GCP_ENV_SUBKEY: /^GCP_ENV_VARS__[A-Za-z_][A-Za-z0-9_]*$/,
    ENVIRONMENT_NAME: /^[a-zA-Z0-9_-]{1,64}$/,
    POSITIVE_INT: /^[1-9]\d*$/,
    USD_AMOUNT: /^\d+(?:\.\d{1,2})?$/,
    CRON_EXPRESSION: /^[0-9*,/ -]+$/,
    CRON_FIELDS_COUNT: 5,
    WORKER_NAME: /^photointel(?:-[a-z0-9-]+)?$/,
    WORKER_NAME_MAX_LENGTH: 70,
    GCP_EXECUTION_NAME: /^photointel-[a-z0-9-]{1,110}$/,
    GCP_SCHEDULER_NAME: /^photointel-[a-z0-9-]{1,55}$/,
  },
} as const;

const GITHUB_HEADERS = {
  Accept: API_CONFIG.GITHUB.ACCEPT_HEADER,
  'X-GitHub-Api-Version': API_CONFIG.GITHUB.API_VERSION,
} as const;

// TODO extract to file src/routes/route-helpers.ts
type RouteHandler = (request: Request, env: Env, identity: Identity) => Promise<Response | null | undefined>;

function githubProvider<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  return provider(url, token, {
    ...init,
    headers: {
      ...GITHUB_HEADERS,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }) as Promise<T>;
}

function getAllowedCatalogRepos(env: Env): { primary: string; allowed: Set<string>; list: string[] } {
  const primary = env.GITHUB_REPO || DEFAULTS.GITHUB_REPO;
  const configured = (env.MANAGE_PROJECT_REPOSITORIES || '')
    .split(API_CONFIG.GITHUB.REPOS_DELIMITER_REGEX)
    .filter((repo) => PATTERNS.REPOSITORY.test(repo));
  const list = [...new Set([primary, ...configured])].slice(0, API_CONFIG.GITHUB.MAX_CATALOG_REPOS);
  return { primary, allowed: new Set(list), list };
}

function assertAuthorizedCatalogRepo(env: Env, repository: string): void {
  const { allowed } = getAllowedCatalogRepos(env);
  if (!PATTERNS.REPOSITORY.test(repository) || !allowed.has(repository)) {
    throw new ApiError(403, 'PROJECT_SCOPE', 'Repositório não autorizado no catálogo');
  }
}

function getGcpProjectAndRegion(env: Env): { project: string; region: string } {
  return {
    project: env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID,
    region: env.GCP_REGION || DEFAULTS.REGION,
  };
}

function getUpstreamOrigin(env: Env, errorCode: string, errorMessage: string): string {
  const origin = env.PHOTOINTEL_API_ORIGIN;
  if (!origin || !API_CONFIG.VALIDATION.HTTPS_ORIGIN.test(origin)) {
    throw new ApiError(503, errorCode, errorMessage);
  }
  return origin;
}

function decodeBase64Utf8(base64Content: string): string {
  const raw = atob(base64Content.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
}

function isValidFiveFieldCron(cron: unknown): cron is string {
  return (
    typeof cron === 'string' &&
    cron.length <= 100 &&
    API_CONFIG.VALIDATION.CRON_EXPRESSION.test(cron) &&
    cron.trim().split(/\s+/).length === API_CONFIG.VALIDATION.CRON_FIELDS_COUNT
  );
}

function isValidVariableValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LIMITS.CONFIG_MAX_LENGTH &&
    !value.includes('\0') &&
    !PATTERNS.SECRET_SENSITIVE.test(value)
  );
}

// TODO extract to file src/routes/projects.ts
async function handleProjectsCatalog(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET') return null;

  if (path === '/api/projects') {
    const { primary, list: repos } = getAllowedCatalogRepos(env);
    const appConfigured = API_CONFIG.GITHUB.REQUIRED_APP_SECRETS.every((key) => Boolean(env[key]));
    const catalogToken = await githubToken(env).catch(() => undefined);

    const items = await Promise.all(
      repos.map(async (repo) => {
        const enabled = repo === primary;
        const shortName = repo.split('/')[1];
        if (!catalogToken) {
          return { id: repo, name: shortName, repository: repo, enabled, status: 'unavailable' };
        }
        try {
          const info = await githubProvider<{ name?: string; archived?: boolean; disabled?: boolean }>(
            `${API_CONFIG.GITHUB.API_BASE}/repos/${repo}`,
            catalogToken,
          );
          const status = info.archived || info.disabled
            ? 'archived'
            : appConfigured
              ? 'app_accessible'
              : 'discovered';
          return { id: repo, name: info.name || shortName, repository: repo, enabled, status };
        } catch {
          return { id: repo, name: shortName, repository: repo, enabled: false, status: 'unavailable' };
        }
      }),
    );

    return json({ items, global: { enabled: false, reason: 'Aguardando autorização e isolamento de secrets' } });
  }

  if (path === '/api/projects/workflows') {
    const repository = url.searchParams.get('repository') || '';
    assertAuthorizedCatalogRepo(env, repository);
    const token = await githubToken(env);
    const result = await githubProvider<{
      total_count?: number;
      workflows?: Array<{ id: number; name: string; path: string; state: string }>;
    }>(
      `${API_CONFIG.GITHUB.API_BASE}/repos/${repository}/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`,
      token,
    );
    return json({
      repository,
      total: result.total_count ?? 0,
      items: (result.workflows || []).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state })),
    });
  }

  if (path === '/api/projects/runs') {
    const repository = url.searchParams.get('repository') || '';
    assertAuthorizedCatalogRepo(env, repository);
    const token = await githubToken(env);
    const result = await githubProvider<{
      workflow_runs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        created_at: string;
      }>;
    }>(
      `${API_CONFIG.GITHUB.API_BASE}/repos/${repository}/actions/runs?per_page=${API_CONFIG.GITHUB.MAX_SCOPED_RUNS_PER_PAGE}`,
      token,
    );
    return json({
      repository,
      items: (result.workflow_runs || []).map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        html_url: run.html_url,
        created_at: run.created_at,
      })),
    });
  }

  const scopedJobs = path.match(/^\/api\/projects\/runs\/([1-9]\d*)\/jobs$/);
  if (scopedJobs) {
    const repository = url.searchParams.get('repository') || '';
    assertAuthorizedCatalogRepo(env, repository);
    const runId = scopedJobs[1];
    const token = await githubToken(env);
    const result = await githubProvider<{
      jobs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        started_at: string | null;
        completed_at: string | null;
        steps?: Array<{ name: string; status: string; conclusion: string | null; number: number }>;
      }>;
    }>(
      `${API_CONFIG.GITHUB.API_BASE}/repos/${repository}/actions/runs/${runId}/jobs?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`,
      token,
    );
    return json({
      repository,
      run_id: Number(runId),
      items: (result.jobs || []).map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        html_url: job.html_url,
        started_at: job.started_at,
        completed_at: job.completed_at,
        steps: (job.steps || []).map((step) => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
          number: step.number,
        })),
      })),
    });
  }

  return null;
}

// TODO extract to file src/routes/project-variables.ts
async function handleProjectVariables(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/projects/variables') return null;

  const repository = url.searchParams.get('repository') || '';
  const scope = url.searchParams.get('scope') || 'repository';
  const environment = url.searchParams.get('environment') || API_CONFIG.GITHUB.DEFAULT_ENVIRONMENT;

  if (!PATTERNS.REPOSITORY.test(repository)) {
    throw new ApiError(422, 'PROJECT_SCOPE', 'Repositório inválido');
  }

  const token = await githubToken(env);
  const repoInfo = await githubProvider<{ full_name?: string; archived?: boolean; disabled?: boolean }>(
    `${API_CONFIG.GITHUB.API_BASE}/repos/${repository}`,
    token,
  );

  if (repoInfo.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new ApiError(403, 'PROJECT_SCOPE', 'Repositório inacessível pela integração GitHub');
  }
  if (repoInfo.archived || repoInfo.disabled) {
    throw new ApiError(409, 'PROJECT_READ_ONLY', 'Repositório arquivado ou desativado');
  }
  if (!['repository', 'environment'].includes(scope) || !API_CONFIG.VALIDATION.ENVIRONMENT_NAME.test(environment)) {
    throw new ApiError(422, 'VARIABLE_SCOPE', 'Escopo ou environment inválido');
  }

  const buildVariablesBase = (repo: string, targetScope: string, targetEnv: string) =>
    `${API_CONFIG.GITHUB.API_BASE}/repos/${repo}${
      targetScope === 'repository'
        ? '/actions/variables'
        : `/environments/${encodeURIComponent(targetEnv)}/variables`
    }`;

  const base = buildVariablesBase(repository, scope, environment);

  const listVariables = async () => {
    const all: Array<{ name: string; value?: string; updated_at?: string }> = [];
    for (let page = 1; page <= API_CONFIG.GITHUB.MAX_VARIABLE_PAGES; page++) {
      const data = await githubProvider(
        `${base}?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}&page=${page}`,
        token,
      );
      const entries = safeList(data, 'variables') as Array<{ name: string; value?: string; updated_at?: string }>;
      all.push(...entries);
      if (entries.length < API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE) return all;
    }
    throw new ApiError(422, 'VARIABLE_LIMIT', 'Mais de 2000 variáveis; não é seguro editar uma lista incompleta');
  };

  if (request.method === 'GET') {
    const entries = await listVariables();
    return json({
      repository,
      scope,
      environment,
      items: await Promise.all(
        entries.map(async (entry) => ({
          name: entry.name,
          value: entry.value,
          version: await digest(String(entry.value || '')),
          updated_at: entry.updated_at,
        })),
      ),
    });
  }

  if (request.method === 'POST') {
    const input = await bodyJson<{
      name?: unknown;
      sourceRepository?: unknown;
      sourceScope?: unknown;
      sourceEnvironment?: unknown;
      sourceVersion?: unknown;
      confirm?: unknown;
    }>(request, API_CONFIG.PAYLOAD_LIMITS.VARIABLE_COPY);

    const { sourceRepository, sourceScope, sourceEnvironment } = input;
    if (
      input.confirm !== repository ||
      typeof input.name !== 'string' ||
      !PATTERNS.VARIABLE_NAME.test(input.name) ||
      typeof sourceRepository !== 'string' ||
      !PATTERNS.REPOSITORY.test(sourceRepository) ||
      (sourceScope !== 'repository' && sourceScope !== 'environment') ||
      typeof sourceEnvironment !== 'string' ||
      !API_CONFIG.VALIDATION.ENVIRONMENT_NAME.test(sourceEnvironment) ||
      typeof input.sourceVersion !== 'string'
    ) {
      throw new ApiError(422, 'VARIABLE_COPY', 'Origem, destino ou confirmação inválidos');
    }

    if (
      sourceRepository.toLowerCase() === repository.toLowerCase() &&
      sourceScope === scope &&
      (scope === 'repository' || sourceEnvironment === environment)
    ) {
      throw new ApiError(409, 'VARIABLE_COPY', 'Origem e destino são iguais');
    }

    const sourceBase = buildVariablesBase(sourceRepository, sourceScope, sourceEnvironment);
    const source = await githubProvider<{ name?: string; value?: string }>(
      `${sourceBase}/${encodeURIComponent(input.name)}`,
      token,
    );

    if (
      source.name !== input.name ||
      typeof source.value !== 'string' ||
      (await digest(source.value)) !== input.sourceVersion
    ) {
      throw new ApiError(409, 'VARIABLE_COPY_STALE', 'A variável de origem mudou. Atualize e tente novamente');
    }

    if (!isValidVariableValue(source.value)) {
      throw new ApiError(422, 'VARIABLE_VALUE', 'O valor não pode ser copiado como GitHub Variable');
    }

    const existing = (await listVariables()).some((entry) => entry.name === input.name);
    if (existing) {
      throw new ApiError(409, 'VARIABLE_EXISTS', 'Variável já existe no destino. Cópia cancelada');
    }

    await githubProvider(base, token, {
      method: 'POST',
      body: JSON.stringify({ name: input.name, value: source.value }),
    });

    console.log(
      JSON.stringify({
        event: 'project_variable_copied',
        sourceRepository,
        sourceScope,
        sourceEnvironment,
        repository,
        scope,
        environment,
        name: input.name,
        operator: identity.email,
      }),
    );
    return json({ ok: true });
  }

  if (request.method === 'PUT') {
    const input = await bodyJson<{ name?: unknown; value?: unknown; version?: unknown; confirm?: unknown }>(
      request,
      API_CONFIG.PAYLOAD_LIMITS.VARIABLE_UPDATE,
    );

    if (input.confirm !== repository) {
      throw new ApiError(409, 'PROJECT_CONFIRM', 'Confirme o nome completo do repositório');
    }
    if (typeof input.name !== 'string' || !PATTERNS.VARIABLE_NAME.test(input.name) || !isValidVariableValue(input.value)) {
      throw new ApiError(422, 'VARIABLE_VALUE', 'Nome ou valor inválido; não armazene secrets em variáveis');
    }

    const entries = await listVariables();
    const current = entries.find((entry) => entry.name === input.name);

    if (current && input.version !== (await digest(String(current.value || '')))) {
      throw new ApiError(409, 'VARIABLE_CONFLICT', 'Valor alterado; recarregue');
    }
    if (!current && input.version !== null) {
      throw new ApiError(409, 'VARIABLE_CONFLICT', 'Variável nova exige versão vazia');
    }

    await githubProvider(
      current ? `${base}/${encodeURIComponent(input.name)}` : base,
      token,
      {
        method: current ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: input.name, value: input.value }),
      },
    );

    console.log(
      JSON.stringify({
        event: 'project_variable_updated',
        repository,
        scope,
        environment,
        name: input.name,
        operator: identity.email,
      }),
    );
    return json({ ok: true });
  }

  return null;
}

// TODO extract to file src/routes/github-actions.ts
async function handleGithubRoutes(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/github/app-identity') {
    if (!env.MANAGE_GITHUB_APP_ID || !env.MANAGE_GITHUB_APP_PRIVATE_KEY) {
      return json({ configured: false, verified: false, slug: null });
    }
    try {
      const info = await githubAppIdentity(env);
      return json({ configured: true, verified: true, slug: info.slug, app_id: info.id, name: info.name });
    } catch {
      return json({ configured: true, verified: false, slug: null });
    }
  }

  if (method === 'GET' && path === '/api/github/auth-status') {
    const configured = {
      app_id: Boolean(env.MANAGE_GITHUB_APP_ID),
      installation_id: Boolean(env.MANAGE_GITHUB_APP_INSTALLATION_ID),
      private_key: Boolean(env.MANAGE_GITHUB_APP_PRIVATE_KEY),
    };
    const complete = Object.values(configured).every(Boolean);
    const partial = Object.values(configured).some(Boolean) && !complete;
    let verified = false;

    if (complete) {
      try {
        const token = await githubToken(env);
        const installation = await githubProvider<{ total_count?: number }>(
          `${API_CONFIG.GITHUB.API_BASE}/installation/repositories?per_page=1`,
          token,
        );
        verified = typeof installation.total_count === 'number';
      } catch {
        /* Keep provider errors and credentials server-side. */
      }
    }

    return json({
      mode: complete ? 'github_app' : partial ? 'incomplete' : env.GITHUB_API_TOKEN ? 'legacy_pat' : 'unconfigured',
      configured,
      verified,
      legacy_fallback: Boolean(env.GITHUB_API_TOKEN),
      required_secrets: API_CONFIG.GITHUB.REQUIRED_APP_SECRETS.filter((name) => !env[name]),
    });
  }

  if (method === 'GET' && path === '/api/workflows') {
    const data = await gh(env, `/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
    return json({
      items: safeList(data, 'workflows')
        .filter((x) => x.state === 'active' && API_CONFIG.VALIDATION.WORKFLOW_PATH.test(String(x.path || '')))
        .map((x) => {
          const file = String(x.path).split('/').pop() || '';
          return {
            id: x.id,
            name: x.name,
            file,
            state: x.state,
            html_url: x.html_url,
            inputs: WORKFLOW_INPUTS[file] || {},
          };
        }),
    });
  }

  const workflowInputsMatch = path.match(/^\/api\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)\/inputs$/);
  if (method === 'GET' && workflowInputsMatch) {
    const filename = workflowInputsMatch[1];
    const catalog = await gh(env, `/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
    const found = safeList(catalog, 'workflows').some(
      (x) => x.state === 'active' && String(x.path || '') === `${API_CONFIG.GITHUB.WORKFLOWS_DIR}/${filename}`,
    );
    if (!found) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow ativo não encontrado');

    const file = (await gh(
      env,
      `/contents/${API_CONFIG.GITHUB.WORKFLOWS_DIR}/${encodeURIComponent(filename)}?ref=${API_CONFIG.GITHUB.DEFAULT_BRANCH}`,
    )) as { content?: string; encoding?: string; size?: number };

    if (file.encoding !== 'base64' || !file.content || (file.size || 0) > API_CONFIG.GITHUB.MAX_WORKFLOW_YAML_BYTES) {
      throw new ApiError(422, 'WORKFLOW_YAML', 'Arquivo YAML indisponível ou muito grande');
    }

    try {
      return json(parseWorkflowInputs(decodeBase64Utf8(file.content)));
    } catch {
      throw new ApiError(422, 'WORKFLOW_YAML', 'Não foi possível interpretar workflow_dispatch.inputs');
    }
  }

  if (method === 'GET' && path === '/api/runs') {
    const data = await gh(env, `/actions/runs?per_page=${API_CONFIG.GITHUB.MAX_RUNS_PER_PAGE}`);
    return json({
      items: safeList<GitHubWorkflowRun>(data, 'workflow_runs').map((x) => ({
        id: x.id,
        name: x.name,
        display_title: x.display_title,
        status: x.status,
        conclusion: x.conclusion,
        run_number: x.run_number,
        created_at: x.created_at,
        updated_at: x.updated_at,
        html_url: x.html_url,
        actor: x.actor?.login,
        head_sha: x.head_sha,
        event: x.event,
      })),
    });
  }

  const jobs = path.match(/^\/api\/runs\/([1-9]\d*)\/jobs$/);
  if (method === 'GET' && jobs) {
    const data = await gh(env, `/actions/runs/${jobs[1]}/jobs?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
    return json({
      items: safeList(data, 'jobs').map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        started_at: x.started_at,
        completed_at: x.completed_at,
        html_url: x.html_url,
        steps: (Array.isArray(x.steps) ? x.steps : []).map((step) => {
          const item = step as Record<string, unknown>;
          return { name: item.name, number: item.number, conclusion: item.conclusion, status: item.status };
        }),
      })),
    });
  }

  const jobLogs = path.match(/^\/api\/runs\/([1-9]\d*)\/jobs\/([1-9]\d*)\/logs$/);
  if (method === 'GET' && jobLogs) {
    const data = await gh(env, `/actions/runs/${jobLogs[1]}/jobs?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
    if (!safeList(data, 'jobs').some((x) => String(x.id) === jobLogs[2])) {
      throw new ApiError(404, 'JOB_ID', 'O job não pertence à execução');
    }

    const repo = env.GITHUB_REPO || DEFAULTS.GITHUB_REPO;
    const response = await fetch(`${API_CONFIG.GITHUB.API_BASE}/repos/${repo}/actions/jobs/${jobLogs[2]}/logs`, {
      headers: {
        Accept: API_CONFIG.GITHUB.ACCEPT_HEADER,
        Authorization: `Bearer ${env.GITHUB_API_TOKEN}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.TIMEOUT_DEFAULT),
    });

    if (response.status !== 302) throw new ApiError(502, 'LOG_REDIRECT', 'Logs do job ainda não disponíveis');

    let target: URL;
    try {
      target = new URL(response.headers.get('location') || '');
    } catch {
      throw new ApiError(502, 'LOG_URL', 'Endereço de logs inválido');
    }

    if (
      target.protocol !== 'https:' ||
      !(
        target.hostname.endsWith(API_CONFIG.GITHUB.ACTIONS_USERCONTENT_SUFFIX) ||
        target.hostname.endsWith(API_CONFIG.GITHUB.RAW_USERCONTENT_SUFFIX)
      )
    ) {
      throw new ApiError(502, 'LOG_HOST', 'Destino externo não permitido');
    }

    const logResponse = await fetch(target.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.TIMEOUT_DEFAULT),
    });

    if (!logResponse.ok || Number(logResponse.headers.get('content-length') || 0) > LIMITS.LOG_MAX_BYTES) {
      throw new ApiError(502, 'LOG_SIZE', 'Log não disponível ou excede 400 KB');
    }

    const text = await logResponse.text();
    return json({
      text: redact(text.slice(-LIMITS.LOG_SLICE_LENGTH)).slice(-LIMITS.LOG_FINAL_LENGTH),
      truncated: text.length > LIMITS.LOG_FINAL_LENGTH,
    });
  }

  if (path === '/api/github/workflow-catalog' && method === 'GET') {
    const response = (await gh(env, `/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`)) as {
      workflows?: Array<{ name?: string; path?: string; state?: string }>;
    };
    return json({
      workflows: (response.workflows || [])
        .filter((item) => item.state === 'active' && API_CONFIG.VALIDATION.WORKFLOW_PATH.test(item.path || ''))
        .map((item) => {
          const filename = item.path?.split('/').pop() || '';
          return { name: item.name || filename, path: filename };
        }),
    });
  }

  if (method === 'POST' && path === '/api/dispatch') {
    const input = await bodyJson<{ workflow?: string; inputs?: Record<string, string>; confirm?: string }>(
      request,
      API_CONFIG.PAYLOAD_LIMITS.DEFAULT_JSON,
    );

    if (!input.workflow || !API_CONFIG.VALIDATION.WORKFLOW_FILENAME.test(input.workflow)) {
      throw new ApiError(422, 'WORKFLOW', 'Nome de workflow inválido');
    }

    const available = await gh(env, `/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
    const found = safeList(available, 'workflows').some(
      (x) => x.state === 'active' && String(x.path || '').split('/').pop() === input.workflow,
    );
    if (!found) throw new ApiError(422, 'WORKFLOW', 'Workflow não encontrado ou inativo');

    const file = (await gh(
      env,
      `/contents/${API_CONFIG.GITHUB.WORKFLOWS_DIR}/${encodeURIComponent(input.workflow)}?ref=${API_CONFIG.GITHUB.DEFAULT_BRANCH}`,
    )) as { content?: string; encoding?: string; size?: number };

    if (file.encoding !== 'base64' || !file.content || (file.size || 0) > API_CONFIG.GITHUB.MAX_WORKFLOW_YAML_BYTES) {
      throw new ApiError(422, 'WORKFLOW_YAML', 'Workflow indisponível');
    }

    const parsed = parseWorkflowInputs(decodeBase64Utf8(file.content));
    if (!parsed.dispatchable) throw new ApiError(422, 'WORKFLOW_DISPATCH', 'Workflow não aceita execução manual');

    if (input.confirm !== `${API_CONFIG.GITHUB.DISPATCH_CONFIRM_PREFIX}${input.workflow}`) {
      throw new ApiError(409, 'CONFIRM', 'Confirmação de execução necessária');
    }

    const spec = parsed.inputs;
    const inputs = input.inputs || {};
    if (
      !inputs ||
      typeof inputs !== 'object' ||
      Array.isArray(inputs) ||
      Object.entries(inputs).some(
        ([key, value]) =>
          !(key in spec) ||
          typeof value !== 'string' ||
          value.length > API_CONFIG.GITHUB.MAX_INPUT_VALUE_LENGTH ||
          (spec[key]?.type === 'choice' && !spec[key].options.includes(value)),
      )
    ) {
      throw new ApiError(422, 'INPUTS', 'Input inválido ou não autorizado');
    }

    if (Object.entries(spec).some(([key, field]) => field.required && !(inputs[key] ?? field.default).trim())) {
      throw new ApiError(422, 'INPUTS_REQUIRED', 'Preencha os parâmetros obrigatórios');
    }

    const result = await gh(env, `/actions/workflows/${input.workflow}/dispatches`, 'POST', {
      ref: API_CONFIG.GITHUB.DEFAULT_BRANCH,
      inputs,
    });

    console.log(
      JSON.stringify({
        event: 'manage_workflow_dispatch',
        workflow: input.workflow,
        operator: identity.email,
      }),
    );
    return json({ ok: true, result }, 202);
  }

  const rerun = path.match(/^\/api\/runs\/([1-9]\d*)\/rerun-failed$/);
  if (method === 'POST' && rerun) {
    const input = await bodyJson<{ confirm?: string }>(request, API_CONFIG.PAYLOAD_LIMITS.RERUN);
    if (input.confirm !== `${API_CONFIG.GITHUB.RETRY_CONFIRM_PREFIX}${rerun[1]}`) {
      throw new ApiError(409, 'CONFIRM', 'Confirmação de retentativa necessária');
    }
    const result = await gh(env, `/actions/runs/${rerun[1]}/rerun-failed-jobs`, 'POST');
    console.log(JSON.stringify({ event: 'manage_rerun', run: rerun[1], operator: identity.email }));
    return json({ ok: true, result }, 202);
  }

  return null;
}

// TODO extract to file src/routes/github-variables-and-triggers.ts
async function handleGithubVariablesAndTriggers(
  request: Request,
  env: Env,
  identity: Identity,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const envName = encodeURIComponent(env.GITHUB_ENVIRONMENT || API_CONFIG.GITHUB.DEFAULT_ENVIRONMENT);
  const envVariablesBase = `/environments/${envName}/variables`;
  const triggersKey = API_CONFIG.GITHUB.SPECIAL_VARS.VARIABLE_TRIGGERS;

  if (path === '/api/github/variable-triggers') {
    if (method === 'GET') {
      const result = (await gh(env, `${envVariablesBase}/${triggersKey}`).catch(() => null)) as { value?: string } | null;
      const raw = result?.value || '{}';
      let rules: unknown = {};
      try {
        rules = JSON.parse(raw);
      } catch {
        /* legacy invalid value */
      }
      return json({ rules, version: await digest(raw) });
    }

    if (method === 'PUT') {
      requireOrigin(request);
      const input = await bodyJson<{ rules?: unknown; version?: unknown; confirm?: unknown }>(
        request,
        API_CONFIG.PAYLOAD_LIMITS.DEFAULT_JSON,
      );

      if (input.confirm !== API_CONFIG.GITHUB.CONFIRMATION_KEYWORD) {
        throw new ApiError(409, 'TRIGGER_CONFIRM', 'Digite confirma para salvar gatilhos.');
      }
      if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)) {
        throw new ApiError(422, 'TRIGGER_RULES', 'Regras inválidas.');
      }

      const rules = input.rules as Record<string, unknown>;
      if (Object.keys(rules).length > API_CONFIG.GITHUB.MAX_TRIGGER_RULES) {
        throw new ApiError(422, 'TRIGGER_LIMIT', 'Máximo de 100 regras.');
      }

      const catalog = (await gh(env, `/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`)) as {
        workflows?: Array<{ path?: string; state?: string }>;
      };
      const allowed = new Set(
        (catalog.workflows || []).filter((x) => x.state === 'active').map((x) => x.path?.split('/').pop()),
      );

      for (const [name, rule] of Object.entries(rules)) {
        const isInvalidName =
          !API_CONFIG.VALIDATION.ENV_VAR_NAME.test(name) ||
          name === triggersKey ||
          name === API_CONFIG.GITHUB.SPECIAL_VARS.CONFIG_ENV ||
          (name.startsWith(API_CONFIG.GITHUB.SPECIAL_VARS.ENV_VARS_PREFIX) &&
            !API_CONFIG.VALIDATION.GCP_ENV_SUBKEY.test(name));

        if (isInvalidName) {
          throw new ApiError(422, 'TRIGGER_NAME', 'Nome de variável não autorizado.');
        }
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          throw new ApiError(422, 'TRIGGER_RULE', 'Regra inválida.');
        }

        const entry = rule as { mode?: unknown; workflows?: unknown; webhook?: unknown };
        if (!['none', 'workflows', 'webhook'].includes(String(entry.mode))) {
          throw new ApiError(422, 'TRIGGER_MODE', 'Modo inválido.');
        }

        if (
          entry.mode === 'workflows' &&
          (!Array.isArray(entry.workflows) ||
            entry.workflows.length > API_CONFIG.GITHUB.MAX_TRIGGER_WORKFLOWS ||
            entry.workflows.some((x) => typeof x !== 'string' || !allowed.has(x)))
        ) {
          throw new ApiError(422, 'TRIGGER_WORKFLOWS', 'Selecione até dez workflows ativos.');
        }

        if (
          entry.mode === 'webhook' &&
          (typeof entry.webhook !== 'string' ||
            !API_CONFIG.VALIDATION.WEBHOOK_URL.test(entry.webhook) ||
            !entry.webhook.startsWith(API_CONFIG.GITHUB.ALLOWED_RELAY_PREFIX))
        ) {
          throw new ApiError(422, 'TRIGGER_WEBHOOK', 'Somente webhooks HTTPS do Relay autorizado são permitidos.');
        }
      }

      const current = (await gh(env, `${envVariablesBase}/${triggersKey}`).catch(() => null)) as { value?: string } | null;
      const raw = current?.value || '{}';
      if (input.version !== (await digest(raw))) {
        throw new ApiError(409, 'TRIGGER_CONFLICT', 'Regras alteradas; recarregue.');
      }

      const next = JSON.stringify(rules);
      await gh(env, current ? `${envVariablesBase}/${triggersKey}` : envVariablesBase, current ? 'PATCH' : 'POST', {
        name: triggersKey,
        value: next,
      });
      return json({ ok: true, version: await digest(next) });
    }
  }

  if (path === '/api/github/variables') {
    const scope = url.searchParams.get('scope') || 'environment';
    if (scope !== 'environment' && scope !== 'repository') {
      throw new ApiError(422, 'VARIABLE_SCOPE', 'Escolha repositório ou environment');
    }

    const base = scope === 'repository' ? '/actions/variables' : envVariablesBase;

    if (method === 'GET') {
      const data = await gh(env, `${base}?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
      return json({
        scope,
        items: await Promise.all(
          safeList(data, 'variables').map(async (entry) => ({
            name: entry.name,
            value: entry.name === API_CONFIG.GITHUB.SPECIAL_VARS.CONFIG_ENV ? null : entry.value,
            version: await digest(String(entry.value || '')),
            updated_at: entry.updated_at,
          })),
        ),
      });
    }

    if (method === 'PUT') {
      const input = await bodyJson<{ name?: unknown; value?: unknown; version?: unknown; confirm?: unknown }>(
        request,
        API_CONFIG.PAYLOAD_LIMITS.VARIABLE_UPDATE,
      );
      const { name, value } = input;

      if (
        typeof name !== 'string' ||
        !PATTERNS.VARIABLE_NAME.test(name) ||
        name === API_CONFIG.GITHUB.SPECIAL_VARS.CONFIG_ENV ||
        !isValidVariableValue(value)
      ) {
        throw new ApiError(422, 'VARIABLE_VALUE', 'Nome ou valor inválido; use Secret Manager para credenciais');
      }

      const deployManage = name === API_CONFIG.GITHUB.SPECIAL_VARS.COST_ALERT_USD;
      if (deployManage) {
        if (scope !== 'environment') {
          throw new ApiError(422, 'VARIABLE_SCOPE', 'Limite GCP deve ficar no environment production.');
        }
        if (
          !API_CONFIG.VALIDATION.USD_AMOUNT.test(value) ||
          Number(value) <= 0 ||
          Number(value) > API_CONFIG.GITHUB.MAX_COST_ALERT_USD
        ) {
          throw new ApiError(422, 'COST_ALERT', 'Informe limite positivo em USD, até 100000.');
        }
        if (input.confirm !== API_CONFIG.GITHUB.CONFIRMATION_KEYWORD) {
          throw new ApiError(
            409,
            'VARIABLE_CONFIRM',
            'Atenção: mudar esta variável acionará Manage Deploy. Digite confirma.',
          );
        }
      }

      const stored = (await gh(env, `${envVariablesBase}/${triggersKey}`).catch(() => null)) as { value?: string } | null;
      let allRules: Record<string, { mode?: string; workflows?: string[]; webhook?: string }> = {};
      try {
        allRules = JSON.parse(stored?.value || '{}') as typeof allRules;
      } catch {
        /* ignore invalid legacy rules */
      }

      const rule = allRules[name] || {};
      const existing = await gh(env, `${base}?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`);
      const match = safeList(existing, 'variables').find((entry) => entry.name === name);

      const nestedChanges =
        name === API_CONFIG.GITHUB.SPECIAL_VARS.ENV_VARS
          ? diffNestedEnv(String(match?.value || ''), value)
          : [];

      const nestedRules: Array<{ key: string; rule: typeof rule }> = [];
      if (name === API_CONFIG.GITHUB.SPECIAL_VARS.ENV_VARS) {
        for (const change of nestedChanges) {
          const entry = allRules[`${API_CONFIG.GITHUB.SPECIAL_VARS.ENV_VARS_PREFIX}${change.key}`];
          if (entry) nestedRules.push({ key: change.key, rule: entry });
        }
      }

      const isRuleActive = (r: typeof rule) =>
        (r.mode === 'workflows' && Boolean(r.workflows?.length)) || (r.mode === 'webhook' && Boolean(r.webhook));

      const hasRule = isRuleActive(rule) || nestedRules.some((x) => isRuleActive(x.rule));

      if (name === API_CONFIG.GITHUB.SPECIAL_VARS.ENV_VARS && input.confirm !== API_CONFIG.GITHUB.CONFIRMATION_KEYWORD) {
        throw new ApiError(
          409,
          'VARIABLE_CONFIRM',
          'ATENÇÃO: GCP_ENV_VARS pode alterar serviços de produção. Revise os gatilhos e digite confirma.',
        );
      }
      if (hasRule && input.confirm !== API_CONFIG.GITHUB.CONFIRMATION_KEYWORD) {
        throw new ApiError(409, 'VARIABLE_CONFIRM', 'Atenção: alterar esta variável acionará gatilhos. Digite confirma.');
      }

      if (match) {
        if (typeof input.version !== 'string' || input.version !== (await digest(String(match.value || '')))) {
          throw new ApiError(409, 'VARIABLE_CONFLICT', 'A variável foi alterada; recarregue antes de salvar');
        }
        await gh(env, `${base}/${encodeURIComponent(name)}`, 'PATCH', { name, value });
      } else {
        if (input.version !== null) {
          throw new ApiError(409, 'VARIABLE_CONFLICT', 'Nova variável exige versão vazia');
        }
        await gh(env, base, 'POST', { name, value });
      }

      console.log(JSON.stringify({ event: 'github_variable_updated', name, scope, operator: identity.email }));

      let dispatch: 'queued' | 'failed' | 'none' = 'none';
      if (deployManage) {
        try {
          await gh(env, `/actions/workflows/${API_CONFIG.GITHUB.WORKFLOW_FILES.MANAGE_DEPLOY}/dispatches`, 'POST', {
            ref: API_CONFIG.GITHUB.DEFAULT_BRANCH,
            inputs: { mode: 'apply' },
          });
          dispatch = 'queued';
        } catch {
          dispatch = 'failed';
        }
      }

      const triggered: Array<{ target: string; status: 'queued' | 'failed' }> = [];
      if (hasRule) {
        const catalog = (await gh(env, `/actions/workflows?per_page=${API_CONFIG.GITHUB.MAX_WORKFLOWS_PER_PAGE}`)) as {
          workflows?: Array<{ path?: string; state?: string }>;
        };
        const allowed = new Set(
          (catalog.workflows || []).filter((x) => x.state === 'active').map((x) => x.path?.split('/').pop()),
        );
        const effectiveRules = [{ key: name, rule }, ...nestedRules];
        const dispatched = new Set<string>();

        for (const selected of effectiveRules) {
          const selectedRule = selected.rule;
          if (selectedRule.mode === 'workflows') {
            for (const workflow of (selectedRule.workflows || []).slice(0, API_CONFIG.GITHUB.MAX_TRIGGER_WORKFLOWS)) {
              if (dispatched.has(workflow)) continue;
              dispatched.add(workflow);
              if (!allowed.has(workflow)) continue;
              try {
                await gh(env, `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, 'POST', {
                  ref: API_CONFIG.GITHUB.DEFAULT_BRANCH,
                });
                triggered.push({ target: workflow, status: 'queued' });
              } catch {
                triggered.push({ target: workflow, status: 'failed' });
              }
            }
          } else if (
            selectedRule.mode === 'webhook' &&
            selectedRule.webhook?.startsWith(API_CONFIG.GITHUB.ALLOWED_RELAY_PREFIX)
          ) {
            try {
              const response = await fetch(selectedRule.webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'variable.changed', name, scope, key: selected.key }),
                redirect: 'error',
                signal: AbortSignal.timeout(API_CONFIG.GITHUB.WEBHOOK_TIMEOUT_MS),
              });
              triggered.push({ target: 'Relay webhook', status: response.ok ? 'queued' : 'failed' });
            } catch {
              triggered.push({ target: 'Relay webhook', status: 'failed' });
            }
          }
        }
      }

      return json({
        ok: true,
        version: await digest(value),
        dispatch,
        triggered,
        changed_keys: nestedChanges.map((x) => x.key),
      });
    }
  }

  return null;
}

// TODO extract to file src/routes/config-and-photos.ts
async function handleConfigAndPhotosRoutes(
  request: Request,
  env: Env,
  identity: Identity,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'POST' && path === '/api/config/preview') {
    const input = await bodyJson<{ value?: unknown }>(request, API_CONFIG.PAYLOAD_LIMITS.VARIABLE_UPDATE);
    if (typeof input.value !== 'string' || !input.value || input.value.length > LIMITS.CONFIG_MAX_LENGTH) {
      throw new ApiError(422, 'CONFIG_PREVIEW_INPUT', 'Informe um .env válido de até 120 KB');
    }

    const origin = getUpstreamOrigin(env, 'CONFIG_PREVIEW_ORIGIN', 'Configure PHOTOINTEL_API_ORIGIN no Worker Manage');
    const upstream = await fetch(`${origin}${API_CONFIG.UPSTREAM.CONFIG_PREVIEW_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cf-Access-Jwt-Assertion': identity.jwt,
      },
      body: JSON.stringify({ value: input.value }),
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.TIMEOUT_PREVIEW),
    });

    if (!upstream.ok) {
      throw new ApiError(502, 'CONFIG_PREVIEW_UPSTREAM', `Prévia Python indisponível (HTTP ${upstream.status})`);
    }
    if (Number(upstream.headers.get('content-length') || 0) > API_CONFIG.UPSTREAM.MAX_PREVIEW_BYTES) {
      throw new ApiError(502, 'CONFIG_PREVIEW_SIZE', 'Prévia excedeu o limite');
    }

    const payload = await upstream.text();
    if (payload.length > API_CONFIG.UPSTREAM.MAX_PREVIEW_BYTES) {
      throw new ApiError(502, 'CONFIG_PREVIEW_SIZE', 'Prévia excedeu o limite');
    }
    return json(JSON.parse(payload));
  }

  if (method === 'GET' && path === '/api/config') {
    return json(await readConfig(env));
  }

  if (method === 'PUT' && path === '/api/config') {
    const input = await bodyJson<{ value?: unknown; version?: unknown; auto_apply?: unknown; confirm?: unknown }>(request);
    if (
      typeof input.value !== 'string' ||
      typeof input.version !== 'string' ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean')
    ) {
      throw new ApiError(422, 'CONFIG_FIELDS', 'Informe value, version e auto_apply booleano');
    }
    if (input.auto_apply !== false && input.confirm !== API_CONFIG.GITHUB.CONFIRMATION_KEYWORD) {
      throw new ApiError(409, 'CONFIG_CONFIRM', 'Digite confirma para autorizar workflows.');
    }

    validateConfig(input.value);
    const current = await readConfig(env);
    if (input.version !== current.version) {
      throw new ApiError(409, 'CONFIG_CONFLICT', 'Configuração alterada em outra sessão: recarregue');
    }

    let plan;
    try {
      plan = planConfigChange(current.value, input.value);
    } catch {
      throw new ApiError(
        422,
        'CONFIG_DIFF',
        'Não foi possível interpretar o .env para determinar os workflows. Revise a sintaxe.',
      );
    }

    const version = await digest(input.value);
    const configVarName = API_CONFIG.GITHUB.SPECIAL_VARS.CONFIG_ENV;

    if (plan.changed.length === 0) {
      if (current.value !== input.value) {
        await gh(env, configPath(env), 'PATCH', { name: configVarName, value: input.value });
      }
      return json({ ok: true, version, updated_at: new Date().toISOString(), plan, dispatches: [] });
    }

    await gh(env, configPath(env), 'PATCH', { name: configVarName, value: input.value });
    const dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }> = [];
    const requiresAdmin = plan.blocked;

    if (input.auto_apply !== false && !requiresAdmin) {
      for (const workflow of plan.workflows) {
        try {
          await gh(env, `/actions/workflows/${workflow.file}/dispatches`, 'POST', {
            ref: API_CONFIG.GITHUB.DEFAULT_BRANCH,
            inputs:
              workflow.file === API_CONFIG.GITHUB.WORKFLOW_FILES.CONFIG_SYNC
                ? { ...workflow.inputs, config_version: version }
                : workflow.inputs,
          });
          dispatches.push({ file: workflow.file, label: workflow.label, status: 'queued' });
        } catch (error) {
          dispatches.push({
            file: workflow.file,
            label: workflow.label,
            status: 'failed',
            error: error instanceof ApiError ? error.message : 'Não foi possível iniciar o workflow.',
          });
        }
      }
    }

    console.log(
      JSON.stringify({
        event: 'manage_config_updated',
        operator: identity.email,
        changed_keys: plan.changed.length,
        auto_apply: input.auto_apply !== false,
        dispatched: dispatches.map((item) => ({ file: item.file, status: item.status })),
        requires_admin: requiresAdmin,
      }),
    );

    return json({
      ok: true,
      version,
      updated_at: new Date().toISOString(),
      plan,
      dispatches,
      auto_apply: input.auto_apply !== false,
      blocked: requiresAdmin,
    });
  }

  if (path === '/api/photos/jobs/control' && (method === 'GET' || method === 'POST')) {
    const origin = getUpstreamOrigin(env, 'PHOTOS_CONTROL_ORIGIN', 'Configure PHOTOINTEL_API_ORIGIN');
    let upstreamPath: string = API_CONFIG.UPSTREAM.PHOTOS_CONTROL_PATH;

    if (method === 'POST') {
      const input = await bodyJson<{ action?: unknown; confirm?: unknown }>(request);
      if ((input.action !== 'pause' && input.action !== 'resume') || input.confirm !== input.action) {
        throw new ApiError(422, 'PHOTOS_CONTROL', 'Confirme pausa ou retomada da fila');
      }
      upstreamPath += `/${input.action}`;
    }

    const response = await fetch(`${origin}${upstreamPath}`, {
      method,
      headers: { 'Cf-Access-Jwt-Assertion': identity.jwt, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.TIMEOUT_DEFAULT),
    });

    if (!response.ok) {
      throw new ApiError(502, 'PHOTOS_CONTROL_UPSTREAM', `Photos recusou a operação (HTTP ${response.status})`);
    }
    if (Number(response.headers.get('content-length') || 0) > API_CONFIG.UPSTREAM.MAX_PHOTOS_CONTROL_BYTES) {
      throw new ApiError(502, 'PHOTOS_CONTROL_SIZE', 'Resposta excedeu o limite');
    }

    const payload = await response.text();
    if (payload.length > API_CONFIG.UPSTREAM.MAX_PHOTOS_CONTROL_BYTES) {
      throw new ApiError(502, 'PHOTOS_CONTROL_SIZE', 'Resposta excedeu o limite');
    }
    try {
      return json(JSON.parse(payload));
    } catch {
      throw new ApiError(502, 'PHOTOS_CONTROL_JSON', 'Resposta inválida do Photos');
    }
  }

  return null;
}

// TODO extract to file src/routes/cloudflare-operations.ts
async function handleCloudflareOpsRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/cloudflare/workers') {
    const [scripts, domains] = await Promise.all([cf(env, '/workers/scripts'), cf(env, '/workers/domains')]);
    return json({
      items: safeList<CloudflareWorkerScript>(scripts, 'result').map((x) => ({
        name: x.id,
        modified_on: x.modified_on,
      })),
      domains: safeList<CloudflareWorkerDomain>(domains, 'result').map((x) => ({
        hostname: x.hostname,
        service: x.service,
      })),
    });
  }

  if (method === 'GET' && path === '/api/cloudflare/logs') {
    const investigation = parseLogRequest(url.searchParams);
    const search = investigation.terms[0] || investigation.entry || '';
    const data = await cf(env, '/workers/observability/telemetry/query', 'POST', {
      queryId: API_CONFIG.CLOUDFLARE.LOG_QUERY_ID,
      view: 'events',
      dry: true,
      timeframe: { from: investigation.start, to: investigation.end },
      limit: search ? API_CONFIG.CLOUDFLARE.LOG_LIMIT_SEARCH : API_CONFIG.CLOUDFLARE.LOG_LIMIT_DEFAULT,
      order: 'desc',
      parameters: {
        datasets: [API_CONFIG.CLOUDFLARE.LOG_DATASET],
        ...(search ? { needle: { value: search, matchCase: false } } : {}),
      },
    });

    const result = (data as { result?: Record<string, unknown> }).result;
    const events = safeArray<CloudflareLogEvent>(result?.events);
    const matching = investigation.entry
      ? events.filter((x) => String(x.$metadata?.id || '') === investigation.entry)
      : events;

    return json({
      items: matching.map((x) => ({
        id: x.$metadata?.id,
        timestamp: x.timestamp,
        service: x.$metadata?.service || x.$workers?.scriptName,
        severity: x.$metadata?.level || '',
        outcome: x.$workers?.outcome || '',
        message: redact(x.source ?? x.$metadata?.message ?? x.$metadata?.error ?? '').slice(
          0,
          API_CONFIG.CLOUDFLARE.LOG_MESSAGE_MAX_LENGTH,
        ),
      })),
    });
  }

  if (method === 'POST' && path === '/api/cloudflare/worker-crons') {
    const input = await bodyJson<{ name?: unknown; crons?: unknown; confirm?: unknown }>(request);
    const { name, crons, confirm } = input;

    if (
      typeof name !== 'string' ||
      !API_CONFIG.VALIDATION.WORKER_NAME.test(name) ||
      name.length > API_CONFIG.VALIDATION.WORKER_NAME_MAX_LENGTH ||
      confirm !== name ||
      !Array.isArray(crons) ||
      crons.length > API_CONFIG.CLOUDFLARE.MAX_CRONS_PER_WORKER ||
      !crons.every(isValidFiveFieldCron)
    ) {
      throw new ApiError(422, 'WORKER_CRON', 'Confirme o Worker e informe crons válidos (UTC, cinco campos)');
    }

    const normalized = [...new Set(crons.map((cron) => cron.trim().replace(/\s+/g, ' ')))];
    const updated = await cf(
      env,
      `/workers/scripts/${encodeURIComponent(name)}/schedules`,
      'PUT',
      normalized.map((cron) => ({ cron })),
    );
    return json({ name, schedules: normalized, updated: Boolean(updated) });
  }

  if (method === 'GET' && path === '/api/cloudflare/worker-crons') {
    const scripts = (await cf(env, '/workers/scripts')) as { result?: Array<{ id?: string }> };
    const names = safeList(scripts, 'result')
      .map((x) => String(x.id || ''))
      .filter((name) => API_CONFIG.VALIDATION.WORKER_NAME.test(name))
      .slice(0, API_CONFIG.CLOUDFLARE.MAX_LISTED_WORKERS);

    const items = await Promise.all(
      names.map(async (name) => {
        try {
          const response = (await cf(env, `/workers/scripts/${encodeURIComponent(name)}/schedules`)) as {
            result?: { schedules?: Array<{ cron?: string }> } | Array<{ cron?: string }>;
          };
          const result = response.result;
          const schedules = Array.isArray(result) ? result : result?.schedules || [];
          return { name, schedules: schedules.map((x) => ({ cron: x.cron || '' })) };
        } catch {
          return { name, schedules: [], error: 'Não foi possível consultar os crons deste Worker' };
        }
      }),
    );

    return json({ items });
  }

  return null;
}

// TODO extract to file src/routes/gcp-operations.ts
async function handleGcpOpsRoutes(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/gcp/telegram') {
    const service = (await gcp(env, identity, `${gcpBase(env)}/services/${API_CONFIG.GCP.PRIMARY_API_SERVICE}`)) as {
      template?: {
        containers?: Array<{
          env?: Array<{
            name?: string;
            value?: string;
            valueSource?: { secretKeyRef?: unknown };
            valueFrom?: { secretKeyRef?: unknown };
          }>;
        }>;
      };
    };

    const settings = service.template?.containers?.flatMap((c) => c.env || []) || [];
    const byName = new Map(settings.map((entry) => [entry.name, entry]));
    const enabled = byName.get('TELEGRAM_JOB_EVENTS_ENABLED')?.value === 'true';
    const endpoint = API_CONFIG.VALIDATION.HTTPS_URL.test(byName.get('TELEGRAM_NOTIFICATION_URL')?.value || '');
    const destination = Boolean(byName.get('TELEGRAM_NOTIFICATION_CHAT_ID')?.value);
    const token = byName.get('TELEGRAM_NOTIFICATION_API_TOKEN');
    const tokenBound = Boolean(
      (typeof token?.value === 'string' && token.value.length > 0) ||
        token?.valueSource?.secretKeyRef ||
        token?.valueFrom?.secretKeyRef,
    );
    const ready = enabled && endpoint && destination && tokenBound;

    return json({
      enabled,
      endpointConfigured: endpoint,
      destinationConfigured: destination,
      tokenBound,
      ready,
      explanation: ready
        ? 'Configuração Cloud Run presente; verifique o Relay e as entregas reais para confirmar o envio.'
        : 'Telegram não está completamente configurado na revisão do Cloud Run; confira GCP_CONFIG_ENV (token direto ou referência Secret Manager).',
    });
  }

  if (method === 'GET' && path === '/api/gcp/services') {
    const data = await gcp(env, identity, `${gcpBase(env)}/services?pageSize=${API_CONFIG.GCP.SERVICES_PAGE_SIZE}`);
    return json({
      items: safeList<CloudRunService>(data, 'services').map((x) => ({
        name: x.name,
        uri: x.uri,
        latestReadyRevision: x.latestReadyRevision,
        latestCreatedRevision: x.latestCreatedRevision,
        updateTime: x.updateTime,
        condition: x.terminalCondition?.state,
        reconciling: x.reconciling,
      })),
    });
  }

  if (method === 'GET' && path === '/api/gcp/jobs') {
    const data = await gcp(env, identity, `${gcpBase(env)}/jobs?pageSize=${API_CONFIG.GCP.JOBS_PAGE_SIZE}`);
    return json({
      items: safeList<CloudRunJob>(data, 'jobs').map((x) => ({
        name: x.name,
        updateTime: x.updateTime,
        latestCreatedExecution: x.latestCreatedExecution?.name,
        executionCount: x.executionCount,
      })),
    });
  }

  if (method === 'GET' && path === '/api/gcp/executions') {
    const name = url.searchParams.get('job') || '';
    if (!PATTERNS.GCP_JOB_NAME.test(name)) {
      throw new ApiError(422, 'GCP_JOB', 'Selecione um job PhotoIntel válido');
    }
    const data = await gcp(
      env,
      identity,
      `${gcpBase(env)}/jobs/${encodeURIComponent(name)}/executions?pageSize=${API_CONFIG.GCP.EXECUTIONS_PAGE_SIZE}`,
    );
    return json({
      job: name,
      items: safeList<CloudRunExecution>(data, 'executions').map((x) => ({
        name: x.name,
        createTime: x.createTime,
        startTime: x.startTime,
        completionTime: x.completionTime,
        runningCount: x.runningCount,
        succeededCount: x.succeededCount,
        failedCount: x.failedCount,
        cancelledCount: x.cancelledCount,
        taskCount: x.taskCount,
        condition: x.conditions?.[0]?.state,
        logUri: x.logUri,
      })),
    });
  }

  if (method === 'POST' && path === '/api/gcp/executions/cancel') {
    const input = await bodyJson<{ job?: unknown; execution?: unknown; confirm?: unknown }>(request);
    const { job, execution, confirm } = input;

    if (
      typeof job !== 'string' ||
      !PATTERNS.GCP_JOB_NAME.test(job) ||
      typeof execution !== 'string' ||
      !API_CONFIG.VALIDATION.GCP_EXECUTION_NAME.test(execution) ||
      confirm !== execution
    ) {
      throw new ApiError(422, 'EXECUTION_CANCEL', 'Confirme a execução PhotoIntel válida');
    }

    const base = gcpBase(env);
    const resource = `${base}/jobs/${encodeURIComponent(job)}/executions/${encodeURIComponent(execution)}`;
    const existing = (await gcp(env, identity, resource)) as { name?: string; completionTime?: string };

    if (
      existing.name?.split('/').pop() !== execution ||
      existing.name?.split('/').slice(-3, -2)[0] !== job
    ) {
      throw new ApiError(409, 'EXECUTION_SCOPE', 'Execução fora do job permitido');
    }
    if (existing.completionTime) {
      return json({ name: existing.name, unchanged: true, completed: true });
    }

    const updated = (await gcp(env, identity, `${resource}:cancel`, {})) as { name?: string };
    return json({ name: updated.name || existing.name, cancellationRequested: true });
  }

  if (method === 'POST' && path === '/api/gcp/scheduler/control') {
    const input = (await bodyJson(request)) as { name?: unknown; action?: unknown; confirm?: unknown };
    const { name, action, confirm } = input;

    if (
      typeof name !== 'string' ||
      !API_CONFIG.VALIDATION.GCP_SCHEDULER_NAME.test(name) ||
      (action !== 'pause' && action !== 'resume') ||
      confirm !== name
    ) {
      throw new ApiError(422, 'SCHEDULER_CONTROL', 'Confirme o nome do agendamento PhotoIntel');
    }

    const { project, region } = getGcpProjectAndRegion(env);
    gcpBase(env);
    const expectedResource = `projects/${project}/locations/${region}/jobs/${name}`;
    const base = `${API_CONFIG.GCP.SCHEDULER_API_BASE}/${expectedResource}`;
    const existing = (await gcp(env, identity, base)) as { name?: string; state?: string };

    if (existing.name !== expectedResource) {
      throw new ApiError(409, 'SCHEDULER_SCOPE', 'Agendamento fora do projeto permitido');
    }
    if ((action === 'pause' && existing.state === 'PAUSED') || (action === 'resume' && existing.state === 'ENABLED')) {
      return json({ name: existing.name, state: existing.state, unchanged: true });
    }

    const updated = (await gcp(env, identity, `${base}:${action}`, {})) as { name?: string; state?: string };
    return json({ name: updated.name, state: updated.state, unchanged: false });
  }

  if (method === 'POST' && path === '/api/gcp/scheduler/schedule') {
    const input = await bodyJson<{ name?: unknown; schedule?: unknown; confirm?: unknown }>(request);
    const { name, schedule, confirm } = input;

    if (
      typeof name !== 'string' ||
      !API_CONFIG.VALIDATION.GCP_SCHEDULER_NAME.test(name) ||
      !isValidFiveFieldCron(schedule) ||
      confirm !== name
    ) {
      throw new ApiError(422, 'SCHEDULER_SCHEDULE', 'Confirme o job e informe um cron de cinco campos');
    }

    const { project, region } = getGcpProjectAndRegion(env);
    gcpBase(env);
    const resource = `projects/${project}/locations/${region}/jobs/${name}`;
    const endpoint = `${API_CONFIG.GCP.SCHEDULER_API_BASE}/${resource}`;
    const existing = (await gcp(env, identity, endpoint)) as { name?: string; state?: string; schedule?: string };

    if (existing.name !== resource) {
      throw new ApiError(409, 'SCHEDULER_SCOPE', 'Agendamento fora do projeto permitido');
    }
    if (existing.schedule === schedule) {
      return json({ name, schedule, state: existing.state, unchanged: true });
    }

    const token = await gcpToken(env, identity);
    const updated = (await provider(`${endpoint}?updateMask=schedule`, token, {
      method: 'PATCH',
      body: JSON.stringify({ schedule }),
    })) as { schedule?: string; state?: string };

    return json({ name, schedule: updated.schedule, state: updated.state, unchanged: false });
  }

  if (method === 'GET' && path === '/api/gcp/scheduler') {
    const { project, region } = getGcpProjectAndRegion(env);
    const data = await gcp(
      env,
      identity,
      `${API_CONFIG.GCP.SCHEDULER_API_BASE}/projects/${project}/locations/${region}/jobs?pageSize=${API_CONFIG.GCP.SCHEDULER_PAGE_SIZE}`,
    );
    return json({
      items: safeList<CloudSchedulerJob>(data, 'jobs')
        .filter((x) => (String(x.name).split('/').pop() || '').startsWith(API_CONFIG.GCP.RESOURCE_PREFIX))
        .map((x) => ({
          name: x.name,
          state: x.state,
          schedule: x.schedule,
          timeZone: x.timeZone,
          lastAttemptTime: x.lastAttemptTime,
          status: x.status?.code ?? null,
        })),
    });
  }

  if (method === 'GET' && path === '/api/gcp/logs') {
    const investigation = parseLogRequest(url.searchParams);
    const { project } = getGcpProjectAndRegion(env);
    const data = await gcp(env, identity, API_CONFIG.GCP.LOGGING_API_URL, {
      resourceNames: [`projects/${project}`],
      filter: gcpLogFilter(investigation),
      orderBy: 'timestamp desc',
      pageSize: API_CONFIG.GCP.LOGS_PAGE_SIZE,
    });
    return json({
      items: mapCloudLogs((data as { entries?: unknown }).entries),
      console_url: investigation.terms.length
        ? logsExplorer(env, investigation.terms[0])
        : `${API_CONFIG.GCP.CONSOLE_LOGS_URL}?project=${project}`,
    });
  }

  return null;
}

// TODO extract to file src/routes/system-and-sentry.ts
async function handleSystemAndSentryRoutes(
  request: Request,
  env: Env,
  identity: Identity,
  reportError?: (error: unknown, provider?: string) => string | undefined,
  correlationId?: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET') return null;

  if (path === '/api/meta') {
    const { project, region } = getGcpProjectAndRegion(env);
    return json({
      email: identity.email,
      repo: env.GITHUB_REPO || DEFAULTS.GITHUB_REPO,
      project,
      gcp: Boolean(env.GCP_WIF_AUDIENCE),
      cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN),
      sentry: Boolean(env.SENTRY_DSN),
      sentry_reader: Boolean(env.SENTRY_API_TOKEN),
      sentry_org: env.SENTRY_ORG || null,
      cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID || null,
      gcp_region: region,
    });
  }

  if (path === '/api/diagnostics') {
    return json(await runManageDiagnostics(env));
  }

  if (path === '/api/icloud/diagnostics') {
    return handleIcloudDiagnostics(env, identity, gcp, gh, mapCloudLogs);
  }

  if (path === '/api/overview') {
    const tasks = await Promise.allSettled([
      gh(env, `/actions/runs?per_page=${API_CONFIG.GITHUB.MAX_OVERVIEW_RUNS}`),
      cf(env, '/workers/scripts'),
      env.GCP_WIF_AUDIENCE
        ? gcp(env, identity, `${gcpBase(env)}/services?pageSize=${API_CONFIG.GCP.OVERVIEW_SERVICES_PAGE_SIZE}`)
        : Promise.resolve(null),
    ]);

    const show = (i: number) => (tasks[i].status === 'fulfilled' ? tasks[i].value : null);
    const [ghData, cfData, gcpData] = [show(0), show(1), show(2)];

    const providerEvents = tasks.map((task, index) =>
      task.status === 'rejected'
        ? reportError?.(task.reason, ['github', 'cloudflare', 'gcp'][index])
        : undefined,
    );

    return json({
      provider_events: providerEvents,
      correlation_id: correlationId,
      runs: safeList<GitHubWorkflowRun>(ghData, 'workflow_runs').map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        created_at: x.created_at,
        html_url: x.html_url,
        run_number: x.run_number,
      })),
      workers: safeList<CloudflareWorkerScript>(cfData, 'result').map((x) => ({ name: x.id, modified_on: x.modified_on })),
      services: safeList<CloudRunService>(gcpData, 'services').map((x) => ({
        name: x.name,
        uri: x.uri,
        latestReadyRevision: x.latestReadyRevision,
        latestCreatedRevision: x.latestCreatedRevision,
        condition: x.terminalCondition?.state,
        reconciling: x.reconciling,
      })),
      providers: tasks.map((x) =>
        x.status === 'fulfilled' ? 'ok' : x.reason instanceof ApiError ? x.reason.message : 'indisponível',
      ),
      checked_at: new Date().toISOString(),
    });
  }

  if (path === '/api/sentry/issues') {
    if (!env.SENTRY_ORG) return json({ items: [], read_enabled: false, dashboard_url: null });
    if (!PATTERNS.SENTRY_ORG.test(env.SENTRY_ORG)) {
      throw new ApiError(503, 'SENTRY_ORG', 'Organização inválida');
    }

    const dashboardUrl = `https://${env.SENTRY_ORG}${API_CONFIG.SENTRY.DOMAIN_SUFFIX}`;
    if (!env.SENTRY_API_TOKEN) {
      return json({ items: [], read_enabled: false, dashboard_url: dashboardUrl });
    }

    const items = await provider(
      `${API_CONFIG.SENTRY.API_BASE}/${env.SENTRY_ORG}/issues/?query=is%3Aunresolved&sort=date&limit=${API_CONFIG.SENTRY.ISSUES_LIMIT}`,
      env.SENTRY_API_TOKEN,
    );

    return json({
      read_enabled: true,
      dashboard_url: dashboardUrl,
      items: (Array.isArray(items) ? items : []).map((issue) => {
        const item = issue as Record<string, unknown>;
        const project = item.project as Record<string, unknown> | null;
        return {
          id: item.id,
          title: redact(String(item.title ?? '')).slice(0, API_CONFIG.SENTRY.TITLE_MAX_LENGTH),
          level: item.level,
          count: item.count,
          lastSeen: item.lastSeen,
          permalink: item.permalink,
          culprit: redact(String(item.culprit ?? '')).slice(0, API_CONFIG.SENTRY.CULPRIT_MAX_LENGTH),
          project: project?.slug,
        };
      }),
    });
  }

  return null;
}

export async function api(
  request: Request,
  env: Env,
  identity: Identity,
  reportError?: (error: unknown, provider?: string) => string | undefined,
  correlationId?: string,
): Promise<Response> {
  const path = new URL(request.url).pathname;

  // 1. Rotas modulares já extraídas (executadas sequencialmente sem prefixo rígido)
  const modularRoutes: RouteHandler[] = [
    (req, e) => workflowStudioRoute(req, e),
    projectCatalogRoute,
    terminalFilesRoute,
    terminalTicketRoute,
    terminalPreflightRoute,
    terminalSessionRoute,
    (req, e) => terminalCatalogRoute(req, e),
    cloudRunJobsRoute,
    (req, e) => notificationSettingsRoute(req, e),
    (req, e) => workflowTemplateRoute(req, e),
    (req, e) => workflowFailureRoute(req, e),
  ];

  for (const route of modularRoutes) {
    const response = await route(request, env, identity);
    if (response) return response;
  }

  // 2. Rotas modulares mapeadas por prefixo de path
  const prefixedRoutes: Array<[string, RouteHandler]> = [
    ['/api/cloudflare/', (req, e) => cloudflareRoute(req, e)],
    ['/api/deploy-router', routerApi],
    ['/api/infrastructure', infrastructureRoute],
    ['/api/costs', costRoute],
    ['/api/secrets', secretRoutes],
    ['/api/icloud/auth/', icloudAuthRoute],
  ];

  for (const [prefix, handler] of prefixedRoutes) {
    if (path.startsWith(prefix)) {
      const response = await handler(request, env, identity);
      if (response) return response;
    }
  }

  // 3. Sub-roteadores internos (prontos para extração nos arquivos indicados pelos TODOs)
  const internalRoutes: RouteHandler[] = [
    (req, e) => handleProjectsCatalog(req, e),
    handleProjectVariables,
    handleGithubRoutes,
    handleGithubVariablesAndTriggers,
    handleConfigAndPhotosRoutes,
    (req, e) => handleCloudflareOpsRoutes(req, e),
    handleGcpOpsRoutes,
    (req, e, id) => handleSystemAndSentryRoutes(req, e, id, reportError, correlationId),
  ];

  for (const handler of internalRoutes) {
    const response = await handler(request, env, identity);
    if (response) return response;
  }

  throw new ApiError(404, 'NOT_FOUND', 'Recurso não encontrado');
}
