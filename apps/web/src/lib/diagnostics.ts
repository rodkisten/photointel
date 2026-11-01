/** Minimal client telemetry: never send URLs, messages, stacks, tokens or photo metadata. */
import { ApiError } from '../api/error';

export type DiagnosticPhase = 'bootstrap' | 'render' | 'runtime' | 'promise' | 'api' | 'resource' | 'worker';
export interface Diagnostic {
  id: string;
  phase: DiagnosticPhase;
  source: 'cloudflare' | 'gcp';
  code: string;
  status?: number;
  message: string;
  rayId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sent = new Set<string>();

function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join('-');
}

export function diagnosticFor(error: unknown, phase: DiagnosticPhase): Diagnostic {
  const api = error instanceof ApiError ? error : null;
  const name = error instanceof Error ? error.name : 'UnknownError';
  return {
    id: api?.correlationId && UUID.test(api.correlationId) ? api.correlationId : newId(),
    phase,
    source: api?.source ?? 'cloudflare',
    code: api?.code && /^[A-Z0-9_]{1,48}$/.test(api.code) ? api.code :
      (phase === 'resource' ? 'RESOURCE_LOAD_FAILURE' : phase === 'bootstrap' ? 'BOOT_FAILURE' :
        phase === 'api' ? 'API_ERROR' : name === 'ChunkLoadError' ? 'CHUNK_LOAD_FAILURE' : 'CLIENT_FAILURE'),
    status: api?.status,
    message: error instanceof Error ? error.message : 'Falha inesperada na aplicação',
    rayId: api?.rayId,
  };
}

export function reportDiagnostic(error: unknown, phase: DiagnosticPhase): Diagnostic {
  const incident = diagnosticFor(error, phase);
  console.error('[PhotoIntel diagnostic]', {
    correlation_id: incident.id, source: incident.source, phase: incident.phase,
    code: incident.code, status: incident.status, error,
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
    } catch { /* Diagnostics must never crash the application. */ }
  }
  return incident;
}

export function diagnosticLogsUrl(incident: Diagnostic): string {
  if (incident.source === 'gcp') {
    const query = 'SEARCH("' + incident.id + '")';
    return 'https://console.cloud.google.com/logs/query;query=' +
      encodeURIComponent(query) + '?project=photointel';
  }
  // Without an account ID, route to the official Workers page and let the
  // operator select PhotoIntel > Observability and filter correlation_id.
  return 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';
}

export function diagnosticClipboardText(incident: Diagnostic): string {
  return [
    'PhotoIntel · diagnóstico',
    'Correlation ID: ' + incident.id,
    'Origem: ' + incident.source,
    'Fase: ' + incident.phase,
    'Código: ' + incident.code,
    ...(incident.status === undefined ? [] : ['HTTP: ' + incident.status]),
    ...(incident.rayId ? ['Cloudflare Ray: ' + incident.rayId] : []),
  ].join('\n');
}
