/** Manage browser Sentry. Uses only the new project's public DSN. */
import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_MANAGE_SENTRY_DSN as string | undefined;
const org = import.meta.env.VITE_MANAGE_SENTRY_ORG as string | undefined;

function safe(value: string): string {
  return value
    .replace(/\b(?:https?|ftp|s3|gs):\/\/[^\s"'<>]+/gi, '[URL redigida]')
    .replace(
      /\b(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redigido]',
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redigido]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT redigido]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email redigido]')
    .replace(/(^|[\s(])\/(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+/g, '$1[caminho redigido]')
    .slice(0, 2048);
}

export function sentryIssueSearch(correlationId: string | undefined): string | undefined {
  if (!org || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(org)) return undefined;
  if (!correlationId || !/^[a-f0-9-]{36}$/i.test(correlationId)) return undefined;
  return (
    'https://' + org + '.sentry.io/issues/?query=' + encodeURIComponent('correlation_id:' + correlationId)
  );
}

export function initManageSentry(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_MANAGE_RELEASE || undefined,
    sendDefaultPii: false,
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration()],
    attachStacktrace: true,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.contexts;
      if (event.message) event.message = safe(event.message);
      for (const exception of event.exception?.values ?? []) {
        exception.value = safe(exception.value || exception.type || 'Error');
        for (const frame of exception.stacktrace?.frames ?? []) {
          // Keep line numbers and bundle names, never full URLs or source lines.
          if (frame.filename) {
            const filename = frame.filename.split(/[?#]/, 1)[0];
            frame.filename = filename.split('/').pop() || '[redigido]';
          }
          delete frame.abs_path;
          delete frame.context_line;
          delete frame.pre_context;
          delete frame.post_context;
          delete frame.vars;
        }
      }
      return event;
    },
  });
}

export function captureManageBrowserError(error: unknown, phase: string): string | undefined {
  if (!Sentry.isEnabled()) return undefined;
  const cause = error instanceof Error ? error : new Error('Unhandled browser error');
  // Backend failures with their own Sentry event already belong to the Worker.
  if ('sentryEventId' in cause && cause.sentryEventId) return undefined;
  const correlationId = crypto.randomUUID();
  Sentry.captureException(cause, {
    tags: { service: 'photointel-manage-web', phase, correlation_id: correlationId },
  });
  return correlationId;
}
