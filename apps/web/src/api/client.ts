/** Same-origin requests; Cloudflare Access cookies never enter application storage. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUi } from '../lib/store';
import { ApiError, responseError } from './error';
export { ApiError } from './error';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export const apiUrl = (path: string) => `${API_BASE}${path}`;

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init, credentials: 'include', cache: 'no-store',
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers },
    });
  } catch (cause) {
    throw new ApiError('Não foi possível conectar ao PhotoIntel.', 0, 'NETWORK_ERROR',
      undefined, { method: init?.method ?? 'GET', path, cause, source: 'cloudflare' });
  }
  if (!response.ok) throw await responseError(response, path, init?.method ?? 'GET');
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export const json = (method: string, body?: unknown): RequestInit => ({
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export function useApi<T>(path: string, interval?: number) {
  return useQuery({ queryKey: [path], queryFn: () => request<T>(path),
    refetchInterval: interval, retry: (count, error) =>
      !(error instanceof ApiError && [401, 403, 422].includes(error.status)) && count < 2 });
}
export function useAction<T = unknown>(path?: string, method = 'POST') {
  const client = useQueryClient();
  const notify = useUi((state) => state.notify);
  return useMutation({
    mutationFn: ({ url, body }: { url?: string; body?: unknown }) => {
      if (!url && !path) throw new Error('Operação sem destino');
      return request<T>(url ?? path!, json(method, body));
    },
    onSuccess: () => { void client.invalidateQueries(); },
    onError: (error) => notify(error.toString(), 'error'),
  });
}

