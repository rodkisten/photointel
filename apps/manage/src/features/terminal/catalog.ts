import { ApiError, json } from '../auth';
import type { Env } from '../auth';

/** Server-controlled allowlist. Never accept target addresses from browser requests. */
export function terminalCatalogRoute(request: Request, env: Env): Response | null {
  if (new URL(request.url).pathname !== '/api/terminal/catalog') return null;
  if (request.method !== 'GET') throw new ApiError(405, 'TERMINAL_METHOD', 'Método não permitido');
  const raw = env.MANAGE_TERMINAL_VMS?.trim();
  let entries: unknown = [];
  if (raw) {
    try { entries = JSON.parse(raw); }
    catch { throw new ApiError(503, 'TERMINAL_CONFIG', 'Catálogo de VMs inválido'); }
  }
  if (!Array.isArray(entries) || entries.length > 30) throw new ApiError(503, 'TERMINAL_CONFIG', 'Catálogo de VMs inválido');
  const ids = new Set<string>();
  const items = entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new ApiError(503, 'TERMINAL_CONFIG', 'Entrada de VM inválida');
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value.id) ||
        typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80 || ids.has(value.id))
      throw new ApiError(503, 'TERMINAL_CONFIG', 'Identificador ou nome de VM inválido');
    ids.add(value.id);
    // Intentionally do not return SSH hostname, user, key or internal address.
    return { id: value.id, label: value.label, kind: 'vm' as const, status: 'configured' as const };
  });
  return json({
    items,
    codespaces: {
      available: false,
      reason: 'Descoberta depende de autorização GitHub delegada ao usuário; token de instalação do App não concede acesso aos Codespaces pessoais.',
    },
  });
}
