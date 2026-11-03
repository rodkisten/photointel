/** Minimal client telemetry: never send URLs, messages, stacks, tokens or photo metadata. */
import { ApiError } from '../api/error';
import { captureBrowserException } from './sentry';

export type DiagnosticPhase = 'bootstrap' | 'render' | 'runtime' | 'promise' | 'api' | 'resource' | 'worker';
export interface Diagnostic {
  id: string;
  phase: DiagnosticPhase;
  category: string;
  source: 'cloudflare' | 'gcp';
  code: string;
  status?: number;
  message: string;
  rayId?: string;
  eventId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sent = new Set<string>();
// React Query and mutation handlers can report the same Error instance repeatedly.
// Preserve one incident, one Sentry event and one correlation ID per failure.
const diagnosed = new WeakMap<Error, Diagnostic>();

function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function diagnosticFor(error: unknown, phase: DiagnosticPhase): Diagnostic {
  const previouslyReported = error instanceof Error ? diagnosed.get(error) : undefined;
  if (previouslyReported) return previouslyReported;
  const api = error instanceof ApiError ? error : null;
  const name = error instanceof Error ? error.name : 'UnknownError';
  return {
    id: api?.correlationId && UUID.test(api.correlationId) ? api.correlationId : newId(),
    phase,
    category: api ? (api.code === 'NETWORK_ERROR' ? 'api.network' : 'api.http') : `frontend.${phase}`,
    source: api?.source ?? 'cloudflare',
    code:
      api?.code && /^[A-Z0-9_]{1,48}$/.test(api.code)
        ? api.code
        : phase === 'resource'
          ? 'RESOURCE_LOAD_FAILURE'
          : phase === 'bootstrap'
            ? 'BOOT_FAILURE'
            : phase === 'api'
              ? 'API_ERROR'
              : name === 'ChunkLoadError'
                ? 'CHUNK_LOAD_FAILURE'
                : 'CLIENT_FAILURE',
    status: api?.status,
    message: error instanceof Error ? error.message : 'Falha inesperada na aplicação',
    rayId: api?.rayId,
    eventId: api?.eventId,
  };
}

export function reportDiagnostic(error: unknown, phase: DiagnosticPhase): Diagnostic {
  const previous = error instanceof Error ? diagnosed.get(error) : undefined;
  if (previous) return previous;
  const incident = diagnosticFor(error, phase);
  // Only transport failures belong in web Sentry; backend/edge HTTP events
  // already belong to their origin (even if their response has no event ID).
  if (!(error instanceof ApiError) || error.code === 'NETWORK_ERROR') {
    if (!incident.eventId) {
      incident.eventId = captureBrowserException(error, incident.id, phase, incident.category);
    }
  }
  if (error instanceof Error) diagnosed.set(error, incident);
  console.error('[PhotoIntel diagnostic]', {
    correlation_id: incident.id,
    source: incident.source,
    phase: incident.phase,
    category: incident.category,
    code: incident.code,
    status: incident.status,
    error,
  });
  // API exceptions already have an origin correlation ID; client-side errors
  // need a sanitized entry in Cloudflare Workers Logs to become searchable.
  if (incident.source === 'cloudflare' && !sent.has(incident.id)) {
    sent.add(incident.id);
    if (sent.size > 200) sent.clear();
    try {
      void fetch('/__diagnostics/client-errors', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: incident.id, phase: incident.phase, code: incident.code }),
      }).catch(() => undefined);
    } catch {
      /* Diagnostics must never crash the application. */
    }
  }
  return incident;
}

/** Centralized, URL-addressable investigations. Never include messages, stack traces or credentials. */
export function manageLogsUrl(
  source: 'gcp' | 'cloudflare',
  context: {
    correlation?: string;
    job?: string;
    jobType?: string;
    ray?: string;
    event?: string;
    at?: string;
  } = {},
): string {
  const url = new URL('https://photos-manage.migos.club/');
  url.searchParams.set('tab', 'logs');
  url.searchParams.set('source', source);
  if (context.correlation && UUID.test(context.correlation))
    url.searchParams.set('correlation', context.correlation);
  if (context.job && UUID.test(context.job)) url.searchParams.set('job', context.job);
  if (context.jobType && /^[a-z0-9_]{1,48}$/.test(context.jobType))
    url.searchParams.set('job_type', context.jobType);
  if (context.ray && /^[a-f0-9-]{8,64}$/i.test(context.ray)) url.searchParams.set('ray', context.ray);
  if (context.event && /^[a-f0-9]{32}$/i.test(context.event)) url.searchParams.set('event', context.event);
  if (context.at && !Number.isNaN(Date.parse(context.at))) {
    url.searchParams.set('at', new Date(context.at).toISOString());
  }
  return url.toString();
}

/** Copyable Logs Explorer query: avoids WebKit/in-app browsers dropping the
 * semicolon URL parameters or trimming encoded parentheses on redirect. */
export function diagnosticLogsQuery(incident: Diagnostic): string {
  const id = UUID.test(incident.id) ? incident.id : '';
  return [
    'resource.type="cloud_run_revision"',
    'resource.labels.service_name="photointel-api"',
    ...(id ? ['SEARCH("' + id + '")'] : ['severity>=WARNING']),
  ].join('\n');
}

export function diagnosticLogsUrl(incident: Diagnostic): string {
  return manageLogsUrl(incident.source, {
    correlation: incident.id,
    ray: incident.rayId,
    event: incident.eventId,
  });
}

export function diagnosticClipboardText(incident: Diagnostic): string {
  return [
    'PhotoIntel · diagnóstico',
    'Correlation ID: ' + incident.id,
    'Origem: ' + incident.source,
    'Fase: ' + incident.phase,
    'Categoria: ' + incident.category,
    'Código: ' + incident.code,
    ...(incident.status === undefined ? [] : ['HTTP: ' + incident.status]),
    ...(incident.rayId ? ['Cloudflare Ray: ' + incident.rayId] : []),
    ...(incident.eventId ? ['Sentry Event ID: ' + incident.eventId] : []),
  ].join('\n');
}

/** Directly opens a job-scoped investigation in Manage, including historical jobs. */
export function jobLogsUrl(jobType: string, jobId?: string, correlationId?: string, at?: string): string {
  return manageLogsUrl('gcp', {
    job: jobId,
    correlation: correlationId,
    jobType,
    at,
  });
}
