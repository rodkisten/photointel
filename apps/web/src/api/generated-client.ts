/** Shared transport for the Hey API-generated client. */
import { client as api } from './hey-api/client.gen';
import { searchV1SearchPost, assetDetailV1AssetsAssetIdGet } from './hey-api/sdk.gen';
import type { components } from './schema';
import type { AssetDetail, FilterNode, SearchPage, SearchRequest } from './types';
import { API_BASE } from './client';
import { apiNetworkError, isRequestAbort, responseError } from './error';

// Preserve error payloads before the SDK consumes response bodies.
const errorResponses = new WeakMap<Response, Response>();

api.setConfig({
  baseUrl: API_BASE || window.location.origin,
  credentials: 'include',
  cache: 'no-store',
  fetch: async (input) => {
    try {
      const response = await globalThis.fetch(input);
      if (!response.ok) errorResponses.set(response, response.clone());
      return response;
    } catch (cause) {
      if (isRequestAbort(cause)) throw cause;
      const request = new Request(input);
      throw apiNetworkError(cause, request.method, request.url);
    }
  },
});

async function unwrap<T>(
  result: { data?: T; error?: unknown; response?: Response },
  path: string,
  method: string,
): Promise<T> {
  if (!result.response || !result.response.ok || result.data === undefined) {
    if (result.response) throw await responseError(errorResponses.get(result.response) ?? result.response, path, method);
    throw apiNetworkError(result.error, method, path);
  }
  return result.data;
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
  const result = await searchV1SearchPost({
    client: api,
    body: {
      ...input,
      minimum_similarity: input.minimum_similarity ?? 0,
      filter: input.filter ? completeFilter(input.filter) : undefined,
    },
  });
  return unwrap<SearchPage>(result, '/v1/search', 'POST');
}

export async function readAsset(id: string): Promise<AssetDetail> {
  const path = `/v1/assets/${encodeURIComponent(id)}`;
  const result = await assetDetailV1AssetsAssetIdGet({ client: api, path: { asset_id: id } });
  return unwrap<AssetDetail>(result, path, 'GET');
}
