/** Same-origin Manage gateway to the dedicated Cloud Run Apple login endpoints.
 *
 * Browser never contacts Cloud Run directly and never sees an Access JWT,
 * API credential, or the private Cloud Run service URL.
 * Password and 2FA code are forwarded only over TLS, never to GitHub,
 * Cloudflare environment variables, logs, Sentry or analytics.
 */

import { ApiError, bodyJson, json } from '../auth';
import type { Env, Identity } from '../auth';
import { gcp, gcpBase } from '../providers';

const MAX_PASSWORD = 512;
const MAX_CHALLENGE = 750_000;
const CODE = /^[0-9]{6}$/;

export async function icloudAuthRoute(
  request: Request,
  env: Env,
  identity: Identity,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/icloud/auth/start' && path !== '/api/icloud/auth/verify') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD', 'Use POST');
  const phase = path.endsWith('/start') ? 'start' : 'verify';
  const payload = await bodyJson<Record<string, unknown>>(request, 850_000);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError(422, 'INPUT', 'Dados inválidos');
  }
  let outgoing: Record<string, string>;
  if (phase === 'start') {
    if (typeof payload.password !== 'string' || payload.password.length < 1 || payload.password.length > MAX_PASSWORD) {
      throw new ApiError(422, 'PASSWORD', 'Informe a senha da conta Apple');
    }
    outgoing = { password: payload.password };
  } else {
    if (
      typeof payload.challenge !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(payload.challenge) ||
      payload.challenge.length < 32 ||
      payload.challenge.length > MAX_CHALLENGE ||
      typeof payload.code !== 'string' ||
      !CODE.test(payload.code)
    ) {
      throw new ApiError(422, 'VERIFICATION', 'Digite o código Apple de seis dígitos');
    }
    outgoing = { challenge: payload.challenge, code: payload.code };
  }

  // Service URI is discovered through the authenticated GCP control plane,
  // not from a client-provided URL. Strictly reject any non-Cloud Run origin.
  const service = (await gcp(env, identity, gcpBase(env) + '/services/photointel-api')) as {
    uri?: string;
  };
  const url = new URL(service.uri || 'https://invalid.invalid/');
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.run.app') ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(503, 'API_ORIGIN', 'Cloud Run não retornou uma origem de API válida');
  }
  url.pathname = '/v1/ingestion/web-auth/' + phase;

  let response: Response;
  try {
    response = await fetch(url.href, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'Cf-Access-Jwt-Assertion': identity.jwt,
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(outgoing),
      signal: AbortSignal.timeout(95_000),
    });
  } catch {
    throw new ApiError(
      503, 'APPLE_BACKEND', 'A API do PhotoIntel não respondeu. Confira o deploy e tente novamente.',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, 'UPSTREAM_REDIRECT', 'Redirecionamento inesperado da API');
  }
  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    throw new ApiError(502, 'UPSTREAM_JSON', 'Resposta inválida da API do PhotoIntel');
  }
  if (!response.ok) {
    const detail = result.error && typeof result.error === 'object'
      ? result.error as Record<string, unknown> : {};
    const allowedMessage = typeof detail.message === 'string' && detail.message.length <= 240
      ? detail.message : 'A autenticação Apple não foi concluída.';
    const allowedCode = typeof detail.code === 'string' && /^[A-Z_]{2,64}$/.test(detail.code)
      ? detail.code : 'ICLOUD_AUTH_ERROR';
    throw new ApiError(response.status >= 500 ? 503 : response.status, allowedCode, allowedMessage);
  }
  if (!['connected', 'verification_required'].includes(String(result.state || ''))) {
    throw new ApiError(502, 'UPSTREAM_STATE', 'Estado de autenticação inesperado');
  }
  const safe = result.state === 'connected'
    ? {
        state: 'connected', valid: true, session_published: true,
        checked_at: result.checked_at, library: result.library, message: result.message,
      }
    : {
        state: 'verification_required', mode: result.mode,
        challenge: result.challenge, expires_in: result.expires_in, message: result.message,
      };
  return json(safe);
}
