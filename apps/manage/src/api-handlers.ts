import { json } from './auth';
import type { Env, Identity } from './auth';
import type { gcp, gh, mapCloudLogs } from './providers';
type DiagnosticEvent = { timestamp?: string; service?: string; severity?: string; message?: unknown };
type WorkflowRun = { id?: number; name?: string; status?: string; conclusion?: string | null; created_at?: string; html_url?: string };
import { DEFAULTS, safeList, sanitizeLog } from './api-utils';

export async function handleIcloudDiagnostics(env: Env, identity: Identity, gcpRequest: typeof gcp, githubRequest: typeof gh, mapLogs: typeof mapCloudLogs) {
  const project = env.GCP_PROJECT_ID || DEFAULTS.PROJECT_ID;
  const [cloud, runs] = await Promise.allSettled([
    gcpRequest(env, identity, 'https://logging.googleapis.com/v2/entries:list', {
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
    githubRequest(env, '/actions/workflows/icloud-setup.yml/runs?per_page=5'),
  ]);

  const events = cloud.status === 'fulfilled' ? mapLogs((cloud.value as { entries?: unknown }).entries) : [];
  const sanitized = events.map((event) => { const item = event as DiagnosticEvent; return ({
    timestamp: item.timestamp,
    service: item.service,
    severity: item.severity,
    message: sanitizeLog(item.message, 450),
  }); });

  const suspected = sanitized.some((item) =>
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
        ? safeList(runs.value, 'workflow_runs').map((run) => { const item = run as WorkflowRun; return ({
            id: item.id,
            name: item.name,
            status: item.status,
            conclusion: item.conclusion,
            created_at: item.created_at,
            html_url: item.html_url,
          }); })
        : [],
    suggest_reauth: suspected,
    reason: suspected
      ? 'Os logs mostram indícios de sessão expirada. Recomenda-se testar e renovar a autenticação no terminal seguro.'
      : 'Não há confirmação recente de falha de autenticação. Um teste ao vivo com a Apple ainda é necessário para comprovar o acesso.',
  });
}
