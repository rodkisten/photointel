/** Same-origin requests; Cloudflare Access cookies never enter application storage. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUi } from '../lib/store';
import { reportDiagnostic } from '../lib/diagnostics';
import { ApiError, apiNetworkError, isRequestAbort, responseError } from './error';

// Re-export ApiError for consumer convenience
export { ApiError } from './error';

// --- TYPES & INTERFACES ---

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ActionPayload {
  url?: string;
  body?: unknown;
}

export interface UseActionOptions {
  /** Specific React Query keys to invalidate on success. If empty, invalidates ALL queries. */
  invalidateKeys?: unknown[][]; 
}

// --- CONFIGURATION & CONSTANTS ---

export const API_CONFIG = {
  BASE_URL: (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, ''),
  MAX_RETRIES: 2,
  // Using a Set for O(1) lookups. Statuses that represent client errors or auth failures shouldn't be retried.
  NON_RETRYABLE_STATUSES: new Set([401, 403, 422]),
  DEFAULT_MUTATION_METHOD: 'POST' as HttpMethod,
  DEFAULT_QUERY_METHOD: 'GET' as HttpMethod,
  HTTP_STATUS_NO_CONTENT: 204,
} as const;

/** Backward-compatible base URL for generated OpenAPI client. */
export const API_BASE = API_CONFIG.BASE_URL;

// --- CORE UTILITIES ---

export const apiUrl = (path: string): string => `${API_CONFIG.BASE_URL}${path}`;

export const json = (method: HttpMethod, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

/** 
 * Type-safe fetch wrapper for JSON APIs.
 * Automatically handles Cloudflare Access cookies (same-origin), headers, and error parsing. 
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const method = (init?.method as HttpMethod) ?? API_CONFIG.DEFAULT_QUERY_METHOD;

  try {
    response = await fetch(apiUrl(path), {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: { 
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}), 
        ...init?.headers 
      },
    });
  } catch (cause) {
    // A canceled request (navigation, query invalidation) is not a network outage.
    if (isRequestAbort(cause)) throw cause;
    throw apiNetworkError(cause, method, path);
  }

  if (!response.ok) {
    throw await responseError(response, path, method);
  }

  return response.status === API_CONFIG.HTTP_STATUS_NO_CONTENT 
    ? (undefined as T) 
    : ((await response.json()) as T);
}

// --- REACT QUERY HOOKS ---

/** 
 * Data fetching hook. Automatically caches, deduplicates, and retries safely. 
 */
export function useApi<T>(path: string, interval?: number) {
  return useQuery({
    queryKey: [path],
    queryFn: () => request<T>(path),
    refetchInterval: interval,
    retry: (failureCount, error) => {
      // Do not retry if the error is a definitive client/auth rejection
      if (
        error instanceof ApiError && 
        API_CONFIG.NON_RETRYABLE_STATUSES.has(error.status)
      ) {
        return false;
      }
      return failureCount < API_CONFIG.MAX_RETRIES;
    },
  });
}

/** 
 * Mutation hook for data modification (POST, PUT, DELETE, etc.).
 * Features global error notification and automatic query invalidation.
 */
export function useAction<T = unknown>(
  path?: string, 
  method: HttpMethod = API_CONFIG.DEFAULT_MUTATION_METHOD,
  options?: UseActionOptions
) {
  const client = useQueryClient();
  const notify = useUi((state) => state.notify);

  return useMutation({
    mutationFn: ({ url, body }: ActionPayload) => {
      const targetUrl = url ?? path;
      if (!targetUrl) throw new Error('Operação sem destino');
      
      return request<T>(targetUrl, json(method, body));
    },
    onSuccess: () => {
      // If specific keys are provided, invalidate only them to save bandwidth/renders.
      // Otherwise, fallback to invalidating everything (shotgun approach).
      if (options?.invalidateKeys && options.invalidateKeys.length > 0) {
        options.invalidateKeys.forEach(queryKey => {
          void client.invalidateQueries({ queryKey });
        });
      } else {
        void client.invalidateQueries();
      }
    },
    onError: (error) => {
      notify(
        error instanceof Error ? error.message : 'Falha na operação',
        'error',
        reportDiagnostic(error, 'api'),
        error instanceof Error ? error : undefined,
      );
    },
  });
}
