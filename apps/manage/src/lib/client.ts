export class ApiError extends Error {
  readonly correlationId?: string;
  readonly sentryEventId?: string;

  constructor(
    message: string,
    public code: string,
    public status: number,
    correlationId?: string,
    sentryEventId?: string,
  ) {
    super(message);
    this.name = 'ManageApiError';
    this.correlationId = correlationId;
    this.sentryEventId = sentryEventId;
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
    throw new ApiError(
      'Resposta do servidor inválida',
      'INVALID_RESPONSE',
      response.status,
      response.headers.get('X-Manage-Correlation-ID') ?? undefined,
      response.headers.get('X-Sentry-Event-ID') ?? undefined,
    );
  }
  if (!response.ok) {
    const details = result as {
      message?: string;
      error?: string;
      correlation_id?: string;
      sentry_event_id?: string;
    };
    throw new ApiError(
      details.message || 'Falha na operação',
      details.error || 'API_ERROR',
      response.status,
      details.correlation_id ?? response.headers.get('X-Manage-Correlation-ID') ?? undefined,
      details.sentry_event_id ?? response.headers.get('X-Sentry-Event-ID') ?? undefined,
    );
  }
  return result as T;
}

export const send = <T>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') =>
  api<T>(path, { method, body: JSON.stringify(body) });
