import { ApiError, json, requireOrigin } from '../../auth';
import type { Env, Identity } from '../../auth';

export type VmTarget = { id: string; label: string; host: string; port: number; username: string; hostKeySha256: string };
const idPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

/** A strict server-only allowlist. Reject partial SSH configurations rather than downgrading security. */
export function vmTargets(env: Env): VmTarget[] {
  if (!env.MANAGE_TERMINAL_VMS?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(env.MANAGE_TERMINAL_VMS); }
  catch { throw new ApiError(503, 'TERMINAL_CONFIG', 'JSON de VMs inválido'); }
  if (!Array.isArray(parsed) || parsed.length > 30) throw new ApiError(503, 'TERMINAL_CONFIG', 'Catálogo de VMs inválido');
  const seen = new Set<string>();
  return parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ApiError(503, 'TERMINAL_CONFIG', 'VM inválida');
    const vm = entry as Record<string, unknown>;
    if (typeof vm.id !== 'string' || !idPattern.test(vm.id) || seen.has(vm.id) ||
        typeof vm.label !== 'string' || !vm.label.trim() || vm.label.length > 80 ||
        typeof vm.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(vm.host) ||
        typeof vm.port !== 'number' || !Number.isInteger(vm.port) || vm.port < 1 || vm.port > 65535 ||
        typeof vm.username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(vm.username) ||
        typeof vm.hostKeySha256 !== 'string' || !fingerprintPattern.test(vm.hostKeySha256))
      throw new ApiError(503, 'TERMINAL_CONFIG', 'VM requer id, label, host, port, username e hostKeySha256 válidos');
    seen.add(vm.id);
    return vm as VmTarget;
  });
}

/** Session intent is authenticated and validated, but never creates a live shell without a gateway. */
export async function terminalSessionRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/terminal/session') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'TERMINAL_METHOD', 'Método não permitido');
  requireOrigin(request);
  if (!identity.email) throw new ApiError(403, 'TERMINAL_IDENTITY', 'Identidade não autorizada');
  // The actual gateway must enforce pinned host keys, per-session auth, replay protection,
  // idle timeouts and session quotas. Do not issue a reusable browser-side credential.
  return json({
    ready: false,
    code: 'TERMINAL_GATEWAY_NOT_CONFIGURED',
    message: 'Gateway SSH ainda não provisionado. Nenhuma conexão será iniciada.',
  }, 503);
}

/** Future protocol. Never accept a client-provided host, username, port or fingerprint. */
export type TerminalClientFrame =
  | { type: 'stdin'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };
export type TerminalServerFrame =
  | { type: 'ready' }
  | { type: 'stdout'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export function validateTerminalFrame(value: unknown): TerminalClientFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'TERMINAL_FRAME', 'Frame inválido');
  const frame = value as Record<string, unknown>;
  if (frame.type === 'ping' && Object.keys(frame).length === 1) return { type: 'ping' };
  if (frame.type === 'stdin' && Object.keys(frame).length === 2 && typeof frame.data === 'string' && new TextEncoder().encode(frame.data).length <= 8192)
    return { type: 'stdin', data: frame.data };
  if (frame.type === 'resize' && Object.keys(frame).length === 3 && Number.isInteger(frame.cols) && Number.isInteger(frame.rows) &&
      (frame.cols as number) >= 20 && (frame.cols as number) <= 500 &&
      (frame.rows as number) >= 5 && (frame.rows as number) <= 200)
    return { type: 'resize', cols: frame.cols as number, rows: frame.rows as number };
  throw new ApiError(400, 'TERMINAL_FRAME', 'Frame inválido ou excede limites');
}
