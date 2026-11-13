/** Minimal client telemetry: never send URLs, messages, stacks, tokens or photo metadata. */
import { ApiError } from '../api/error';
import { captureBrowserException } from './sentry';

// --- TYPES ---

export type DiagnosticPhase = 'bootstrap' | 'render' | 'runtime' | 'promise' | 'api' | 'resource' | 'worker';
export type DiagnosticSource = 'cloudflare' | 'gcp';

export interface Diagnostic {
  id: string;
  phase: DiagnosticPhase;
  category: string;
  source: DiagnosticSource;
  code: string;
  status?: number;
  message: string;
  rayId?: string;
  eventId?: string;
}

export interface ManageLogContext {
  correlation?: string;
  job?: string;
  jobType?: string;
  ray?: string;
  event?: string;
  at?: string;
}

// --- CONFIGURATION & CONSTANTS ---

export const DIAGNOSTIC_CONFIG = {
  MANAGE_LOGS_BASE_URL: 'https://photos-manage.migos.club/',
  DIAGNOSTICS_ENDPOINT: '/__diagnostics/client-errors',
  MAX_SENT_CACHE: 200,
  DEFAULT_MESSAGE: 'Falha inesperada na aplicação',
  FALLBACK_SOURCE: 'cloudflare' as DiagnosticSource,
} as const;

const PATTERNS = {
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  API_CODE: /^[A-Z0-9_]{1,48}$/,
  JOB_TYPE: /^[a-z0-9_]{1,48}$/,
  RAY_ID: /^[a-f0-9-]{8,64}$/i,
  EVENT_ID: /^[a-f0-9]{32}$/i,
};

// --- CACHE ---

// Prevent spam to the diagnostics endpoint
const sent = new Set<string>();

// React Query and mutation handlers can report the same Error instance repeatedly.
// Preserve one incident, one Sentry event and one correlation ID per failure.
const diagnosed = new WeakMap<Error, Diagnostic>();

// --- UTILITIES ---

function generateUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  
  // Polyfill for environments missing randomUUID (e.g. older browsers without secure context)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8), 
    hex.slice(8, 12), 
    hex.slice(12, 16), 
    hex.slice(16, 20), 
    hex.slice(20)
  ].join('-');
}

function resolveErrorCode(apiCode: string | undefined, phase: DiagnosticPhase, errorName: string): string {
  if (apiCode && PATTERNS.API_CODE.test(apiCode)) return apiCode;
  
  const PHASE_MAPPINGS: Partial<Record<DiagnosticPhase, string>> = {
    resource: 'RESOURCE_LOAD_FAILURE',
    bootstrap: 'BOOT_FAILURE',
    api: 'API_ERROR',
  };

  if (PHASE_MAPPINGS[phase]) return PHASE_MAPPINGS[phase];
  if (errorName === 'ChunkLoadError') return 'CHUNK_LOAD_FAILURE';
  
  return 'CLIENT_FAILURE';
}

function resolveCategory(api: ApiError | null, phase: DiagnosticPhase): string {
  if (!api) return `frontend.${phase}`;
  return api.code === 'NETWORK_ERROR' ? 'api.network' : 'api.http';
}

// --- CORE DIAGNOSTIC FLOW ---

export function diagnosticFor(error: unknown, phase: DiagnosticPhase): Diagnostic {
  const previouslyReported = error instanceof Error ? diagnosed.get(error) : undefined;
  if (previouslyReported) return previouslyReported;

  const api = error instanceof ApiError ? error : null;
  const name = error instanceof Error ? error.name : 'UnknownError';
  const correlationId = api?.correlationId && PATTERNS.UUID.test(api.correlationId) 
    ? api.correlationId 
    : generateUUID();

  return {
    id: correlationId,
    phase,
    category: resolveCategory(api, phase),
    source: api?.source ?? DIAGNOSTIC_CONFIG.FALLBACK_SOURCE,
    code: resolveErrorCode(api?.code, phase, name),
    status: api?.status,
    message: error instanceof Error ? error.message : DIAGNOSTIC_CONFIG.DEFAULT_MESSAGE,
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

  if (error instanceof Error) {
    diagnosed.set(error, incident);
  }

  // Developer logging (local debug)
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
    
    if (sent.size > DIAGNOSTIC_CONFIG.MAX_SENT_CACHE) {
      sent.clear();
    }

    try {
      // Fire-and-forget payload via Beacon-style fetch
      void fetch(DIAGNOSTIC_CONFIG.DIAGNOSTICS_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true, // Prevents cancellation if the user navigates away
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          id: incident.id, 
          phase: incident.phase, 
          code: incident.code 
        }),
      }).catch(() => undefined);
    } catch {
      /* Diagnostics must never crash the application. */
    }
  }

  return incident;
}

// --- LINK & QUERY GENERATION ---

/** Centralized, URL-addressable investigations. Never include messages, stack traces or credentials. */
export function manageLogsUrl(source: DiagnosticSource, context: ManageLogContext = {}): string {
  const url = new URL(DIAGNOSTIC_CONFIG.MANAGE_LOGS_BASE_URL);
  url.searchParams.set('tab', 'logs');
  url.searchParams.set('source', source);

  if (context.correlation && PATTERNS.UUID.test(context.correlation)) {
    url.searchParams.set('correlation', context.correlation);
  }
  if (context.job && PATTERNS.UUID.test(context.job)) {
    url.searchParams.set('job', context.job);
  }
  if (context.jobType && PATTERNS.JOB_TYPE.test(context.jobType)) {
    url.searchParams.set('job_type', context.jobType);
  }
  if (context.ray && PATTERNS.RAY_ID.test(context.ray)) {
    url.searchParams.set('ray', context.ray);
  }
  if (context.event && PATTERNS.EVENT_ID.test(context.event)) {
    url.searchParams.set('event', context.event);
  }
  if (context.at && !Number.isNaN(Date.parse(context.at))) {
    url.searchParams.set('at', new Date(context.at).toISOString());
  }

  return url.toString();
}

export function diagnosticLogsUrl(incident: Diagnostic): string {
  return manageLogsUrl(incident.source, {
    correlation: incident.id,
    ray: incident.rayId,
    event: incident.eventId,
  });
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

// --- TEXT EXPORTS ---

/** Copyable Logs Explorer query: avoids WebKit/in-app browsers dropping the
 * semicolon URL parameters or trimming encoded parentheses on redirect. */
export function diagnosticLogsQuery(incident: Diagnostic): string {
  const id = PATTERNS.UUID.test(incident.id) ? incident.id : '';
  
  const queryParts = [
    'resource.type="cloud_run_revision"',
    'resource.labels.service_name="photointel-api"',
  ];

  queryParts.push(id ? `SEARCH("${id}")` : 'severity>=WARNING');
  
  return queryParts.join('\n');
}

export function diagnosticClipboardText(incident: Diagnostic): string {
  const lines = [
    'PhotoIntel · diagnóstico',
    `Correlation ID: ${incident.id}`,
    `Origem: ${incident.source}`,
    `Fase: ${incident.phase}`,
    `Categoria: ${incident.category}`,
    `Código: ${incident.code}`,
  ];

  if (incident.status !== undefined) lines.push(`HTTP: ${incident.status}`);
  if (incident.rayId) lines.push(`Cloudflare Ray: ${incident.rayId}`);
  if (incident.eventId) lines.push(`Sentry Event ID: ${incident.eventId}`);

  return lines.join('\n');
}
