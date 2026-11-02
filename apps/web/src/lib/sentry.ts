/** Frontend Sentry: consent-free diagnostics, but no personal/photo data. */
import * as Sentry from '@sentry/react';

const EVENT = /^[a-f0-9]{32}$/i;
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

/** Redact private values, not the diagnostic message itself. */
export function safeSentryMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\b(?:https?|ftp|s3|gs):\/\/[^\s"'<>]+/gi, '[URL redigida]')
    .replace(
      /\b(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redigido]',
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redigido]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token redigido]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email redigido]')
    .replace(/(^|[\s(])\/(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+/g, '$1[caminho redigido]')
    .replace(/\b[^\s/\\]+\.(?:heic|heif|jpe?g|png|webp|avif|mov|mp4)\b/gi, '[arquivo redigido]')
    .slice(0, 2048);
}

export function initSentry() {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_ID || undefined,
    sendDefaultPii: false,
    attachStacktrace: true,
    defaultIntegrations: false,
    integrations: [Sentry.browserTracingIntegration(), Sentry.linkedErrorsIntegration()],
    tracesSampleRate: 0.1,
    tracePropagationTargets: [
      /^\/v1\//,
      new RegExp('^' + window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/v1/'),
    ],
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.contexts;
      if (event.message) event.message = safeSentryMessage(event.message);
      if (event.logentry) delete event.logentry;
      // Keep meaningful exception text while scrubbing all private inputs.
      for (const item of event.exception?.values ?? []) {
        item.value = safeSentryMessage(item.value) || item.type || 'ApplicationError';
        for (const frame of item.stacktrace?.frames ?? []) {
          if (frame.filename) frame.filename = frame.filename.split(/[?#]/, 1)[0];
          delete frame.context_line;
          delete frame.pre_context;
          delete frame.post_context;
          delete frame.vars;
          delete frame.abs_path;
        }
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
  // Only the method, never the URL or request body, can affect network grouping.
  const method =
    error instanceof Error &&
    'method' in error &&
    typeof error.method === 'string' &&
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(error.method)
      ? error.method
      : 'OTHER';
  const event = Sentry.captureException(original, {
    tags: { correlation_id: id, phase, service: 'photointel-web', error_kind: category },
    ...(category === 'api.network' ? { fingerprint: ['photointel', 'api.network', method] } : {}),
  });
  return EVENT.test(event) ? event.toLowerCase() : undefined;
}

export function sentryEventUrl(eventId: string): string | undefined {
  if (!EVENT.test(eventId)) return undefined;
  // An authenticated API resolver uses the Sentry API to find the exact issue/event.
  return '/v1/observability/sentry-events/' + eventId.toLowerCase();
}
