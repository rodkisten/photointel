import { ApiError, failure, json, requireOrigin, verifyAccess } from './auth';
import type { Env } from './auth';
import { api } from './api';
import { captureManageError } from './sentry';

function routeGroup(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'api') return 'assets';
  return '/api/' + (segments[1] || 'unknown');
}

function shouldReport(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  // A missing login, invalid user input and CSRF attempts are expected client errors.
  // Invalid Access credentials and upstream token failures are actionable.
  return (
    error.status >= 500 ||
    (error.code.startsWith('ACCESS_') && error.code !== 'ACCESS_REQUIRED') ||
    error.code === 'ACCESS_DENIED'
  );
}

function withIncidentHeaders(response: Response, correlationId: string, eventId?: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Manage-Correlation-ID', correlationId);
  if (eventId) headers.set('X-Sentry-Event-ID', eventId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    context?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const route = routeGroup(path);
    const method = request.method.toUpperCase();
    // Always server-generated. Never accept correlation identifiers from the client.
    const correlationId = crypto.randomUUID();
    const report = (error: unknown, provider?: string): string | undefined => {
      if (!shouldReport(error)) return undefined;
      const incident = captureManageError(env, error, { correlationId, route, method, provider });
      if (incident && context) context.waitUntil(incident.delivered);
      return incident?.eventId;
    };
    if (method === 'OPTIONS')
      return withIncidentHeaders(failure(405, 'CORS', 'CORS desabilitado'), correlationId);
    try {
      const identity = await verifyAccess(request, env);
      if (method !== 'GET' && method !== 'HEAD') requireOrigin(request);
      if (path.startsWith('/api/')) {
        const response = await api(request, env, identity, report, correlationId);
        return withIncidentHeaders(response, correlationId);
      }
      if (!['GET', 'HEAD'].includes(method))
        return withIncidentHeaders(failure(405, 'METHOD', 'Método não permitido'), correlationId);
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set(
        'Cache-Control',
        path === '/' || path.endsWith('.html') ? 'no-store' : 'public,max-age=3600',
      );
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.sentry.io; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      );
      return withIncidentHeaders(
        new Response(response.body, { status: response.status, headers }),
        correlationId,
      );
    } catch (error) {
      const eventId = report(error);
      const status = error instanceof ApiError ? error.status : 502;
      const code = error instanceof ApiError ? error.code : 'UPSTREAM_FAILURE';
      const message =
        error instanceof ApiError
          ? error.message
          : 'Falha na integração. Verifique credenciais e permissões do provedor.';
      // Do not include secrets, upstream response bodies, JWTs, or raw stacks.
      console.error(
        JSON.stringify({
          event: 'manage_request_failed',
          code,
          kind: error instanceof Error ? error.name : 'UnknownError',
          route,
          correlation_id: correlationId,
          sentry_event_id: eventId || null,
        }),
      );
      const response = json(
        {
          error: code,
          message,
          correlation_id: correlationId,
          sentry_event_id: eventId || null,
        },
        status,
      );
      return withIncidentHeaders(response, correlationId, eventId);
    }
  },
};
