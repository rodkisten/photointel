import { ApiError, bodyJson, json, requireOrigin } from './auth';
import type { Env, Identity } from './auth';
import { githubToken } from './github-app';
import { provider } from './providers';

type Repo = { id: number; name: string; full_name: string; private: boolean; archived: boolean; description: string | null; updated_at: string };
type GitHubPage = { repositories?: Repo[]; total_count?: number };
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const validRepo = (name: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name);
async function ensureTable(env: Env) {
  if (!env.DEPLOY_DB) throw new ApiError(503, 'FAVORITES_STORAGE', 'D1 não configurado');
  await env.DEPLOY_DB.prepare('CREATE TABLE IF NOT EXISTS manage_project_favorites (email TEXT NOT NULL, repository TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (email, repository))').run();
}
export async function projectCatalogRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== '/api/projects/catalog' && path !== '/api/projects/favorites') return null;
  if (path === '/api/projects/favorites') {
    await ensureTable(env);
    if (request.method === 'GET') {
      const rows = await env.DEPLOY_DB!.prepare('SELECT repository FROM manage_project_favorites WHERE email = ? ORDER BY created_at DESC').bind(identity.email).all<{ repository: string }>();
      return json({ items: rows.results.map(row => row.repository) });
    }
    if (request.method !== 'PUT') throw new ApiError(405, 'METHOD', 'Método não permitido');
    requireOrigin(request);
    const data = await bodyJson<{ repository?: unknown; favorite?: unknown }>(request, 512);
    if (typeof data.repository !== 'string' || !validRepo(data.repository) || typeof data.favorite !== 'boolean')
      throw new ApiError(400, 'FAVORITE_INPUT', 'Repositório ou favorito inválido');
    const repo = data.repository;
    const token = await githubToken(env);
    if (data.favorite) {
      await provider('https://api.github.com/repos/' + repo, token, { headers });
      await env.DEPLOY_DB!.prepare('INSERT OR IGNORE INTO manage_project_favorites (email, repository) VALUES (?, ?)').bind(identity.email, repo).run();
    } else {
      await env.DEPLOY_DB!.prepare('DELETE FROM manage_project_favorites WHERE email = ? AND repository = ?').bind(identity.email, repo).run();
    }
    return json({ repository: repo, favorite: data.favorite });
  }
  if (request.method !== 'GET') throw new ApiError(405, 'METHOD', 'Método não permitido');
  const page = Number(url.searchParams.get('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new ApiError(400, 'PAGE', 'Página inválida');
  const token = await githubToken(env);
  const app = Boolean(env.MANAGE_GITHUB_APP_ID && env.MANAGE_GITHUB_APP_INSTALLATION_ID && env.MANAGE_GITHUB_APP_PRIVATE_KEY);
  const endpoint = app
    ? 'https://api.github.com/installation/repositories?per_page=100&page=' + page
    : 'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=' + page;
  const result = await provider(endpoint, token, { headers }) as Repo[] | GitHubPage;
  const repos = Array.isArray(result) ? result : result.repositories || [];
  return json({ items: repos.map(repo => ({
    id: repo.full_name, name: repo.name, repository: repo.full_name, private: repo.private,
    archived: repo.archived, description: repo.description, updated_at: repo.updated_at,
    enabled: repo.full_name === (env.GITHUB_REPO || 'rodkisten/photointel'),
    status: repo.archived ? 'archived' : 'discovered',
  })), page, has_more: repos.length === 100, source: app ? 'installation' : 'user' });
}
