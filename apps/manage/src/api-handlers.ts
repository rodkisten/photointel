import { ApiError, json, redact } from './auth';
import { PATTERNS, LIMITS, DEFAULTS, safeList, sanitizeLog } from './api-utils';
import { gcpBase, provider, digest } from './providers';

export async function handleIcloudDiagnostics(env: any, identity: any, gcp: Function, gh: Function, mapCloudLogs: Function) {
  const project = env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID;
  const [cloud, runs] = await Promise.allSettled([
    gcp(env, identity, 'https://logging.googleapis.com/v2/entries:list', {
      resourceNames: ['projects/' + project],
      filter:
        '(resource.type="cloud_run_job" OR resource.type="cloud_run_revision") ' +
        'AND timestamp>="' +
        new Date(Date.now() - 86400_000).toISOString() +
        '" ' +
        'AND (SEARCH("icloud") OR SEARCH("apple") OR SEARCH("auth_expired"))',
      orderBy: 'timestamp desc',
      pageSize: 30,
    }),
    gh(env, '/actions/workflows/icloud-setup.yml/runs?per_page=5'),
  ]);

  const events = cloud.status === 'fulfilled' ? mapCloudLogs((cloud.value as { entries?: unknown }).entries) : [];
  const sanitized = events.map((event: any) => ({
    timestamp: event.timestamp,
    service: event.service,
    severity: event.severity,
    message: sanitizeLog(event.message, 450),
  }));

  const suspected = sanitized.some((item: any) =>
    /ICLOUD_AUTH_EXPIRED|2fa|session.expired|authentication.failed|reauth/i.test(String(item.message)),
  );

  return json({
    checked_at: new Date().toISOString(),
    configuration: { project, region: env.GCP_REGION || DEFAULTS.REGION },
    apple_probe: 'not_performed',
    apple_session: 'unknown',
    recent_events: sanitized,
    preflight_runs:
      runs.status === 'fulfilled'
        ? safeList(runs.value, 'workflow_runs').map((run: any) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            created_at: run.created_at,
            html_url: run.html_url,
          }))
        : [],
    suggest_reauth: suspected,
    reason: suspected
      ? 'Os logs mostram indícios de sessão expirada. Recomenda-se testar e renovar a autenticação no terminal seguro.'
      : 'Não há confirmação recente de falha de autenticação. Um teste ao vivo com a Apple ainda é necessário para comprovar o acesso.',
  });
}
