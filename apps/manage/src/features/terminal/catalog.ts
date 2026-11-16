import { ApiError, json } from '../../auth';
import type { Env } from '../../auth';
import { vmTargets } from './protocol';

/** Server-controlled allowlist. Never accept target addresses from browser requests. */
export async function terminalCatalogRoute(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/terminal/catalog') return null;
  if (request.method !== 'GET') throw new ApiError(405, 'TERMINAL_METHOD', 'Método não permitido');
  const items = vmTargets(env).map(({ id, label }) => ({ id, label, kind: 'vm' as const, status: 'configured' as const }));
  const codespaces = await discoverCodespaces(env);
  return json({ items: [...items, ...codespaces.items], codespaces: codespaces.info });
}

type Codespace = { name?: string; display_name?: string; state?: string; repository?: { full_name?: string }; owner?: { login?: string } };
async function discoverCodespaces(env: Env): Promise<{
  items: Array<{ id: string; label: string; kind: 'codespace'; status: 'configured' | 'unavailable'; state: string }>;
  info: { available: boolean; reason: string };
}> {
  const empty = (reason: string) => ({ items: [], info: { available: false, reason } });
  const token = env.MANAGE_CODESPACES_USER_TOKEN?.trim();
  if (!token) return empty('Configure um token pessoal com permissão Codespaces: read para descobrir seus ambientes.');
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    const userResponse = await fetch('https://api.github.com/user', { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!userResponse.ok) return empty('Não foi possível validar a identidade GitHub do token.');
    const user = await userResponse.json() as { login?: string };
    if (user.login?.toLowerCase() !== 'rodkisten') return empty('O token configurado não pertence à conta GitHub autorizada.');
    const response = await fetch('https://api.github.com/user/codespaces?per_page=100', {
      headers, redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return empty(response.status === 403 ? 'Token sem permissão Codespaces: read.' : 'GitHub Codespaces indisponível.');
    const payload = await response.json() as { codespaces?: Codespace[] };
    const items = (Array.isArray(payload.codespaces) ? payload.codespaces : [])
      .filter((item): item is Codespace & { name: string } => typeof item.name === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(item.name) && (!item.owner?.login || item.owner.login.toLowerCase() === 'rodkisten'))
      .map(item => ({
        id: 'codespace:' + item.name,
        label: (item.display_name || item.repository?.full_name || item.name).slice(0, 80),
        kind: 'codespace' as const,
        status: item.state === 'Available' ? 'configured' as const : 'unavailable' as const,
        state: item.state || 'Unknown',
      }));
    return { items, info: { available: true, reason: items.length ? items.length + ' Codespace(s) encontrado(s)' : 'Nenhum Codespace encontrado' } };
  } catch {
    return empty('Não foi possível consultar a API do GitHub.');
  }
}
