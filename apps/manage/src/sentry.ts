/** Independent Sentry transport for the Manage Cloudflare Worker.
 * The DSN is a public ingest address. No API token is required for error capture.
 * Never upload credentials, JWTs, request bodies, email addresses or provider responses.
 */
import { ApiError } from './auth';
import type { Env } from './auth';

const SAFE_ID = /^[0-9a-f]{32}$/i;
const SAFE_ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function sentrySearchUrl(org: string | undefined, correlationId: string): string | undefined {
  if (!org || !SAFE_ORG.test(org) || !/^[a-f0-9-]{36}$/i.test(correlationId)) return undefined;
  return (
    'https://' + org + '.sentry.io/issues/?query=' + encodeURIComponent('correlation_id:' + correlationId)
  );
}

export function safeManageMessage(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
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
      !/^[a-f0-9]{12,64}$/i.test(uri.username) ||
      uri.search ||
      uri.hash ||
      !/(^|\.)sentry\.io$/.test(uri.hostname)
    )
      return undefined;
    return uri.origin + '/api/' + project + '/envelope/';
  } catch {
    return undefined;
  }
}

function safeFrames(error: unknown): Array<Record<string, string | number>> {
  if (!(error instanceof Error) || !error.stack) return [];
  return error.stack
    .split('\n')
    .slice(1, 21)
    .flatMap((line) => {
      const frame = line.trim().match(/^(?:at\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (!frame) return [];
      const filename = frame[2].split(/[?#]/, 1)[0];
      // Only application-owned bundles and first-party source paths are useful.
      const name = filename.split('/').pop() || '';
      if (!/^[\w.-]+\.(?:js|mjs|ts|tsx)$/.test(name)) return [];
      return [
        {
          filename: name,
          function: safeManageMessage(frame[1] || '<anonymous>').slice(0, 100),
          lineno: Number(frame[3]),
          colno: Number(frame[4]),
        },
      ];
    })
    .reverse();
}

export interface ManageIncident {
  eventId: string;
  correlationId: string;
  delivered: Promise<void>;
  url?: string;
}

export function captureManageError(
  env: Env,
  error: unknown,
  details: { correlationId: string; route: string; method: string; provider?: string },
): ManageIncident | undefined {
  const endpoint = manageSentryEndpoint(env.SENTRY_DSN);
  if (!endpoint) return undefined;
  const eventId = crypto.randomUUID().replace(/-/g, '');
  if (!SAFE_ID.test(eventId)) return undefined;
  const code = error instanceof ApiError ? error.code : 'UNHANDLED_EXCEPTION';
  const status = error instanceof ApiError ? error.status : 500;
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    logger: 'photointel-manage',
    fingerprint: ['manage', code, details.route, details.provider || 'runtime'],
    exception: {
      values: [
        {
          type: /^[\w.]{1,100}$/.test(name) ? name : 'Error',
          value: safeManageMessage(message) || code,
          stacktrace: { frames: safeFrames(error) },
        },
      ],
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
  const delivered = fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body: envelope,
    signal: AbortSignal.timeout(5000),
  })
    .then(() => undefined)
    .catch(() => undefined);
  return {
    eventId,
    correlationId: details.correlationId,
    delivered,
    url: sentrySearchUrl(env.SENTRY_ORG, details.correlationId),
  };
}
