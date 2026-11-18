import { ApiError, requireOrigin } from '../../auth';
import type { Env, Identity } from '../../auth';
import { vmTargets } from './protocol';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LIST_BYTES = 256 * 1024;
type FileOperation = 'list' | 'read' | 'write';

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 2048 &&
    path.startsWith('/') && !path.includes('\\0') && !/[\\x00-\\x1f]/.test(path) &&
    !path.split('/').some(segment => segment === '..' || segment === '.');
}

/**
 * Authenticated same-origin file bridge. Only allowlisted VM IDs are accepted.
 * The gateway must enforce SSH host-key pinning, filesystem permissions,
 * atomic conditional writes, and its own session authorization.
 */
export async function terminalFilesRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/terminal/files') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'TERMINAL_FILES_METHOD', 'Método não permitido');
  requireOrigin(request);
  if (!identity.email) throw new ApiError(403, 'TERMINAL_FILES_AUTH', 'Identidade não autorizada');
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json')
    throw new ApiError(415, 'TERMINAL_FILES_TYPE', 'Use application/json');
  const raw = await request.text();
  if (raw.length > MAX_TEXT_BYTES * 2) throw new ApiError(413, 'TERMINAL_FILES_LIMIT', 'Requisição muito grande');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ApiError(400, 'TERMINAL_FILES_JSON', 'JSON inválido'); }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'TERMINAL_FILES_BODY', 'Corpo inválido');
  const body = value as Record<string, unknown>;
  const operation = body.operation as FileOperation;
  if (!['list', 'read', 'write'].includes(operation) || typeof body.targetId !== 'string' || !validPath(body.path))
    throw new ApiError(400, 'TERMINAL_FILES_BODY', 'Operação, destino ou caminho inválido');
  if (!vmTargets(env).some(target => target.id === body.targetId))
    throw new ApiError(404, 'TERMINAL_FILES_TARGET', 'VM não autorizada');
  if (operation === 'write' && (typeof body.content !== 'string' ||
      new TextEncoder().encode(body.content).length > MAX_TEXT_BYTES ||
      typeof body.version !== 'string' || !body.version || body.version.length > 256))
    throw new ApiError(400, 'TERMINAL_FILES_WRITE', 'Conteúdo ou versão inválidos');
  if (operation !== 'write' && ('content' in body || 'version' in body))
    throw new ApiError(400, 'TERMINAL_FILES_BODY', 'Campos extras não permitidos');
  if (!env.MANAGE_TERMINAL_GATEWAY_URL || !env.MANAGE_TERMINAL_GATEWAY_SECRET ||
      env.MANAGE_TERMINAL_GATEWAY_SECRET.length < 32)
    throw new ApiError(503, 'TERMINAL_FILES_GATEWAY', 'Gateway SSH não configurado');
  let gateway: URL;
  try { gateway = new URL(env.MANAGE_TERMINAL_GATEWAY_URL); }
  catch { throw new ApiError(503, 'TERMINAL_FILES_GATEWAY', 'Gateway inválido'); }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash)
    throw new ApiError(503, 'TERMINAL_FILES_GATEWAY', 'Gateway HTTPS inválido');
  if (!env.MANAGE_TERMINAL_ACCESS_CLIENT_ID || !env.MANAGE_TERMINAL_ACCESS_CLIENT_SECRET)
    throw new ApiError(503, 'TERMINAL_FILES_ACCESS', 'Credenciais Cloudflare Access não configuradas');
  const endpoint = new URL('/files', gateway);
  const upstream = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Terminal-Gateway-Secret': env.MANAGE_TERMINAL_GATEWAY_SECRET,
      'CF-Access-Client-Id': env.MANAGE_TERMINAL_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.MANAGE_TERMINAL_ACCESS_CLIENT_SECRET,
    },
    body: JSON.stringify({ operation, targetId: body.targetId, path: body.path,
      subject: identity.email, ...(operation === 'write' ? { content: body.content, version: body.version } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok) {
    const status = [400, 403, 404, 409, 413, 423, 503].includes(upstream.status) ? upstream.status : 502;
    throw new ApiError(status, 'TERMINAL_FILES_UPSTREAM',
      status === 409 ? 'Arquivo alterado remotamente. Recarregue antes de salvar.' : 'Operação de arquivo remoto falhou');
  }
  const length = Number(upstream.headers.get('Content-Length') || 0);
  if (length > MAX_TEXT_BYTES * 2) throw new ApiError(502, 'TERMINAL_FILES_SIZE', 'Resposta muito grande');
  const result = await upstream.text();
  if (result.length > (operation === 'list' ? MAX_LIST_BYTES : MAX_TEXT_BYTES * 2))
    throw new ApiError(502, 'TERMINAL_FILES_SIZE', 'Resposta muito grande');
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { throw new ApiError(502, 'TERMINAL_FILES_RESPONSE', 'Resposta inválida'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ApiError(502, 'TERMINAL_FILES_RESPONSE', 'Resposta inválida');
  const payload = parsed as Record<string, unknown>;
  if (operation === 'list' && (!Array.isArray(payload.entries) || payload.entries.length > 1000 ||
    !payload.entries.every(entry => entry && typeof entry === 'object' &&
      typeof entry.name === 'string' && entry.name.length <= 255 &&
      (entry.kind === 'file' || entry.kind === 'directory'))))
    throw new ApiError(502, 'TERMINAL_FILES_RESPONSE', 'Listagem inválida');
  if (operation === 'read' && (typeof payload.content !== 'string' || typeof payload.version !== 'string' ||
    !payload.version || new TextEncoder().encode(payload.content).length > MAX_TEXT_BYTES))
    throw new ApiError(502, 'TERMINAL_FILES_RESPONSE', 'Arquivo inválido');
  if (operation === 'write' && (typeof payload.version !== 'string' || !payload.version))
    throw new ApiError(502, 'TERMINAL_FILES_RESPONSE', 'Versão inválida');
  return new Response(JSON.stringify(parsed), { headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
