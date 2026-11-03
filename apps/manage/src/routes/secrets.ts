import { ApiError, bodyJson, json } from '../auth';
import type { Env, Identity } from '../auth';
import { gh } from '../providers';
import {
  activateSecretVersion, createSecret, createSecretVersion, listManageSecrets, listSecretVersions, previewSecret,
} from '../secret-manager';

/** All routes require Cloudflare Access allowlist and same-origin CSRF checks at the Worker boundary. */
export async function secretRoutes(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/secrets') {
    if (method === 'GET') return json(await listManageSecrets(env, identity));
    if (method === 'POST') {
      const input = await bodyJson<Record<string, unknown>>(request, 2000);
      return json(await createSecret(env, identity, input), 201);
    }
    throw new ApiError(405, 'METHOD', 'Método não permitido');
  }

  if (path === '/api/secrets/permissions') {
    if (method !== 'POST') throw new ApiError(405, 'METHOD', 'Método não permitido');
    const input = await bodyJson<{ confirm?: unknown }>(request, 300);
    if (input.confirm !== 'SINCRONIZAR IAM PHOT OINTEL')
      throw new ApiError(422, 'SECRET_PERMISSIONS_CONFIRM', 'Confirme a sincronização IAM do projeto');
    await gh(env, '/actions/workflows/gcp-bootstrap.yml/dispatches', 'POST', {
      ref: 'main', inputs: { mode: 'permissions' },
    });
    console.log(JSON.stringify({
      event: 'manage_secret_permissions_dispatch',
      operator: identity.email, workflow: 'gcp-bootstrap.yml',
    }));
    return json({ queued: true, workflow_url:
      'https://github.com/rodkisten/photointel/actions/workflows/gcp-bootstrap.yml' }, 202);
  }

  const preview = /^\/api\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\/([1-9][0-9]{0,15})\/preview$/.exec(path);
  if (preview) {
    if (method !== 'GET') throw new ApiError(405, 'METHOD', 'Método não permitido');
    return json(await previewSecret(env, identity, preview[1], preview[2]));
  }
  const activate = /^\/api\/secrets\/([A-Za-z0-9_-]{1,255})\/activate$/.exec(path);
  if (activate) {
    if (method !== 'POST') throw new ApiError(405, 'METHOD', 'Método não permitido');
    const input = await bodyJson<Record<string, unknown>>(request, 2000);
    return json(await activateSecretVersion(env, identity, activate[1], input));
  }
  const versions = /^\/api\/secrets\/([A-Za-z0-9_-]{1,255})\/versions$/.exec(path);
  if (versions) {
    if (method === 'GET')
      return json(await listSecretVersions(env, identity, versions[1], url.searchParams.get('page_token') || ''));
    if (method === 'POST') {
      const input = await bodyJson<Record<string, unknown>>(request, 150_000);
      return json(await createSecretVersion(env, identity, versions[1], input), 201);
    }
    throw new ApiError(405, 'METHOD', 'Método não permitido');
  }
  return null;
}
