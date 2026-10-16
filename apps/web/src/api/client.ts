/** Same-origin requests; Cloudflare Access cookies never enter application storage. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUi } from '../lib/store';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export const apiUrl = (path: string) => `${API_BASE}${path}`;

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string,
    public correlationId?: string) { super(message); this.name = 'ApiError'; }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init, credentials: 'include', cache: 'no-store',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers },
  });
  if (!response.ok) {
    let message = 'Serviço indisponível. Tente novamente.';
    let code = `HTTP_${response.status}`;
    try {
      const body = await response.json() as {
        error?: { message?: string; code?: string }; detail?: string;
      };
      message = body.error?.message ?? body.detail ?? message;
      code = body.error?.code ?? code;
    } catch { /* Access may return HTML; never expose it in the interface. */ }
    if (response.status === 401 || response.status === 403) {
      message = 'Acesso não autorizado. Entre novamente pelo Cloudflare Access.';
    }
    throw new ApiError(message, response.status, code,
      response.headers.get('X-Correlation-ID') ?? undefined);
  }
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
    onError: (error) => notify(error.message, 'error'),
  });
}
