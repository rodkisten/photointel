import { ApiError, bodyJson, json } from '../auth';
import type { Env, Identity } from '../auth';
import { createSecretVersion, listManageSecrets, previewSecret } from '../secret-manager';

/** Isolated route for version-only Secret Manager changes. */
export async function secretRoutes(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/api/secrets' && method === 'GET')
    return json(await listManageSecrets(env));

  const match = /^\/api\/secrets\/(MANAGE_[A-Z0-9_]+)\/(preview|versions)$/.exec(path);
  if (!match) return null;
  const key = match[1];
  if (match[2] === 'preview' && method === 'GET')
    return json(await previewSecret(env, identity, key));
  if (match[2] === 'versions' && method === 'POST') {
    const input = await bodyJson<Record<string, unknown>>(request, 8000);
    if (input.key !== key)
      throw new ApiError(422, 'SECRET_KEY', 'O secret solicitado não corresponde ao formulário');
    return json(await createSecretVersion(env, identity, input), 201);
  }
  throw new ApiError(405, 'METHOD', 'Método não permitido');
}
