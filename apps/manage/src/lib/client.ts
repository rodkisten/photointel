export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiError('Resposta do servidor inválida', 'INVALID_RESPONSE', response.status);
  }
  if (!response.ok) {
    const details = result as { message?: string; error?: string };
    throw new ApiError(details.message || 'Falha na operação', details.error || 'API_ERROR', response.status);
  }
  return result as T;
}
export const send = <T>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') =>
  api<T>(path, { method, body: JSON.stringify(body) });
