import { ApiError, json, requireOrigin } from '../../auth';
import type { Env, Identity } from '../../auth';
import { vmTargets } from './protocol';

const SESSION_MAX_AGE_SECONDS = 60;
const SESSION_LIMIT = 3;

/**
 * Preflight checks only. Session tickets are issued separately after gateway configuration.
 * This endpoint must never leak SSH addresses, usernames, keys or fingerprints.
 */
export async function terminalPreflightRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/terminal/preflight') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'TERMINAL_METHOD', 'Método não permitido');
  requireOrigin(request);
  if (!identity.email) throw new ApiError(403, 'TERMINAL_IDENTITY', 'Identidade não autorizada');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')
    throw new ApiError(415, 'TERMINAL_CONTENT_TYPE', 'Use application/json');
  if (Number(request.headers.get('Content-Length') || 0) > 1024)
    throw new ApiError(413, 'TERMINAL_BODY_LIMIT', 'Corpo excede limite');
  const raw = await request.text();
  if (raw.length > 1024) throw new ApiError(413, 'TERMINAL_BODY_LIMIT', 'Corpo excede limite');
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new ApiError(400, 'TERMINAL_BODY', 'JSON inválido'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new ApiError(400, 'TERMINAL_BODY', 'Corpo inválido');
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || typeof value.targetId !== 'string')
    throw new ApiError(400, 'TERMINAL_TARGET', 'Informe apenas targetId');
  if (!vmTargets(env).some(vm => vm.id === value.targetId))
    throw new ApiError(404, 'TERMINAL_TARGET', 'VM não autorizada');
  const gateway = env.MANAGE_TERMINAL_GATEWAY_URL;
  const secret = env.MANAGE_TERMINAL_GATEWAY_SECRET;
  if (!gateway || !secret || secret.length < 32) return json({
    ready: false, code: 'TERMINAL_GATEWAY_NOT_CONFIGURED',
    message: 'Destino autorizado, mas o gateway SSH ainda não está configurado.',
    requirements: { maxSessionAgeSeconds: SESSION_MAX_AGE_SECONDS, maxConcurrentSessions: SESSION_LIMIT },
  }, 503);
  let gatewayUrl: URL;
  try { gatewayUrl = new URL(gateway); }
  catch { throw new ApiError(503, 'TERMINAL_GATEWAY', 'URL do gateway inválida'); }
  if (gatewayUrl.protocol !== 'https:' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash)
    throw new ApiError(503, 'TERMINAL_GATEWAY', 'URL do gateway inválida');
  return json({
    ready: true,
    message: 'Destino autorizado e gateway configurado. A conexão será validada ao abrir a sessão.',
    requirements: { maxSessionAgeSeconds: SESSION_MAX_AGE_SECONDS, maxConcurrentSessions: SESSION_LIMIT },
  });
}
