/** Serializable API diagnostics; never retain request credentials or raw response HTML. */
export interface ApiErrorContext {
  method?: string;
  path?: string;
  statusText?: string;
  authStage?: string;
  details?: unknown;
  cause?: unknown;
  source?: 'cloudflare' | 'gcp';
  rayId?: string;
  eventId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function diagnosticPath(path?: string): string | undefined {
  if (!path) return undefined;
  try { return new URL(path, 'https://diagnostic.invalid').pathname; }
  catch { return undefined; }
}
function safeDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[limite de profundidade]';
  if (Array.isArray(value)) return value.map(item => safeDetails(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /password|secret|token|authorization|cookie|^input$/i.test(key)
        ? '[redigido]' : safeDetails(item, depth + 1)]));
  }
  return value;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly statusText?: string;
  readonly authStage?: string;
  readonly details?: unknown;
  readonly source: 'cloudflare' | 'gcp';
  readonly rayId?: string;
  readonly eventId?: string;

  constructor(message: string, status: number, code: string,
    correlationId?: string, context: ApiErrorContext = {}) {
    super(message, { cause: context.cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.method = context.method;
    this.path = diagnosticPath(context.path);
    this.statusText = context.statusText;
    this.authStage = context.authStage;
    this.details = safeDetails(context.details);
    this.source = context.source ?? 'gcp';
    this.rayId = context.rayId;
    this.eventId = context.eventId;
  }

  override toString(): string {
    const context = [this.status ? `HTTP ${this.status}` : 'sem resposta HTTP', this.code,
      [this.method, this.path].filter(Boolean).join(' '),
      this.authStage && `auth=${this.authStage}`, this.correlationId && `ID ${this.correlationId}`,
    ].filter(Boolean).join(' · ');
    return `${this.name}: ${this.message} (${context})`;
  }

  toJSON() {
    return { name: this.name, message: this.message, status: this.status,
      statusText: this.statusText, code: this.code, method: this.method, path: this.path,
      authStage: this.authStage, correlationId: this.correlationId, details: this.details,
      source: this.source, rayId: this.rayId, eventId: this.eventId,
      cause: this.cause instanceof Error ? { name: this.cause.name, message: this.cause.message } : undefined,
    };
  }
}

export async function responseError(response: Response, path: string, method = 'GET'): Promise<ApiError> {
  const fallback = response.status === 401 || response.status === 403
    ? 'Acesso não autorizado. Entre novamente pelo Cloudflare Access.'
    : 'Serviço indisponível. Tente novamente.';
  let payload: Record<string, unknown> = {};
  try { payload = record(await response.json()); }
  catch { /* An Access HTML page is not an API error object. */ }
  const error = record(payload.error);
  const detail = payload.detail;
  const validation = Array.isArray(detail) ? detail.map(item => {
    const entry = record(item);
    return { loc: entry.loc, msg: entry.msg, type: entry.type };
  }) : undefined;
  const validationMessage = validation?.map(item =>
    [Array.isArray(item.loc) ? item.loc.join('.') : '', nonempty(item.msg)]
      .filter(Boolean).join(': ')).filter(Boolean).join('; ');
  const message = nonempty(error.message) ?? nonempty(detail) ?? nonempty(payload.message)
    ?? nonempty(validationMessage) ?? fallback;
  return new ApiError(message, response.status, nonempty(error.code) ?? `HTTP_${response.status}`,
    response.headers.get('X-Correlation-ID') ?? nonempty(error.correlation_id), {
      method, path, statusText: response.statusText,
      authStage: response.headers.get('X-PhotoIntel-Auth') ?? undefined,
      details: error.details ?? validation,
      source: response.headers.get('X-PhotoIntel-Source') === 'cloudflare' ? 'cloudflare' : 'gcp',
      rayId: response.headers.get('X-Cloudflare-Ray') ?? undefined,
      eventId: response.headers.get('X-Sentry-Event-ID') ?? nonempty(error.sentry_event_id),
    });
}
