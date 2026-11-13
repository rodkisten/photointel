import { ApiError, failure, json, requireOrigin, verifyAccess } from './auth';
import type { Env, Identity } from './auth';
import { api } from './api';
import { captureManageError } from './sentry';
import { manageAssetCachePolicy } from './asset-cache';
import { githubHook, cloudBuildCallback, tick } from './deploy-router/service';

// --- CONFIGURATION & CONSTANTS ---

const CONFIG = {
  WEBHOOK_HOST: 'photos-hooks.migos.club',
  PREVIEW_DOMAIN: '.workers.dev',
};

const HEADERS = {
  CACHE_CONTROL: 'Cache-Control',
  CDN_CACHE: 'CDN-Cache-Control',
  CF_CDN_CACHE: 'Cloudflare-CDN-Cache-Control',
  ROBOTS: 'X-Robots-Tag',
  CONTENT_TYPE_OPTS: 'X-Content-Type-Options',
  FRAME_OPTS: 'X-Frame-Options',
  CSP: 'Content-Security-Policy',
  REFERRER_POLICY: 'Referrer-Policy',
  CORRELATION_ID: 'X-Manage-Correlation-ID',
  EVENT_ID: 'X-Sentry-Event-ID',
};

const SECURITY_POLICIES = {
  NO_STORE: 'no-store',
  NO_SNIFF: 'nosniff',
  DENY: 'DENY',
  NO_REFERRER: 'no-referrer',
  NO_INDEX: 'noindex, nofollow, noarchive',
  CSP_PREVIEW: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  CSP_PROD: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.sentry.io; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
};

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

// --- UTILITIES ---

// Categorize top-level routes for metrics and observability
function routeGroup(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'api') return 'assets';
  return '/api/' + (segments[1] || 'unknown');
}

// Determine if an error is actionable and warrants a Sentry incident
function shouldReport(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.status >= 500 ||
    (error.code.startsWith('ACCESS_') && error.code !== 'ACCESS_REQUIRED') ||
    error.code === 'ACCESS_DENIED'
  );
}

// Inject tracing identifiers into API and static responses
function withIncidentHeaders(response: Response, correlationId: string, eventId?: string): Response {
  const headers = new Headers(response.headers);
  headers.set(HEADERS.CORRELATION_ID, correlationId);
  if (eventId) headers.set(HEADERS.EVENT_ID, eventId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Apply baseline security and edge-caching policies for static assets
function applySecurityHeaders(response: Response, isPreview: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set(HEADERS.CDN_CACHE, SECURITY_POLICIES.NO_STORE);
  headers.set(HEADERS.CF_CDN_CACHE, SECURITY_POLICIES.NO_STORE);
  headers.set(HEADERS.CONTENT_TYPE_OPTS, SECURITY_POLICIES.NO_SNIFF);
  headers.set(HEADERS.FRAME_OPTS, SECURITY_POLICIES.DENY);

  if (isPreview) {
    headers.set(HEADERS.ROBOTS, SECURITY_POLICIES.NO_INDEX);
    headers.set(HEADERS.CSP, SECURITY_POLICIES.CSP_PREVIEW);
  } else {
    headers.set(HEADERS.REFERRER_POLICY, SECURITY_POLICIES.NO_REFERRER);
    headers.set(HEADERS.CSP, SECURITY_POLICIES.CSP_PROD);
  }

  return new Response(response.body, { status: response.status, headers });
}

// --- REQUEST HANDLERS ---

// Handle isolated preview environments without exposing live backend APIs
async function handlePreview(request: Request, env: Env, location: URL): Promise<Response> {
  const path = location.pathname;
  const method = request.method.toUpperCase();

  if (!location.hostname.endsWith(CONFIG.PREVIEW_DOMAIN)) {
    return failure(403, 'PREVIEW_HOST', 'Preview hostname required');
  }
  if (path.startsWith('/api/') || path.startsWith('/hooks/') || path.startsWith('/__')) {
    return failure(404, 'PREVIEW_DISABLED', 'Preview route unavailable');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return failure(405, 'PREVIEW_READONLY', 'Preview is read-only');
  }

  const response = await env.ASSETS.fetch(request);
  const secured = applySecurityHeaders(response, true);
  secured.headers.set(HEADERS.CACHE_CONTROL, manageAssetCachePolicy(path, response));
  return secured;
}

// Route external webhooks directly to the deployment router
async function handleWebhooks(request: Request, env: Env, location: URL, context?: WorkerContext): Promise<Response> {
  const path = location.pathname;
  
  if (path === '/hooks/github') {
    if (!context) throw new ApiError(503, 'WORKER_CONTEXT', 'Context unavailable');
    return githubHook(request, env, context);
  }
  if (path === '/hooks/cloud-build') {
    return cloudBuildCallback(request, env);
  }
  
  return failure(404, 'HOOK_PATH', 'Route not found');
}

// Main application flow: authenticates, guards mutations, and routes API or ASSETS
async function handleApp(
  request: Request,
  env: Env,
  location: URL,
  correlationId: string,
  report: (error: unknown, provider?: string) => string | undefined
): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = location.pathname;

  const identity = await verifyAccess(request, env);
  
  // Protect mutations from CSRF globally
  if (method !== 'GET' && method !== 'HEAD') {
    requireOrigin(request);
  }

  // Dispatch live API operations
  if (path.startsWith('/api/')) {
    return api(request, env, identity, report, correlationId);
  }

  // Fallback blocks non-GET static asset requests
  if (method !== 'GET' && method !== 'HEAD') {
    return failure(405, 'METHOD', 'Method not allowed');
  }

  // Serve Single Page Application assets securely
  const response = await env.ASSETS.fetch(request);
  const secured = applySecurityHeaders(response, false);
  secured.headers.set(HEADERS.CACHE_CONTROL, manageAssetCachePolicy(path, response));
  return secured;
}

// --- WORKER ENTRYPOINT ---

export default {
  async fetch(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
    const location = new URL(request.url);
    const route = routeGroup(location.pathname);
    const method = request.method.toUpperCase();
    const correlationId = crypto.randomUUID();

    // Closure to track cross-boundary incident data securely
    const report = (error: unknown, provider?: string): string | undefined => {
      if (!shouldReport(error)) return undefined;
      const incident = captureManageError(env, error, { correlationId, route, method, provider });
      if (incident && context) context.waitUntil(incident.delivered);
      return incident?.eventId;
    };

    if (method === 'OPTIONS') {
      return withIncidentHeaders(failure(405, 'CORS', 'CORS desabilitado'), correlationId);
    }

    let response: Response;
    let eventId: string | undefined;

    try {
      // Route request based on execution environment topology
      if (env.PHOTOINTEL_PREVIEW === 'true') {
        response = await handlePreview(request, env, location);
      } else if (location.hostname === CONFIG.WEBHOOK_HOST) {
        response = await handleWebhooks(request, env, location, context);
      } else {
        response = await handleApp(request, env, location, correlationId, report);
      }
    } catch (error) {
      eventId = report(error);
      const status = error instanceof ApiError ? error.status : 502;
      const code = error instanceof ApiError ? error.code : 'UPSTREAM_FAILURE';
      const message = error instanceof ApiError
        ? error.message
        : 'Falha na integração. Verifique credenciais e permissões do provedor.';

      // Write error event strictly to stdout (omit secrets and raw stacks)
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

      response = json({
        error: code,
        message,
        correlation_id: correlationId,
        sentry_event_id: eventId || null,
      }, status);
    }

    return withIncidentHeaders(response, correlationId, eventId);
  },

  async scheduled(_event: unknown, env: Env, context: WorkerContext): Promise<void> {
    if (env.PHOTOINTEL_PREVIEW === 'true') return;
    context.waitUntil(tick(env));
  },
};
