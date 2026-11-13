/** Frontend Sentry: consent-free diagnostics, but no personal/photo data. */
import * as Sentry from '@sentry/react';

// --- CONFIGURATION ---

export const SENTRY_CONFIG = {
  // Throttling / Grouping limits to prevent client-side spam
  THROTTLE_WINDOW_MS: 60_000, // 1 minute window to group identical errors
  MAX_CACHE_SIZE: 100,        // Max unique error signatures in memory
  // Payload limits
  MAX_MESSAGE_LENGTH: 2048,
  TRACES_SAMPLE_RATE: 0.1,
};

const PATTERNS = {
  EVENT_ID: /^[a-f0-9]{32}$/i,
  HTTP_METHOD: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i,
  // Redaction patterns
  URL: /\b(?:https?|ftp|s3|gs):\/\/[^\s"'<>]+/gi,
  SECRETS: /\b(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie)\s*[:=]\s*[^\s,;]+/gi,
  BEARER: /\bbearer\s+[A-Za-z0-9._~+/-]+/gi,
  JWT: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  EMAIL: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
  PATHS: /(^|[\s(])\/(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+/g,
  MEDIA_FILES: /\b[^\s/\\]+\.(?:heic|heif|jpe?g|png|webp|avif|mov|mp4)\b/gi,
};

// In-memory cache to deduplicate identical errors in the browser
const throttleCache = new Map<string, number>();

// --- UTILITIES ---

// Determines if an error signature has been sent recently by this client
function isThrottled(signature: string): boolean {
  const now = Date.now();
  const lastSeen = throttleCache.get(signature);

  if (lastSeen && now - lastSeen < SENTRY_CONFIG.THROTTLE_WINDOW_MS) {
    return true;
  }

  // Prevent memory leaks in long-lived browser sessions
  if (throttleCache.size >= SENTRY_CONFIG.MAX_CACHE_SIZE) {
    const oldestKey = throttleCache.keys().next().value;
    if (oldestKey) throttleCache.delete(oldestKey);
  }

  throttleCache.set(signature, now);
  return false;
}

/** Redact private values (PII, credentials, file names), leaving only the diagnostic skeleton. */
export function safeSentryMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(PATTERNS.URL, '[URL redigida]')
    .replace(PATTERNS.SECRETS, '$1=[redigido]')
    .replace(PATTERNS.BEARER, 'Bearer [redigido]')
    .replace(PATTERNS.JWT, '[token redigido]')
    .replace(PATTERNS.EMAIL, '[email redigido]')
    .replace(PATTERNS.PATHS, '$1[caminho redigido]')
    .replace(PATTERNS.MEDIA_FILES, '[arquivo redigido]')
    .slice(0, SENTRY_CONFIG.MAX_MESSAGE_LENGTH);
}

// --- MAIN CAPTURE FLOW ---

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_ID || undefined,
    sendDefaultPii: false,
    attachStacktrace: true,
    defaultIntegrations: false,
    integrations: [Sentry.browserTracingIntegration(), Sentry.linkedErrorsIntegration()],
    tracesSampleRate: SENTRY_CONFIG.TRACES_SAMPLE_RATE,
    tracePropagationTargets: [
      /^\/v1\//,
      new RegExp('^' + window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/v1/'),
    ],
    beforeSend(event) {
      // 1. Strip all ambient context that might contain implicit PII
      delete event.request;
      delete event.user;
      //delete event.breadcrumbs;
     // delete event.extra;
     // delete event.contexts;
      if (event.logentry) delete event.logentry;

      // 2. Redact top-level message
      if (event.message) event.message = safeSentryMessage(event.message);

      let exceptionSignature = event.message || 'unknown_error';

      // 3. Keep meaningful exception text while scrubbing private inputs and source code variables
      for (const item of event.exception?.values ?? []) {
        item.value = safeSentryMessage(item.value) || item.type || 'ApplicationError';
        exceptionSignature = `${item.type}:${item.value}`;
        
        for (const frame of item.stacktrace?.frames ?? []) {
          if (frame.filename) frame.filename = frame.filename.split(/[?#]/, 1)[0];
        //  delete frame.context_line;
          delete frame.pre_context;
          delete frame.post_context;
          delete frame.vars;
        //  delete frame.abs_path;
        }
      }

      // 4. Client-side Deduplication / Throttling
      // Use the explicit fingerprint if set, otherwise fallback to the sanitized exception signature
      const cacheKey = event.fingerprint ? event.fingerprint.join(':') : exceptionSignature;
      
      if (isThrottled(cacheKey)) {
        return null; // Drop event to prevent quota exhaustion
      }

      return event;
    },
  });
}

export function captureBrowserException(
  error: unknown,
  id: string,
  phase: string,
  category: string,
): string | undefined {
  if (!Sentry.isEnabled()) return undefined;
  
  const original = error instanceof Error ? error : new Error('Unknown browser exception');
  
  // Only the HTTP method (never the URL or body) can affect network grouping
  const method =
    error instanceof Error &&
    'method' in error &&
    typeof error.method === 'string' &&
    PATTERNS.HTTP_METHOD.test(error.method)
      ? error.method.toUpperCase()
      : 'OTHER';

  const event = Sentry.captureException(original, {
    tags: { correlation_id: id, phase, service: 'photointel-web', error_kind: category },
    // Force specific error categories (like network failures) to group together purely by their HTTP method
    ...(category === 'api.network' ? { fingerprint: ['photointel', 'api.network', method] } : {}),
  });

  return PATTERNS.EVENT_ID.test(event) ? event.toLowerCase() : undefined;
}

export function sentryEventUrl(eventId: string): string | undefined {
  if (!PATTERNS.EVENT_ID.test(eventId)) return undefined;
  
  // An authenticated API resolver uses the Sentry API to find the exact issue/event metadata
  return '/v1/observability/sentry-events/' + eventId.toLowerCase();
}
