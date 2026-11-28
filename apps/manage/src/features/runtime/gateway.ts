import { ApiError, bodyJson, json, requireOrigin, type Env, type Identity } from '../../auth';
export async function runtimeGateway(
  request: Request,
  env: Env,
  identity: Identity,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/runtime/')) return null;
  if (
    ['1', 'true'].includes(env.PHOTOINTEL_PREVIEW ?? '') ||
    !env.RODSANDBOX_RUNTIME ||
    !env.ROD_RUNTIME_CONTROL_TOKEN ||
    env.ROD_RUNTIME_CONTROL_TOKEN.length < 32
  )
    throw new ApiError(503, 'RUNTIME_UNCONFIGURED', 'Remote runtime is not enabled for this host');
  if (!['GET', 'POST'].includes(request.method))
    throw new ApiError(405, 'RUNTIME_METHOD', 'Runtime method unavailable');
  if (request.method === 'POST') requireOrigin(request);
  const suffix = url.pathname.slice('/api/runtime'.length);
  if (
    !/^\/(?:targets|status|logs|builds(?:\/[a-f0-9-]{36})?|deployments|rollbacks|operations\/[a-f0-9-]{36})$/.test(
      suffix,
    )
  )
    throw new ApiError(404, 'RUNTIME_ROUTE', 'Runtime route unavailable');
  const payload = request.method === 'POST' ? await bodyJson(request) : undefined;
  const response = await env.RODSANDBOX_RUNTIME.fetch(
    new Request('https://sandbox.internal/api/runtime' + suffix + url.search, {
      method: request.method,
      headers: {
        Authorization: 'Bearer ' + env.ROD_RUNTIME_CONTROL_TOKEN,
        'x-rod-subject': identity.email,
        'Content-Type': 'application/json',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
    }),
  );
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(502, 'RUNTIME_RESPONSE', 'Remote runtime returned an invalid response');
  }
  return json(value, response.status);
}
