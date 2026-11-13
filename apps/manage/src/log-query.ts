import { ApiError } from './auth';
import { TERM, UUID } from './log-deeplink';

// 1. Utilities and Global Time Constants
export const TIME_MS = {
  MINUTE: 60_000,
  DAY: 86_400_000,
};

// 2. Customizable Search Configurations (Eliminating magic numbers)
export const LOG_CONFIG = {
  MIN_MINUTES: 5,
  MAX_MINUTES: 10_080, // 7 days in minutes
  DEFAULT_MINUTES: 30,
  CONTEXT_MINUTES: 15,
  MAX_AGE_MS: 7 * TIME_MS.DAY,
  MAX_TIMESTAMP_LENGTH: 40,
  FUTURE_TOLERANCE_MS: TIME_MS.MINUTE, // 1 minute tolerance for future timestamps
};

// 3. Centralized Regex Patterns
export const LOG_PATTERNS = {
  RAY: /^[a-f0-9-]{8,64}$/i,
  EVENT: /^[a-f0-9]{32}$/i,
};

export interface LogRequest {
  terms: string[];
  entry: string;
  start: number;
  end: number;
  minutes: number;
}

// 4. Field Mapping and Validators
const FIELD_VALIDATORS: Array<[string, RegExp]> = [
  ['correlation', UUID],
  ['job', UUID],
  ['ray', LOG_PATTERNS.RAY],
  ['event', LOG_PATTERNS.EVENT],
  ['search', TERM],
];

// --- MAIN FUNCTIONS ---

export function parseLogRequest(params: URLSearchParams, now = Date.now()): LogRequest {
  // Base time parsing
  const rawMinutes = params.get('minutes') || String(LOG_CONFIG.DEFAULT_MINUTES);
  const minutes = Number(rawMinutes);

  if (!Number.isInteger(minutes) || minutes < LOG_CONFIG.MIN_MINUTES || minutes > LOG_CONFIG.MAX_MINUTES) {
    throw new ApiError(
      422,
      'MINUTES',
      `Período inválido (${LOG_CONFIG.MIN_MINUTES} minutos a ${LOG_CONFIG.MAX_MINUTES / 1440} dias)`
    );
  }

  // Capture and validate search terms
  const terms: string[] = [];
  for (const [field, validation] of FIELD_VALIDATORS) {
    const value = params.get(field)?.trim();
    if (!value) continue;

    if (!validation.test(value)) {
      throw new ApiError(422, 'LOG_IDENTIFIER', 'Identificador de log inválido');
    }
    
    // Prevent duplicate terms in the array
    if (!terms.includes(value)) terms.push(value);
  }

  // Capture and validate single entry
  const entry = params.get('entry')?.trim() || '';
  if (entry && !TERM.test(entry)) {
    throw new ApiError(422, 'LOG_ENTRY', 'Identificador de registro inválido');
  }

  // Time window calculation (Specific 'at' timestamp)
  const at = params.get('at')?.trim();
  if (at) {
    if (at.length > LOG_CONFIG.MAX_TIMESTAMP_LENGTH || Number.isNaN(Date.parse(at))) {
      throw new ApiError(422, 'LOG_TIMESTAMP', 'Horário do evento inválido');
    }

    const moment = Date.parse(at);
    if (moment > now + LOG_CONFIG.FUTURE_TOLERANCE_MS || moment < now - LOG_CONFIG.MAX_AGE_MS) {
      throw new ApiError(422, 'LOG_TIMESTAMP', 'Evento fora da janela permitida');
    }

    const padding = LOG_CONFIG.CONTEXT_MINUTES * TIME_MS.MINUTE;
    
    return {
      terms,
      entry,
      start: Math.max(now - LOG_CONFIG.MAX_AGE_MS, moment - padding),
      end: Math.min(now, moment + padding),
      minutes,
    };
  }

  // Default return (Current time minus requested minutes)
  return {
    terms,
    entry,
    start: now - minutes * TIME_MS.MINUTE,
    end: now,
    minutes,
  };
}

export function gcpLogFilter(request: LogRequest): string {
  const { start, end, terms, entry } = request;

  // Use Template Literals for query performance and readability
  const windowFilter = `timestamp>="${new Date(start).toISOString()}" AND timestamp<="${new Date(end).toISOString()}"`;
  const resourcesFilter = `(resource.type="cloud_run_job" OR resource.type="cloud_run_revision")`;

  let termsFilter = '';
  if (terms.length > 0) {
    const searchConditions = terms.map(value => `SEARCH("${value}")`).join(' OR ');
    termsFilter = ` AND (${searchConditions})`;
  } else if (!entry) {
    // Only require WARNING+ if there are no precise search terms or entry ID
    termsFilter = ` AND severity>=WARNING`;
  }

  const entryFilter = entry ? ` AND insertId="${entry}"` : '';

  // Build the final query
  return `${resourcesFilter} AND ${windowFilter}${termsFilter}${entryFilter}`;
}
