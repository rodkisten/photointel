import { ApiError, bodyJson, json, redact } from './auth';
import { planConfigChange } from './config-reconcile';
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

const ID = /^[1-9][0-9]{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Item = { [key: string]: any };
function list(data: unknown, key: string): Item[] {
  const v = data as Record<string, unknown>;
  return Array.isArray(v?.[key]) ? (v[key] as Item[]) : [];
}
export async function api(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (method === 'GET' && path === '/api/meta')
    return json({
      email: identity.email,
      repo: env.GITHUB_REPO || 'rodkisten/photointel',
      project: env.GCP_PROJECT_ID || 'photointel',
      gcp: Boolean(env.GCP_WIF_AUDIENCE),
      cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN),
      sentry: Boolean(env.SENTRY_API_TOKEN),
    });
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
    return json({
      runs: list(ghData, 'workflow_runs').map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        created_at: x.created_at,
        html_url: x.html_url,
        run_number: x.run_number,
      })),
      workers: list(cfData, 'result').map((x) => ({ name: x.id, modified_on: x.modified_on })),
      services: list(gcpData, 'services').map((x) => ({
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
      items: list(data, 'workflows')
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
      items: list(data, 'workflow_runs').map((x) => ({
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
      items: list(data, 'jobs').map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        conclusion: x.conclusion,
        started_at: x.started_at,
        completed_at: x.completed_at,
        html_url: x.html_url,
        steps: (Array.isArray(x.steps) ? x.steps : []).map((s: Item) => ({
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
    if (!list(data, 'jobs').some((x) => String(x.id) === jobLogs[2]))
      throw new ApiError(404, 'JOB_ID', 'O job não pertence à execução');
    const repo = env.GITHUB_REPO || 'rodkisten/photointel';
    const response = await fetch(
      'https://api.github.com/repos/' + repo + '/actions/jobs/' + jobLogs[2] + '/logs',
      {
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_API_TOKEN },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
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
    const logResponse = await fetch(target.href, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!logResponse.ok || Number(logResponse.headers.get('content-length') || 0) > 400_000)
      throw new ApiError(502, 'LOG_SIZE', 'Log não disponível ou excede 400 KB');
    const text = await logResponse.text();
    return json({ text: redact(text.slice(-100_000)).slice(-65_000), truncated: text.length > 65_000 });
  }
  if (method === 'GET' && path === '/api/config') return json(await readConfig(env));
  if (method === 'PUT' && path === '/api/config') {
    const input = await bodyJson<{ value?: unknown; version?: unknown; auto_apply?: unknown }>(request);
    if (
      typeof input.value !== 'string' ||
      typeof input.version !== 'string' ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean')
    )
      throw new ApiError(422, 'CONFIG_FIELDS', 'Informe value, version e auto_apply booleano');
    validateConfig(input.value);
    const current = await readConfig(env);
    if (input.version !== current.version)
      throw new ApiError(409, 'CONFIG_CONFLICT', 'Configuração alterada em outra sessão: recarregue');
    let plan;
    try {
      plan = planConfigChange(current.value, input.value);
    } catch {
      throw new ApiError(422, 'CONFIG_DIFF', 'Não foi possível interpretar o .env para determinar os workflows. Revise a sintaxe.');
    }
    const version = await digest(input.value);
    if (plan.changed.length === 0) {
      // Formatting-only edits still save, but never spend compute on no-op runs.
      if (current.value !== input.value)
        await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: input.value });
      return json({ ok: true, version, updated_at: new Date().toISOString(), plan, dispatches: [] });
    }
    await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: input.value });
    const dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }> = [];
    // Structural IAM/identity changes must not be published before administrator approval.
    const requiresAdmin = plan.blocked;
    if (input.auto_apply !== false && !requiresAdmin) {
      for (const workflow of plan.workflows) {
        try {
          await gh(env, '/actions/workflows/' + workflow.file + '/dispatches', 'POST', {
            ref: 'main',
            inputs: workflow.file === 'config-sync.yml'
              ? { ...workflow.inputs, config_version: version }
              : workflow.inputs,
          });
          dispatches.push({ file: workflow.file, label: workflow.label, status: 'queued' });
        } catch (error) {
          // Saving the variable already succeeded. Never claim that deployment succeeded.
          dispatches.push({
            file: workflow.file,
            label: workflow.label,
            status: 'failed',
            error: error instanceof ApiError ? error.message : 'Não foi possível iniciar o workflow.',
          });
        }
      }
    }
    console.log(JSON.stringify({
      event: 'manage_config_updated',
      operator: identity.email,
      changed_keys: plan.changed.length,
      auto_apply: input.auto_apply !== false,
      dispatched: dispatches.map((item) => ({ file: item.file, status: item.status })),
      requires_admin: requiresAdmin,
    }));
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
      items: list(scripts, 'result').map((x) => ({
        name: x.id,
        modified_on: x.modified_on,
      })),
      domains: list(domains, 'result').map((x) => ({
        hostname: x.hostname,
        service: x.service,
      })),
    });
  }
  if (method === 'GET' && path === '/api/cloudflare/logs') {
    const search = (url.searchParams.get('search') || '').slice(0, 80).trim();
    const minutes = Math.min(240, Math.max(5, Number(url.searchParams.get('minutes') || 30)));
    if (!Number.isFinite(minutes)) throw new ApiError(422, 'MINUTES', 'Período inválido');
    const now = Date.now();
    // Cloudflare Observability query uses a top-level queryId and nested
    // parameters (not a top-level datasets/needle/orderBy structure).
    const data = await cf(env, '/workers/observability/telemetry/query', 'POST', {
      queryId: 'photointel-manage-logs',
      view: 'events',
      dry: true,
      timeframe: { from: now - minutes * 60_000, to: now },
      limit: 50,
      order: 'desc',
      parameters: {
        datasets: ['cloudflare-workers'],
        ...(search
          ? {
              filters: [
                {
                  key: '$metadata.message',
                  operation: 'includes',
                  type: 'string',
                  value: search,
                },
              ],
            }
          : {}),
      },
    });
    const result = (data as { result?: Record<string, unknown> }).result;
    const events = list(result?.events, 'events');
    return json({
      items: events.map((x) => ({
        id: x.$metadata?.id,
        timestamp: x.timestamp,
        service: x.$metadata?.service || x.$workers?.scriptName,
        severity: x.$metadata?.level || '',
        outcome: x.$workers?.outcome || '',
        message: redact(x.source ?? x.$metadata?.message ?? x.$metadata?.error ?? '').slice(0, 10000),
      })),
    });
  }
  if (method === 'GET' && path === '/api/gcp/telegram') {
    // Inspect Cloud Run env metadata only. Never access or return token values,
    // chat destination, secret resource IDs or original URLs.
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
    // Never return a token, only whether it is present in the deployed env.
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
      items: list(data, 'services').map((x) => ({
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
      items: list(data, 'jobs').map((x) => ({
        name: x.name,
        updateTime: x.updateTime,
        latestCreatedExecution: x.latestCreatedExecution?.name,
        executionCount: x.executionCount,
      })),
    });
  }
  if (method === 'GET' && path === '/api/gcp/executions') {
    const name = url.searchParams.get('job') || '';
    if (!/^photointel-[a-z0-9-]{1,48}$/.test(name))
      throw new ApiError(422, 'GCP_JOB', 'Selecione um job PhotoIntel válido');
    const data = await gcp(
      env,
      identity,
      gcpBase(env) + '/jobs/' + encodeURIComponent(name) + '/executions?pageSize=30',
    );
    return json({
      job: name,
      items: list(data, 'executions').map((x) => ({
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
  if (method === 'GET' && path === '/api/gcp/scheduler') {
    const project = env.GCP_PROJECT_ID || 'photointel';
    const region = env.GCP_REGION || 'us-central1';
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
      items: list(data, 'jobs')
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
    const correlation = (url.searchParams.get('correlation') || '').trim();
    if (correlation && !UUID.test(correlation))
      throw new ApiError(422, 'CORRELATION', 'Correlation ID precisa ser UUID');
    const minutes = Math.min(240, Math.max(5, Number(url.searchParams.get('minutes') || 30)));
    if (!Number.isFinite(minutes)) throw new ApiError(422, 'MINUTES', 'Período inválido');
    const after = new Date(Date.now() - minutes * 60_000).toISOString();
    const filter =
      '(resource.type="cloud_run_job" OR resource.type="cloud_run_revision") AND timestamp>="' +
      after +
      '"' +
      (correlation ? ' AND SEARCH("' + correlation + '")' : ' AND severity>=WARNING');
    const project = env.GCP_PROJECT_ID || 'photointel';
    const data = await gcp(env, identity, 'https://logging.googleapis.com/v2/entries:list', {
      resourceNames: ['projects/' + project],
      filter,
      orderBy: 'timestamp desc',
      pageSize: 60,
    });
    return json({
      items: mapCloudLogs((data as { entries?: unknown }).entries),
      console_url: correlation
        ? logsExplorer(env, correlation)
        : 'https://console.cloud.google.com/logs/query?project=' + project,
    });
  }
  if (method === 'GET' && path === '/api/sentry/issues') {
    if (!env.SENTRY_ORG || !env.SENTRY_API_TOKEN)
      throw new ApiError(503, 'SENTRY', 'Configure SENTRY_ORG e SENTRY_API_TOKEN');
    if (!/^[a-z0-9-]{1,64}$/.test(env.SENTRY_ORG))
      throw new ApiError(503, 'SENTRY_ORG', 'Organização inválida');
    const items = await provider(
      'https://sentry.io/api/0/organizations/' +
        env.SENTRY_ORG +
        '/issues/?query=is%3Aunresolved&sort=date&limit=30',
      env.SENTRY_API_TOKEN,
    );
    return json({
      items: (Array.isArray(items) ? items : []).map((x) => ({
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
