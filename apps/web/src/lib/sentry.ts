/** Frontend Sentry: consent-free diagnostics, but no personal/photo data. */
import * as Sentry from '@sentry/react';

const EVENT = /^[a-f0-9]{32}$/i;
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

export function initSentry() {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_ID || undefined,
    sendDefaultPii: false,
    attachStacktrace: true,
    defaultIntegrations: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    tracePropagationTargets: [/^\/v1\//, new RegExp('^' +
      window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/v1/')],
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.contexts;
      // Suppress potentially private exception messages and frame context.
      for (const item of event.exception?.values ?? []) {
        item.value = item.type || 'ApplicationError';
        for (const frame of item.stacktrace?.frames ?? []) {
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
  error: unknown, id: string, phase: string, category: string,
): string | undefined {
  if (!Sentry.isEnabled()) return undefined;
  const original = error instanceof Error ? error : new Error('Unknown browser exception');
  // Only the method, never the URL or request body, can affect network grouping.
  const method = error instanceof Error && 'method' in error &&
    typeof error.method === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(error.method)
    ? error.method : 'OTHER';
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
