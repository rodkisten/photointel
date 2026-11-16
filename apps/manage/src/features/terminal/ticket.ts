import { ApiError, json, requireOrigin } from '../../auth';
import type { Env, Identity } from '../../auth';
import { vmTargets } from './protocol';

const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}
async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))));
}
export async function terminalTicketRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/terminal/ticket') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'TERMINAL_METHOD', 'Método não permitido');
  requireOrigin(request);
  if (!env.MANAGE_TERMINAL_GATEWAY_URL || !env.MANAGE_TERMINAL_GATEWAY_SECRET || env.MANAGE_TERMINAL_GATEWAY_SECRET.length < 32)
    throw new ApiError(503, 'TERMINAL_GATEWAY', 'Gateway não configurado');
  const origin = new URL(env.MANAGE_TERMINAL_GATEWAY_URL);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
    throw new ApiError(503, 'TERMINAL_GATEWAY', 'URL do gateway inválida');
  const body = await request.text();
  if (body.length > 1024) throw new ApiError(413, 'TERMINAL_BODY', 'Corpo muito grande');
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new ApiError(400, 'TERMINAL_BODY', 'JSON inválido'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || typeof (value as { targetId?: unknown }).targetId !== 'string')
    throw new ApiError(400, 'TERMINAL_TARGET', 'Informe apenas targetId');
  const targetId = (value as { targetId: string }).targetId;
  if (!vmTargets(env).some(vm => vm.id === targetId)) throw new ApiError(404, 'TERMINAL_TARGET', 'VM não autorizada');
  const payload = base64url(encoder.encode(JSON.stringify({
    v: 1, targetId, sub: identity.email, aud: 'rod-manage-terminal', exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  })));
  const signature = await sign(payload, env.MANAGE_TERMINAL_GATEWAY_SECRET);
  return json({ ticket: payload + '.' + signature, expiresIn: 30 });
}
export async function terminalWebsocketRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/terminal/ws') return null;
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new ApiError(426, 'TERMINAL_UPGRADE', 'WebSocket necessário');
  const origin = request.headers.get('Origin');
  if (origin !== url.origin) throw new ApiError(403, 'TERMINAL_ORIGIN', 'Origem não autorizada');
  const ticket = url.searchParams.get('ticket');
  if (!ticket || ticket.length > 2048 || !/^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(ticket))
    throw new ApiError(400, 'TERMINAL_TICKET', 'Ticket inválido');
  if (!env.MANAGE_TERMINAL_GATEWAY_URL || !env.MANAGE_TERMINAL_GATEWAY_SECRET)
    throw new ApiError(503, 'TERMINAL_GATEWAY', 'Gateway não configurado');
  const destination = new URL('/ws', env.MANAGE_TERMINAL_GATEWAY_URL);
  if (destination.protocol !== 'https:') throw new ApiError(503, 'TERMINAL_GATEWAY', 'Gateway deve usar HTTPS');
  // Ticket is passed via a header to avoid leaking credentials in upstream URL logs.
  return fetch(destination.toString(), {
    headers: {
      Upgrade: 'websocket',
      'X-Terminal-Ticket': ticket,
      'X-Terminal-Gateway-Secret': env.MANAGE_TERMINAL_GATEWAY_SECRET,
    },
  });
}
