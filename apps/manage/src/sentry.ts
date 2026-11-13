import { ApiError } from './auth';
import type { Env } from './auth';

// --- CONFIGURATION ---

export const SENTRY_CONFIG = {
  // Throttling / Grouping
  THROTTLE_WINDOW_MS: 60_000, // 1 minute window to group identical errors
  MAX_CACHE_SIZE: 100,        // Max unique fingerprints in memory to prevent leaks
  // Payload limits
  MAX_MESSAGE_LENGTH: 2048,
  MAX_FRAMES: 20,
  FETCH_TIMEOUT_MS: 5000,
};

const PATTERNS = {
  SAFE_ID: /^[0-9a-f]{32}$/i,
  SAFE_ORG: /^[a-z0-9][a-z0-9-]{0,62}$/,
  CORRELATION_ID: /^[a-f0-9-]{36}$/i,
  SENTRY_DSN_USER: /^[a-f0-9]{12,64}$/i,
  SENTRY_HOST: /(^|\.)sentry\.io$/,
  FILE_EXTENSIONS: /^[\w.-]+\.(?:js|mjs|ts|tsx)$/,
  // Redaction patterns
  URL: /\b(?:https?|ftp|s3|gs):\/\/[^\s"'<>]+/gi,
  SECRETS: /\b(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
  BEARER: /\bbearer\s+[A-Za-z0-9._~+/-]+/gi,
  JWT: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  EMAIL: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
  PATHS: /(^|[\s(])\/(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+/g,
  ERROR_FRAME: /^(?:at\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/,
};

// In-memory cache for the Worker isolate to deduplicate identical errors
const throttleCache = new Map<string, number>();

// --- UTILITIES ---

export function sentrySearchUrl(org: string | undefined, correlationId: string): string | undefined {
  if (!org || !PATTERNS.SAFE_ORG.test(org) || !PATTERNS.CORRELATION_ID.test(correlationId)) return undefined;
  return `https://${org}.sentry.io/issues/?query=${encodeURIComponent('correlation_id:' + correlationId)}`;
}

export function safeManageMessage(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(PATTERNS.URL, '[URL redigida]')
    .replace(PATTERNS.SECRETS, '$1=[redigido]')
    .replace(PATTERNS.BEARER, 'Bearer [redigido]')
    .replace(PATTERNS.JWT, '[JWT redigido]')
    .replace(PATTERNS.EMAIL, '[email redigido]')
    .replace(PATTERNS.PATHS, '$1[caminho redigido]')
    .slice(0, SENTRY_CONFIG.MAX_MESSAGE_LENGTH);
}

export function manageSentryEndpoint(dsn: string | undefined): string | undefined {
  if (!dsn) return undefined;
  try {
    const uri = new URL(dsn);
    const project = uri.pathname.match(/^\/([0-9]+)\/?$/)?.[1];
    
    if (
      !project ||
      uri.protocol !== 'https:' ||
      !uri.username ||
      uri.password ||
      !PATTERNS.SENTRY_DSN_USER.test(uri.username) ||
      uri.search ||
      uri.hash ||
      !PATTERNS.SENTRY_HOST.test(uri.hostname)
    ) return undefined;

    return `${uri.origin}/api/${project}/envelope/`;
  } catch {
    return undefined;
  }
}

function safeFrames(error: unknown): Array<Record<string, string | number>> {
  if (!(error instanceof Error) || !error.stack) return [];
  
  return error.stack
    .split('\n')
    .slice(1, SENTRY_CONFIG.MAX_FRAMES + 1)
    .flatMap((line) => {
      const frame = line.trim().match(PATTERNS.ERROR_FRAME);
      if (!frame) return [];
      
      const filename = frame[2].split(/[?#]/, 1)[0];
      const name = filename.split('/').pop() || '';
      
      // Keep only first-party application files
      if (!PATTERNS.FILE_EXTENSIONS.test(name)) return [];
      
      return [{
        filename: name,
        function: safeManageMessage(frame[1] || '<anonymous>').slice(0, 100),
        lineno: Number(frame[3]),
        colno: Number(frame[4]),
      }];
    })
    .reverse();
}

// Determines if an error fingerprint has been sent recently in this isolate
function isThrottled(fingerprint: string[]): boolean {
  const key = fingerprint.join(':');
  const now = Date.now();
  const lastSeen = throttleCache.get(key);

  if (lastSeen && now - lastSeen < SENTRY_CONFIG.THROTTLE_WINDOW_MS) {
    return true;
  }

  // Prevent memory leaks in the Cloudflare Worker isolate
  if (throttleCache.size >= SENTRY_CONFIG.MAX_CACHE_SIZE) {
    const oldestKey = throttleCache.keys().next().value;
    if (oldestKey) throttleCache.delete(oldestKey);
  }

  throttleCache.set(key, now);
  return false;
}

// --- MAIN CAPTURE FLOW ---

export interface ManageIncident {
  eventId: string;
  correlationId: string;
  delivered: Promise<void>;
  url?: string;
  throttled?: boolean;
}

export function captureManageError(
  env: Env,
  error: unknown,
  details: { correlationId: string; route: string; method: string; provider?: string },
): ManageIncident | undefined {
  const endpoint = manageSentryEndpoint(env.SENTRY_DSN);
  if (!endpoint) return undefined;

  const eventId = crypto.randomUUID().replace(/-/g, '');
  if (!PATTERNS.SAFE_ID.test(eventId)) return undefined;

  const code = error instanceof ApiError ? error.code : 'UNHANDLED_EXCEPTION';
  const status = error instanceof ApiError ? error.status : 500;
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);

  const fingerprint = ['manage', code, details.route, details.provider || 'runtime'];

  // Check rate limit to prevent Sentry quota exhaustion for repeated errors
  if (isThrottled(fingerprint)) {
    return {
      eventId,
      correlationId: details.correlationId,
      delivered: Promise.resolve(), // Resolves immediately without network request
      url: sentrySearchUrl(env.SENTRY_ORG, details.correlationId),
      throttled: true,
    };
  }

  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    logger: 'photointel-manage',
    fingerprint,
    exception: {
      values: [{
        type: /^[\w.]{1,100}$/.test(name) ? name : 'Error',
        value: safeManageMessage(message) || code,
        stacktrace: { frames: safeFrames(error) },
      }],
    },
    tags: {
      service: 'photointel-manage',
      correlation_id: details.correlationId,
      error_code: code,
      status: String(status),
      route: details.route,
      method: details.method,
      ...(details.provider ? { provider: details.provider } : {}),
    },
  };

  const envelope = [
    JSON.stringify({ event_id: eventId, dsn: env.SENTRY_DSN, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event', content_type: 'application/json' }),
    JSON.stringify(event),
    '',
  ].join('\n');

  // Dispatch to Sentry asynchronously (handled by context.waitUntil in the main router)
  const delivered = fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body: envelope,
    signal: AbortSignal.timeout(SENTRY_CONFIG.FETCH_TIMEOUT_MS),
  })
  .then(() => undefined)
  .catch(() => undefined);

  return {
    eventId,
    correlationId: details.correlationId,
    delivered,
    url: sentrySearchUrl(env.SENTRY_ORG, details.correlationId),
    throttled: false,
  };
}
