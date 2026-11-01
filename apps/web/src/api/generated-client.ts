/** Typed client generated from FastAPI's exported OpenAPI contract. */
import createClient from 'openapi-fetch';
import type { components, paths } from './schema';
import type { AssetDetail, FilterNode, SearchPage, SearchRequest } from './types';
import { API_BASE, ApiError } from './client';
import { apiNetworkError } from './error';

export const api = createClient<paths>({
  baseUrl: API_BASE || window.location.origin,
  credentials: 'include',
  cache: 'no-store',
  fetch: async (input) => {
    try {
      return await globalThis.fetch(input);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw apiNetworkError(cause, input.method, input.url);
    }
  },
});

function fail(response: Response, body: unknown): never {
  const error = body as { error?: { message?: string; code?: string } } | undefined;
  const denied = [401, 403].includes(response.status);
  throw new ApiError(
    denied ? 'Acesso não autorizado. Entre novamente pelo Cloudflare Access.' :
      error?.error?.message ?? 'Serviço indisponível. Tente novamente.',
    response.status,
    error?.error?.code ?? `HTTP_${response.status}`,
    response.headers.get('X-Correlation-ID') ?? undefined,
    { source: response.headers.get('X-PhotoIntel-Source') === 'cloudflare' ? 'cloudflare' : 'gcp',
      rayId: response.headers.get('X-Cloudflare-Ray') ?? undefined },
  );
}

function completeFilter(node: FilterNode): components['schemas']['FilterNode'] {
  const { children, ...condition } = node;
  return {
    ...condition,
    confidence: node.confidence ?? 0,
    comparison: node.comparison ?? 'gte',
    ...(children ? { children: children.map(completeFilter) } : {}),
  };
}

export async function searchAssets(input: SearchRequest): Promise<SearchPage> {
  const { data, error, response } = await api.POST('/v1/search', {
    body: {
      ...input,
      minimum_similarity: input.minimum_similarity ?? 0,
      filter: input.filter ? completeFilter(input.filter) : undefined,
    },
  });
  if (!data) fail(response, error);
  return data;
}

export async function readAsset(id: string): Promise<AssetDetail> {
  const { data, error, response } = await api.GET('/v1/assets/{asset_id}', {
    params: { path: { asset_id: id } },
  });
  if (!data) fail(response, error);
  return data;
}
