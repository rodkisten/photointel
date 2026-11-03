/** Safe provider-side queries for a link to one incident or job. */
import { ApiError } from './auth';
import { TERM, UUID } from './log-deeplink';

const RAY = /^[a-f0-9-]{8,64}$/i;
const EVENT = /^[a-f0-9]{32}$/i;
const MAX_AGE = 7 * 86400_000;
const CONTEXT_MINUTES = 15;

export interface LogRequest {
  terms: string[];
  entry: string;
  start: number;
  end: number;
  minutes: number;
}

export function parseLogRequest(params: URLSearchParams, now = Date.now()): LogRequest {
  const raw = params.get('minutes') || '30';
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080)
    throw new ApiError(422, 'MINUTES', 'Período inválido (5 minutos a 7 dias)');
  const fields: Array<[string, RegExp]> = [
    ['correlation', UUID],
    ['job', UUID],
    ['ray', RAY],
    ['event', EVENT],
    ['search', TERM],
  ];
  const terms: string[] = [];
  for (const [field, validation] of fields) {
    const value = params.get(field)?.trim() || '';
    if (value && !validation.test(value))
      throw new ApiError(422, 'LOG_IDENTIFIER', 'Identificador de log inválido');
    if (value && !terms.includes(value)) terms.push(value);
  }
  const entry = params.get('entry') || '';
  if (entry && !TERM.test(entry)) throw new ApiError(422, 'LOG_ENTRY', 'Identificador de registro inválido');
  const at = params.get('at');
  if (at) {
    if (at.length > 40 || Number.isNaN(Date.parse(at)))
      throw new ApiError(422, 'LOG_TIMESTAMP', 'Horário do evento inválido');
    const moment = Date.parse(at);
    if (moment > now + 60_000 || moment < now - MAX_AGE)
      throw new ApiError(422, 'LOG_TIMESTAMP', 'Evento fora da janela de 7 dias');
    const pad = CONTEXT_MINUTES * 60_000;
    return {
      terms,
      entry,
      start: Math.max(now - MAX_AGE, moment - pad),
      end: Math.min(now, moment + pad),
      minutes,
    };
  }
  return { terms, entry, start: now - minutes * 60_000, end: now, minutes };
}

export function gcpLogFilter(request: LogRequest): string {
  const window =
    'timestamp>="' +
    new Date(request.start).toISOString() +
    '" AND timestamp<="' +
    new Date(request.end).toISOString() +
    '"';
  const resources = '(resource.type="cloud_run_job" OR resource.type="cloud_run_revision")';
  const terms = request.terms.length
    ? ' AND (' + request.terms.map((value) => 'SEARCH("' + value + '")').join(' OR ') + ')'
    : request.entry
      ? ''
      : ' AND severity>=WARNING';
  return (
    resources + ' AND ' + window + terms + (request.entry ? ' AND insertId="' + request.entry + '"' : '')
  );
}
