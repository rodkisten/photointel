import { notificationSettingsRoute } from './notification-settings';
import { workflowTemplateRoute } from './workflow-message';
import { workflowFailureRoute } from './workflow-failures';
import { ApiError, bodyJson, json, redact } from './auth';
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
import { PATTERNS, LIMITS, DEFAULTS, safeList } from './api-utils';
import type { Env, Identity } from './auth';
import {
  WORKFLOW_INPUTS,
  cf,
  configPath,
  digest,
  gcp,
  gcpBase,
  gh,
  logsExplorer,
  mapCloudLogs,
  readConfig,
  validateConfig,
  provider,
} from './providers';

export async function api(
  request: Request,
  env: Env,
  identity: Identity,
  reportError?: (error: unknown, provider?: string) => string | undefined,
  correlationId?: string,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;

  // Interceptações de rotas modulares
  const notificationSettingsResponse = await notificationSettingsRoute(request, env);
  if (notificationSettingsResponse) return notificationSettingsResponse;
  const templateResponse = await workflowTemplateRoute(request, env);
  if (templateResponse) return templateResponse;
  const failureResponse = await workflowFailureRoute(request, env);
  if (failureResponse) return failureResponse;

  if (path.startsWith('/api/cloudflare/')) {
    const response = await cloudflareRoute(request, env);
    if (response) return response;
  }
  if (path.startsWith('/api/deploy-router')) {
    const response = await routerApi(request, env, identity);
    if (response) return response;
  }
  if (path.startsWith('/api/infrastructure')) {
    const response = await infrastructureRoute(request, env, identity);
    if (response) return response;
  }
  if (path.startsWith('/api/costs')) {
    const response = await costRoute(request, env, identity);
    if (response) return response;
  }
  if (path.startsWith('/api/secrets')) {
    const response = await secretRoutes(request, env, identity);
    if (response) return response;
  }
  if (path.startsWith('/api/icloud/auth/')) {
    const response = await icloudAuthRoute(request, env, identity);
    if (response) return response;
  }

  // Endpoints Nativos
  if (method === 'GET' && path === '/api/meta')
    return json({
      email: identity.email,
      repo: env.GITHUB_REPO || DEFAULTS.GITHUB_REPO,
      project: env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID,
      gcp: Boolean(env.GCP_WIF_AUDIENCE),
      cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN),
      sentry: Boolean(env.SENTRY_DSN),
      sentry_reader: Boolean(env.SENTRY_API_TOKEN),
      sentry_org: env.SENTRY_ORG || null,
      cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID || null,
      gcp_region: env.GCP_REGION || DEFAULTS.REGION,
    });

  if (method === 'GET' && path === '/api/diagnostics') return json(await runManageDiagnostics(env));
  
  if (method === 'GET' && path === '/api/icloud/diagnostics') {
    return handleIcloudDiagnostics(env, identity, gcp, gh, mapCloudLogs);
  }

  if (method === 'GET' && path === '/api/overview') {
    const tasks = await Promise.allSettled([
      gh(env, '/actions/runs?per_page=12'),
      cf(env, '/workers/scripts'),
      env.GCP_WIF_AUDIENCE
        ? gcp(env, identity, gcpBase(env) + '/services?pageSize=20')
        : Promise.resolve(null),
    ]);
    const show = (i: number) => (tasks[i].status === 'fulfilled' ? tasks[i].value : null);
    const ghData = show(0),
      cfData = show(1),
      gcpData = show(2);

    const providerEvents = tasks.map((task, index) =>
      task.status === 'rejected'
        ? reportError?.(task.reason, ['github', 'cloudflare', 'gcp'][index])
        : undefined,
    );

    return json({
      provider_events: providerEvents,
      correlation_id: correlationId,
      runs: safeList(ghData, 'workflow_runs').map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        created_at: x.created_at,
        html_url: x.html_url,
        run_number: x.run_number,
      })),
      workers: safeList(cfData, 'result').map((x) => ({ name: x.id, modified_on: x.modified_on })),
      services: safeList(gcpData, 'services').map((x) => ({
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

  if (method === 'GET' && path === '/api/workflows') {
    const data = await gh(env, '/actions/workflows?per_page=100');
    return json({
      items: safeList(data, 'workflows')
        .filter((x) =>
          Object.prototype.hasOwnProperty.call(
            WORKFLOW_INPUTS,
            String(x.path || '')
              .split('/')
              .pop() || '',
          ),
        )
        .map((x) => ({
          id: x.id,
          name: x.name,
          file: String(x.path).split('/').pop(),
          state: x.state,
          html_url: x.html_url,
          inputs: WORKFLOW_INPUTS[String(x.path).split('/').pop() || ''],
        })),
    });
  }

  if (method === 'GET' && path === '/api/runs') {
    const data = await gh(env, '/actions/runs?per_page=50');
    return json({
      items: safeList(data, 'workflow_runs').map((x) => ({
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
    const data = await gh(env, '/actions/runs/' + jobs[1] + '/jobs?per_page=100');
    return json({
      items: safeList(data, 'jobs').map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        started_at: x.started_at,
        completed_at: x.completed_at,
        html_url: x.html_url,
        steps: (Array.isArray(x.steps) ? x.steps : []).map((s: any) => ({
          name: s.name,
          number: s.number,
          conclusion: s.conclusion,
          status: s.status,
        })),
      })),
    });
  }

  const jobLogs = path.match(/^\/api\/runs\/([1-9]\d*)\/jobs\/([1-9]\d*)\/logs$/);
  if (method === 'GET' && jobLogs) {
    const data = await gh(env, '/actions/runs/' + jobLogs[1] + '/jobs?per_page=100');
    if (!safeList(data, 'jobs').some((x) => String(x.id) === jobLogs[2]))
      throw new ApiError(404, 'JOB_ID', 'O job não pertence à execução');
    const repo = env.GITHUB_REPO || DEFAULTS.GITHUB_REPO;
    const response = await fetch(
      'https://api.github.com/repos/' + repo + '/actions/jobs/' + jobLogs[2] + '/logs',
      {
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_API_TOKEN },
        redirect: 'manual',
        signal: AbortSignal.timeout(LIMITS.TIMEOUT_DEFAULT),
      },
    );
    if (response.status !== 302) throw new ApiError(502, 'LOG_REDIRECT', 'Logs do job ainda não disponíveis');
    const location = response.headers.get('location') || '';
    let target: URL;
    try {
      target = new URL(location);
    } catch {
      throw new ApiError(502, 'LOG_URL', 'Endereço de logs inválido');
    }
    if (
      target.protocol !== 'https:' ||
      !(
        target.hostname.endsWith('.actions.githubusercontent.com') ||
        target.hostname.endsWith('.githubusercontent.com')
      )
    )
      throw new ApiError(502, 'LOG_HOST', 'Destino externo não permitido');
    const logResponse = await fetch(target.href, { redirect: 'manual', signal: AbortSignal.timeout(LIMITS.TIMEOUT_DEFAULT) });
    if (!logResponse.ok || Number(logResponse.headers.get('content-length') || 0) > LIMITS.LOG_MAX_BYTES)
      throw new ApiError(502, 'LOG_SIZE', 'Log não disponível ou excede 400 KB');
    const text = await logResponse.text();
    return json({ text: redact(text.slice(-LIMITS.LOG_SLICE_LENGTH)).slice(-LIMITS.LOG_FINAL_LENGTH), truncated: text.length > LIMITS.LOG_FINAL_LENGTH });
  }

  if (path === '/api/github/workflow-catalog' && method === 'GET') {
    const response = await gh(env, '/actions/workflows?per_page=100') as {
      workflows?: Array<{ name?: string; path?: string; state?: string }>;
    };
    return json({
      workflows: (response.workflows || [])
        .filter(item => item.state === 'active' && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(item.path || ''))
        .map(item => ({ name: item.name || item.path?.split('/').pop() || '', path: item.path?.split('/').pop() || '' })),
    });
  }

  // Trigger rules are stored as a versioned GitHub Environment variable.
  // This avoids adding a database and keeps rules auditable in the existing repository.
  if (path === '/api/github/variable-triggers') {
    const base = '/environments/' + encodeURIComponent(env.GITHUB_ENVIRONMENT || 'production') + '/variables';
    const key = 'MANAGE_VARIABLE_TRIGGERS';
    if (method === 'GET') {
      const result = await gh(env, base + '/' + key).catch(() => null) as { value?: string } | null;
      const raw = result?.value || '{}';
      let rules: unknown = {};
      try { rules = JSON.parse(raw); } catch { /* legacy invalid value */ }
      return json({ rules, version: await digest(raw) });
    }
    if (method === 'PUT') {
      const input = await bodyJson<{ rules?: unknown; version?: unknown; confirm?: unknown }>(request, 12000);
      if (input.confirm !== 'confirma') throw new ApiError(409, 'TRIGGER_CONFIRM', 'Digite confirma para salvar gatilhos.');
      if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules))
        throw new ApiError(422, 'TRIGGER_RULES', 'Regras inválidas.');
      const rules = input.rules as Record<string, unknown>;
      if (Object.keys(rules).length > 100) throw new ApiError(422, 'TRIGGER_LIMIT', 'Máximo de 100 regras.');
      const catalog = await gh(env, '/actions/workflows?per_page=100') as {
        workflows?: Array<{ path?: string; state?: string }>;
      };
      const allowed = new Set((catalog.workflows || []).filter(x => x.state === 'active')
        .map(x => x.path?.split('/').pop()));
      for (const [name, rule] of Object.entries(rules)) {
        if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) || name === key || name === 'GCP_CONFIG_ENV')
          throw new ApiError(422, 'TRIGGER_NAME', 'Nome de variável não autorizado.');
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new ApiError(422, 'TRIGGER_RULE', 'Regra inválida.');
        const entry = rule as { mode?: unknown; workflows?: unknown; webhook?: unknown };
        if (!['none', 'workflows', 'webhook'].includes(String(entry.mode))) throw new ApiError(422, 'TRIGGER_MODE', 'Modo inválido.');
        if (entry.mode === 'workflows' && (!Array.isArray(entry.workflows) || entry.workflows.length > 10 ||
          entry.workflows.some(x => typeof x !== 'string' || !allowed.has(x))))
          throw new ApiError(422, 'TRIGGER_WORKFLOWS', 'Selecione até dez workflows ativos.');
        if (entry.mode === 'webhook' && (typeof entry.webhook !== 'string' ||
          !/^https:\/\/[a-z0-9.-]+(?:\/[a-zA-Z0-9/_-]*)?$/.test(entry.webhook) ||
          !entry.webhook.startsWith('https://relay.migos.club/')))
          throw new ApiError(422, 'TRIGGER_WEBHOOK', 'Somente webhooks HTTPS do Relay autorizado são permitidos.');
      }
      const current = await gh(env, base + '/' + key).catch(() => null) as { value?: string } | null;
      const raw = current?.value || '{}';
      if (input.version !== await digest(raw)) throw new ApiError(409, 'TRIGGER_CONFLICT', 'Regras alteradas; recarregue.');
      const next = JSON.stringify(rules);
      await gh(env, current ? base + '/' + key : base, current ? 'PATCH' : 'POST', { name: key, value: next });
      return json({ ok: true, version: await digest(next) });
    }
  }

  if (path === '/api/github/variables') {
    const scope = url.searchParams.get('scope') || 'environment';
    if (scope !== 'environment' && scope !== 'repository')
      throw new ApiError(422, 'VARIABLE_SCOPE', 'Escolha repositório ou environment');
    const base =
      scope === 'repository'
        ? '/actions/variables'
        : '/environments/' + encodeURIComponent(env.GITHUB_ENVIRONMENT || 'production') + '/variables';
    if (method === 'GET') {
      const data = await gh(env, base + '?per_page=100');
      return json({
        scope,
        items: await Promise.all(
          safeList(data, 'variables').map(async (entry) => ({
            name: entry.name,
            value: entry.name === 'GCP_CONFIG_ENV' ? null : entry.value,
            version: await digest(String(entry.value || '')),
            updated_at: entry.updated_at,
          })),
        ),
      });
    }
    if (method === 'PUT') {
      const input = await bodyJson<{ name?: unknown; value?: unknown; version?: unknown; confirm?: unknown }>(request, 130_000);
      const name = input.name;
      const value = input.value;
      if (
        typeof name !== 'string' ||
        !PATTERNS.VARIABLE_NAME.test(name) ||
        name === 'GCP_CONFIG_ENV' ||
        typeof value !== 'string' ||
        value.length > LIMITS.CONFIG_MAX_LENGTH ||
        value.includes('\0') ||
        PATTERNS.SECRET_SENSITIVE.test(value)
      )
        throw new ApiError(
          422,
          'VARIABLE_VALUE',
          'Nome ou valor inválido; use Secret Manager para credenciais',
        );
      // Only this explicit Manage setting may auto-dispatch from the generic variable editor.
      // All other variables retain manual review, avoiding unexpected billable deploys.
      const deployManage = name === 'GCP_COST_ALERT_USD';
      if (deployManage) {
        if (scope !== 'environment') throw new ApiError(422, 'VARIABLE_SCOPE', 'Limite GCP deve ficar no environment production.');
        if (!/^\\d+(?:\\.\\d{1,2})?$/.test(value) || Number(value) <= 0 || Number(value) > 100000)
          throw new ApiError(422, 'COST_ALERT', 'Informe limite positivo em USD, até 100000.');
        if (input.confirm !== 'confirma')
          throw new ApiError(409, 'VARIABLE_CONFIRM', 'Atenção: mudar esta variável acionará Manage Deploy. Digite confirma.');
      }
      const triggerStore = '/environments/' + encodeURIComponent(env.GITHUB_ENVIRONMENT || 'production') + '/variables/MANAGE_VARIABLE_TRIGGERS';
      const stored = await gh(env, triggerStore).catch(() => null) as { value?: string } | null;
      let rule: { mode?: string; workflows?: string[]; webhook?: string } = {};
      try { rule = (JSON.parse(stored?.value || '{}') as Record<string, typeof rule>)[name] || {}; }
      catch { /* invalid legacy rule is ignored */ }
      const hasRule = rule.mode === 'workflows' && !!rule.workflows?.length ||
        rule.mode === 'webhook' && !!rule.webhook;
      // GCP_ENV_VARS is a high-impact configuration variable. Require confirmation
      // even without trigger rules; never dispatch unconfigured workflows.
      if (name === 'GCP_ENV_VARS' && input.confirm !== 'confirma')
        throw new ApiError(409, 'VARIABLE_CONFIRM', 'ATENÇÃO: GCP_ENV_VARS pode alterar serviços de produção. Revise os gatilhos e digite confirma.');
      if (hasRule && input.confirm !== 'confirma')
        throw new ApiError(409, 'VARIABLE_CONFIRM', 'Atenção: alterar esta variável acionará gatilhos. Digite confirma.');
      const existing = await gh(env, base + '?per_page=100');
      const match = safeList(existing, 'variables').find((entry) => entry.name === name);
      if (match) {
        if (typeof input.version !== 'string' || input.version !== (await digest(String(match.value || ''))))
          throw new ApiError(409, 'VARIABLE_CONFLICT', 'A variável foi alterada; recarregue antes de salvar');
        await gh(env, base + '/' + encodeURIComponent(name), 'PATCH', { name, value });
      } else {
        if (input.version !== null)
          throw new ApiError(409, 'VARIABLE_CONFLICT', 'Nova variável exige versão vazia');
        await gh(env, base, 'POST', { name, value });
      }
      console.log(
        JSON.stringify({ event: 'github_variable_updated', name, scope, operator: identity.email }),
      );
      let dispatch: 'queued' | 'failed' | 'none' = 'none';
      if (deployManage) {
        try {
          await gh(env, '/actions/workflows/manage-deploy.yml/dispatches', 'POST', {
            ref: 'main', inputs: { mode: 'apply' },
          });
          dispatch = 'queued';
        } catch {
          dispatch = 'failed';
        }
      }
      const triggered: Array<{ target: string; status: 'queued' | 'failed' }> = [];
      if (hasRule) {
        const catalog = await gh(env, '/actions/workflows?per_page=100') as {
          workflows?: Array<{ path?: string; state?: string }>;
        };
        const allowed = new Set((catalog.workflows || []).filter(x => x.state === 'active')
          .map(x => x.path?.split('/').pop()));
        if (rule.mode === 'workflows') {
          for (const workflow of (rule.workflows || []).slice(0, 10)) {
            if (!allowed.has(workflow)) continue;
            try {
              await gh(env, '/actions/workflows/' + encodeURIComponent(workflow) + '/dispatches', 'POST',
                { ref: 'main' });
              triggered.push({ target: workflow, status: 'queued' });
            } catch {
              triggered.push({ target: workflow, status: 'failed' });
            }
          }
        } else if (rule.mode === 'webhook' && rule.webhook?.startsWith('https://relay.migos.club/')) {
          // Never transmit variable values, secrets or user-controlled Authorization headers.
          try {
            const response = await fetch(rule.webhook, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: 'variable.changed', name, scope }),
              redirect: 'error', signal: AbortSignal.timeout(8000),
            });
            triggered.push({ target: 'Relay webhook', status: response.ok ? 'queued' : 'failed' });
          } catch { triggered.push({ target: 'Relay webhook', status: 'failed' }); }
        }
      }
      return json({ ok: true, version: await digest(value), dispatch, triggered });
    }
  }

  if (method === 'POST' && path === '/api/config/preview') {
    const input = await bodyJson<{ value?: unknown }>(request, 130_000);
    if (typeof input.value !== 'string' || !input.value || input.value.length > LIMITS.CONFIG_MAX_LENGTH)
      throw new ApiError(422, 'CONFIG_PREVIEW_INPUT', 'Informe um .env válido de até 120 KB');
    const origin = env.PHOTOINTEL_API_ORIGIN;
    if (!origin || !/^https:\/\/[^/?#]+$/.test(origin))
      throw new ApiError(503, 'CONFIG_PREVIEW_ORIGIN', 'Configure PHOTOINTEL_API_ORIGIN no Worker Manage');
    const upstream = await fetch(origin + '/v1/manage/config/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cf-Access-Jwt-Assertion': identity.jwt,
      },
      body: JSON.stringify({ value: input.value }),
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.TIMEOUT_PREVIEW),
    });
    if (!upstream.ok)
      throw new ApiError(502, 'CONFIG_PREVIEW_UPSTREAM', 'Prévia Python indisponível (HTTP ' + upstream.status + ')');
    if (Number(upstream.headers.get('content-length') || 0) > 150_000)
      throw new ApiError(502, 'CONFIG_PREVIEW_SIZE', 'Prévia excedeu o limite');
    const payload = await upstream.text();
    if (payload.length > 150_000)
      throw new ApiError(502, 'CONFIG_PREVIEW_SIZE', 'Prévia excedeu o limite');
    return json(JSON.parse(payload));
  }

  if (method === 'GET' && path === '/api/config') return json(await readConfig(env));
  
  if (method === 'PUT' && path === '/api/config') {
    const input = await bodyJson<{ value?: unknown; version?: unknown; auto_apply?: unknown; confirm?: unknown }>(request);
    if (
      typeof input.value !== 'string' ||
      typeof input.version !== 'string' ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean')
    )
      throw new ApiError(422, 'CONFIG_FIELDS', 'Informe value, version e auto_apply booleano');
    if (input.auto_apply !== false && input.confirm !== 'confirma') throw new ApiError(409, 'CONFIG_CONFIRM', 'Digite confirma para autorizar workflows.');
    validateConfig(input.value);
    const current = await readConfig(env);
    if (input.version !== current.version)
      throw new ApiError(409, 'CONFIG_CONFLICT', 'Configuração alterada em outra sessão: recarregue');
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
    if (plan.changed.length === 0) {
      if (current.value !== input.value)
        await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: input.value });
      return json({ ok: true, version, updated_at: new Date().toISOString(), plan, dispatches: [] });
    }
    await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: input.value });
    const dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }> = [];
    const requiresAdmin = plan.blocked;
    if (input.auto_apply !== false && !requiresAdmin) {
      for (const workflow of plan.workflows) {
        try {
          await gh(env, '/actions/workflows/' + workflow.file + '/dispatches', 'POST', {
            ref: 'main',
            inputs:
              workflow.file === 'config-sync.yml'
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

  if (method === 'POST' && path === '/api/dispatch') {
    const input = await bodyJson<{ workflow?: string; inputs?: Record<string, string>; confirm?: string }>(
      request,
      12_000,
    );
    const spec = input.workflow ? WORKFLOW_INPUTS[input.workflow] : undefined;
    if (!spec) throw new ApiError(422, 'WORKFLOW', 'Workflow não autorizado');
    if (input.confirm !== 'DEPLOY ' + input.workflow)
      throw new ApiError(409, 'CONFIRM', 'Confirmação de execução necessária');
    const inputs = input.inputs || {};
    if (
      !inputs ||
      typeof inputs !== 'object' ||
      Array.isArray(inputs) ||
      Object.entries(inputs).some(
        ([key, value]) =>
          !(key in spec) ||
          typeof value !== 'string' ||
          value.length > 1000 ||
          (spec[key].length > 0 && !spec[key].includes(value)),
      )
    )
      throw new ApiError(422, 'INPUTS', 'Input inválido ou não autorizado');
    const result = await gh(env, '/actions/workflows/' + input.workflow + '/dispatches', 'POST', {
      ref: 'main',
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
    const input = await bodyJson<{ confirm?: string }>(request, 1000);
    if (input.confirm !== 'RETRY ' + rerun[1])
      throw new ApiError(409, 'CONFIRM', 'Confirmação de retentativa necessária');
    const result = await gh(env, '/actions/runs/' + rerun[1] + '/rerun-failed-jobs', 'POST');
    console.log(JSON.stringify({ event: 'manage_rerun', run: rerun[1], operator: identity.email }));
    return json({ ok: true, result }, 202);
  }

  if (method === 'GET' && path === '/api/cloudflare/workers') {
    const [scripts, domains] = await Promise.all([cf(env, '/workers/scripts'), cf(env, '/workers/domains')]);
    return json({
      items: safeList(scripts, 'result').map((x) => ({
        name: x.id,
        modified_on: x.modified_on,
      })),
      domains: safeList(domains, 'result').map((x) => ({
        hostname: x.hostname,
        service: x.service,
      })),
    });
  }

  if (method === 'GET' && path === '/api/cloudflare/logs') {
    const investigation = parseLogRequest(url.searchParams);
    const search = investigation.terms[0] || investigation.entry || '';
    const data = await cf(env, '/workers/observability/telemetry/query', 'POST', {
      queryId: 'photointel-manage-logs',
      view: 'events',
      dry: true,
      timeframe: { from: investigation.start, to: investigation.end },
      limit: search ? 100 : 70,
      order: 'desc',
      parameters: {
        datasets: ['cloudflare-workers'],
        ...(search ? { needle: { value: search, matchCase: false } } : {}),
      },
    });
    const result = (data as { result?: Record<string, unknown> }).result;
    const events = safeList(result?.events, 'events');
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
        message: redact(x.source ?? x.$metadata?.message ?? x.$metadata?.error ?? '').slice(0, 10000),
      })),
    });
  }

  // Proxy the existing durable Photos queue controller. The Photos API independently
  // verifies the signed Manage Access JWT and admin allowlist; no bypass token.
  if (path === '/api/photos/jobs/control' &&
      (method === 'GET' || method === 'POST')) {
    const origin = env.PHOTOINTEL_API_ORIGIN;
    if (!origin || !/^https:\/\/[^/?#]+$/.test(origin))
      throw new ApiError(503, 'PHOTOS_CONTROL_ORIGIN', 'Configure PHOTOINTEL_API_ORIGIN');
    let upstreamPath = '/v1/manage/jobs/control';
    if (method === 'POST') {
      const input = await bodyJson<{ action?: unknown; confirm?: unknown }>(request);
      if ((input.action !== 'pause' && input.action !== 'resume') ||
          input.confirm !== input.action)
        throw new ApiError(422, 'PHOTOS_CONTROL', 'Confirme pausa ou retomada da fila');
      upstreamPath += '/' + input.action;
    }
    const response = await fetch(origin + upstreamPath, {
      method,
      headers: { 'Cf-Access-Jwt-Assertion': identity.jwt, 'Accept': 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.TIMEOUT_DEFAULT),
    });
    if (!response.ok)
      throw new ApiError(502, 'PHOTOS_CONTROL_UPSTREAM', 'Photos recusou a operação (HTTP ' + response.status + ')');
    if (Number(response.headers.get('content-length') || 0) > 30000)
      throw new ApiError(502, 'PHOTOS_CONTROL_SIZE', 'Resposta excedeu o limite');
    const payload = await response.text();
    if (payload.length > 30000) throw new ApiError(502, 'PHOTOS_CONTROL_SIZE', 'Resposta excedeu o limite');
    try { return json(JSON.parse(payload)); }
    catch { throw new ApiError(502, 'PHOTOS_CONTROL_JSON', 'Resposta inválida do Photos'); }
  }

  // Updating Cloudflare cron triggers changes only the selected PhotoIntel Worker.
  // The caller must confirm its exact name; no arbitrary account script paths.
  if (method === 'POST' && path === '/api/cloudflare/worker-crons') {
    const input = await bodyJson<{ name?: unknown; crons?: unknown; confirm?: unknown }>(request);
    const { name, crons, confirm } = input;
    if (typeof name !== 'string' || !/^photointel(?:-[a-z0-9-]+)?$/.test(name) ||
        name.length > 70 || confirm !== name || !Array.isArray(crons) ||
        crons.length > 10 || !crons.every(cron =>
          typeof cron === 'string' && cron.length <= 100 &&
          /^[0-9*,\/ -]+$/.test(cron) && cron.trim().split(/\s+/).length === 5)) {
      throw new ApiError(422, 'WORKER_CRON', 'Confirme o Worker e informe crons válidos (UTC, cinco campos)');
    }
    const normalized = [...new Set((crons as string[]).map(cron => cron.trim().replace(/\s+/g, ' ')))];
    // Empty array intentionally disables all cron triggers. UI requires explicit confirmation.
    const updated = await cf(env, '/workers/scripts/' + encodeURIComponent(name) + '/schedules', 'PUT', normalized.map(cron => ({ cron })));
    return json({ name, schedules: normalized, updated: Boolean(updated) });
  }

  // Read-only Cloudflare cron inventory. Never expose account-wide script secrets.
  if (method === 'GET' && path === '/api/cloudflare/worker-crons') {
    const scripts = await cf(env, '/workers/scripts') as { result?: Array<{ id?: string }> };
    const names = safeList(scripts, 'result')
      .map(x => String(x.id || '')).filter(name => /^photointel(?:-[a-z0-9-]+)?$/.test(name)).slice(0, 30);
    const items = await Promise.all(names.map(async name => {
      try {
        const response = await cf(env, '/workers/scripts/' + encodeURIComponent(name) + '/schedules') as {
          result?: { schedules?: Array<{ cron?: string; created_on?: string; modified_on?: string }> } | Array<{ cron?: string }>;
        };
        const result = response.result;
        const schedules = Array.isArray(result) ? result : result?.schedules || [];
        return { name, schedules: schedules.map(x => ({ cron: x.cron || '' })) };
      } catch {
        return { name, schedules: [], error: 'Não foi possível consultar os crons deste Worker' };
      }
    }));
    return json({ items });
  }

  if (method === 'GET' && path === '/api/gcp/telegram') {
    const service = (await gcp(env, identity, gcpBase(env) + '/services/photointel-api')) as {
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
    const endpoint = /^https:\/\//.test(byName.get('TELEGRAM_NOTIFICATION_URL')?.value || '');
    const destination = Boolean(byName.get('TELEGRAM_NOTIFICATION_CHAT_ID')?.value);
    const token = byName.get('TELEGRAM_NOTIFICATION_API_TOKEN');
    const tokenBound = Boolean(
      (typeof token?.value === 'string' && token.value.length > 0) ||
        token?.valueSource?.secretKeyRef ||
        token?.valueFrom?.secretKeyRef,
    );
    return json({
      enabled,
      endpointConfigured: endpoint,
      destinationConfigured: destination,
      tokenBound,
      ready: enabled && endpoint && destination && tokenBound,
      explanation:
        enabled && endpoint && destination && tokenBound
          ? 'Configuração Cloud Run presente; verifique o Relay e as entregas reais para confirmar o envio.'
          : 'Telegram não está completamente configurado na revisão do Cloud Run; confira GCP_CONFIG_ENV (token direto ou referência Secret Manager).',
    });
  }

  if (method === 'GET' && path === '/api/gcp/services') {
    const data = await gcp(env, identity, gcpBase(env) + '/services?pageSize=40');
    return json({
      items: safeList(data, 'services').map((x) => ({
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
    const data = await gcp(env, identity, gcpBase(env) + '/jobs?pageSize=60');
    return json({
      items: safeList(data, 'jobs').map((x) => ({
        name: x.name,
        updateTime: x.updateTime,
        latestCreatedExecution: x.latestCreatedExecution?.name,
        executionCount: x.executionCount,
      })),
    });
  }

  if (method === 'GET' && path === '/api/gcp/executions') {
    const name = url.searchParams.get('job') || '';
    if (!PATTERNS.GCP_JOB_NAME.test(name))
      throw new ApiError(422, 'GCP_JOB', 'Selecione um job PhotoIntel válido');
    const data = await gcp(
      env,
      identity,
      gcpBase(env) + '/jobs/' + encodeURIComponent(name) + '/executions?pageSize=30',
    );
    return json({
      job: name,
      items: safeList(data, 'executions').map((x) => ({
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

  // Cancellation is scoped to an existing PhotoIntel Cloud Run execution.
  // Never accept a caller-supplied project, region or arbitrary resource path.
  if (method === 'POST' && path === '/api/gcp/executions/cancel') {
    const input = await bodyJson<{ job?: unknown; execution?: unknown; confirm?: unknown }>(request);
    const { job, execution, confirm } = input;
    if (typeof job !== 'string' || !PATTERNS.GCP_JOB_NAME.test(job) ||
        typeof execution !== 'string' || !/^photointel-[a-z0-9-]{1,110}$/.test(execution) ||
        confirm !== execution) {
      throw new ApiError(422, 'EXECUTION_CANCEL', 'Confirme a execução PhotoIntel válida');
    }
    const base = gcpBase(env);
    const resource = base + '/jobs/' + encodeURIComponent(job) + '/executions/' + encodeURIComponent(execution);
    const existing = await gcp(env, identity, resource) as {
      name?: string; completionTime?: string; conditions?: Array<{ type?: string; state?: string }>;
    };
    if (existing.name?.split('/').pop() !== execution ||
        existing.name?.split('/').slice(-3, -2)[0] !== job) {
      throw new ApiError(409, 'EXECUTION_SCOPE', 'Execução fora do job permitido');
    }
    if (existing.completionTime) return json({ name: existing.name, unchanged: true, completed: true });
    const updated = await gcp(env, identity, resource + ':cancel', {}) as { name?: string };
    return json({ name: updated.name || existing.name, cancellationRequested: true });
  }

  // Only authenticated Manage operators may pause/resume scoped PhotoIntel schedules.
  // Never accept arbitrary GCP resource paths from the browser.
  if (method === 'POST' && path === '/api/gcp/scheduler/control') {
    const input = await bodyJson(request) as { name?: unknown; action?: unknown; confirm?: unknown };
    const name = input.name;
    const action = input.action;
    if (typeof name !== 'string' || !/^photointel-[a-z0-9-]{1,55}$/.test(name) ||
        (action !== 'pause' && action !== 'resume') || input.confirm !== name) {
      throw new ApiError(422, 'SCHEDULER_CONTROL', 'Confirme o nome do agendamento PhotoIntel');
    }
    const project = env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID;
    const region = env.GCP_REGION || DEFAULTS.REGION;
    // gcpBase enforces the project/region allowlist before using Cloud Scheduler.
    gcpBase(env);
    const base = 'https://cloudscheduler.googleapis.com/v1/projects/' + project +
      '/locations/' + region + '/jobs/' + name;
    const existing = await gcp(env, identity, base) as { name?: string; state?: string };
    if (existing.name !== 'projects/' + project + '/locations/' + region + '/jobs/' + name) {
      throw new ApiError(409, 'SCHEDULER_SCOPE', 'Agendamento fora do projeto permitido');
    }
    if ((action === 'pause' && existing.state === 'PAUSED') ||
        (action === 'resume' && existing.state === 'ENABLED')) {
      return json({ name: existing.name, state: existing.state, unchanged: true });
    }
    const updated = await gcp(env, identity, base + ':' + action, {}) as { name?: string; state?: string };
    return json({ name: updated.name, state: updated.state, unchanged: false });
  }

  // Edit the recurrence without enabling a paused job. Only simple five-field
  // cron expressions are accepted; this endpoint never runs a job immediately.
  if (method === 'POST' && path === '/api/gcp/scheduler/schedule') {
    const input = await bodyJson<{ name?: unknown; schedule?: unknown; confirm?: unknown }>(request);
    const { name, schedule, confirm } = input;
    if (typeof name !== 'string' || !/^photointel-[a-z0-9-]{1,55}$/.test(name) ||
        typeof schedule !== 'string' || schedule.length > 100 ||
        !/^[0-9*,\/ -]+$/.test(schedule) || schedule.trim().split(/\s+/).length !== 5 ||
        confirm !== name) {
      throw new ApiError(422, 'SCHEDULER_SCHEDULE', 'Confirme o job e informe um cron de cinco campos');
    }
    const project = env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID;
    const region = env.GCP_REGION || DEFAULTS.REGION;
    gcpBase(env);
    const resource = 'projects/' + project + '/locations/' + region + '/jobs/' + name;
    const endpoint = 'https://cloudscheduler.googleapis.com/v1/' + resource;
    const existing = await gcp(env, identity, endpoint) as { name?: string; state?: string; schedule?: string };
    if (existing.name !== resource) throw new ApiError(409, 'SCHEDULER_SCOPE', 'Agendamento fora do projeto permitido');
    if (existing.schedule === schedule) return json({ name, schedule, state: existing.state, unchanged: true });
    // Use the existing authenticated WIF token; PATCH is intentionally scoped
    // to schedule only, preserving target, credentials and PAUSED/ENABLED state.
    const { gcpToken } = await import('./providers');
    const token = await gcpToken(env, identity);
    const updated = await provider(endpoint + '?updateMask=schedule', token, {
      method: 'PATCH', body: JSON.stringify({ schedule }),
    }) as { schedule?: string; state?: string };
    return json({ name, schedule: updated.schedule, state: updated.state, unchanged: false });
  }

  if (method === 'GET' && path === '/api/gcp/scheduler') {
    const project = env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID;
    const region = env.GCP_REGION || DEFAULTS.REGION;
    const data = await gcp(
      env,
      identity,
      'https://cloudscheduler.googleapis.com/v1/projects/' +
        project +
        '/locations/' +
        region +
        '/jobs?pageSize=60',
    );
    return json({
      items: safeList(data, 'jobs')
        .filter((x) => (String(x.name).split('/').pop() || '').startsWith('photointel-'))
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
    const project = env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID;
    const data = await gcp(env, identity, 'https://logging.googleapis.com/v2/entries:list', {
      resourceNames: ['projects/' + project],
      filter: gcpLogFilter(investigation),
      orderBy: 'timestamp desc',
      pageSize: 500,
    });
    return json({
      items: mapCloudLogs((data as { entries?: unknown }).entries),
      console_url: investigation.terms.length
        ? logsExplorer(env, investigation.terms[0])
        : 'https://console.cloud.google.com/logs/query?project=' + project,
    });
  }

  if (method === 'GET' && path === '/api/sentry/issues') {
    if (!env.SENTRY_ORG) return json({ items: [], read_enabled: false, dashboard_url: null });
    if (!PATTERNS.SENTRY_ORG.test(env.SENTRY_ORG))
      throw new ApiError(503, 'SENTRY_ORG', 'Organização inválida');
    const dashboardUrl = 'https://' + env.SENTRY_ORG + '.sentry.io/issues/';
    if (!env.SENTRY_API_TOKEN) return json({ items: [], read_enabled: false, dashboard_url: dashboardUrl });
    const items = await provider(
      'https://sentry.io/api/0/organizations/' +
        env.SENTRY_ORG +
        '/issues/?query=is%3Aunresolved&sort=date&limit=100',
      env.SENTRY_API_TOKEN,
    );
    return json({
      read_enabled: true,
      dashboard_url: dashboardUrl,
      items: (Array.isArray(items) ? items : []).map((x: any) => ({
        id: x.id,
        title: redact(x.title).slice(0, 180),
        level: x.level,
        count: x.count,
        lastSeen: x.lastSeen,
        permalink: x.permalink,
        culprit: redact(x.culprit).slice(0, 140),
        project: x.project?.slug,
      })),
    });
  }

  throw new ApiError(404, 'NOT_FOUND', 'Recurso não encontrado');
}
