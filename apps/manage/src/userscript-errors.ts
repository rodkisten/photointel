import { ApiError, json, type D1Binding, type Identity } from './auth';
import type { Env } from './auth';

const REPOSITORY = 'rodkisten/userscripts-cf';
const MAX_PAYLOAD_BYTES = 24_000;
const MAX_TEXT = 8_000;
const MAX_BODY = 2_000;
const RATE_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_IP = 120;
const FINGERPRINT_COOLDOWN_MS = 5_000;
const ingestRate = new Map<string, { started: number; count: number; lastAccepted: number }>();

type ErrorPayload = {
  fingerprint?: unknown;
  script?: unknown;
  source?: unknown;
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  count?: unknown;
  firstSeen?: unknown;
  lastSeen?: unknown;
  request?: unknown;
  response?: unknown;
  scripts?: unknown;
};

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/(Bearer\s+)[\w.~-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token|key|api_key|secret|password|authorization|session)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:password|passwd|secret|token|authorization|cookie|api[_-]?key)"?\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
}

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? sanitize(value).slice(0, max) : '';
}

function jsonPart(value: unknown): string | null {
  if (value == null) return null;
  try {
    const serialized = sanitize(JSON.stringify(value));
    return serialized.length <= 6_000 ? serialized : JSON.stringify({ preview: serialized.slice(0, MAX_BODY), truncated: true });
  } catch { return null; }
}

function rateKey(request: Request, fingerprint: string): string {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  return `${ip}|${fingerprint}`;
}

async function ensureTable(db: D1Binding): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS userscript_errors (
    fingerprint TEXT PRIMARY KEY, repository TEXT NOT NULL, script TEXT NOT NULL,
    source TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '',
    page_url TEXT NOT NULL DEFAULT '', request_json TEXT, response_json TEXT, scripts_json TEXT,
    count INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_userscript_errors_last_seen ON userscript_errors(repository, last_seen DESC)').run();
}

/** Public, anonymous ingest endpoint. It accepts bounded diagnostics only; reads remain Access protected. */
export async function ingestUserscriptError(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/error/capture') return null;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
    } });
  }
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_PAYLOAD_BYTES) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'EMPTY_BODY' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  let payload: ErrorPayload;
  try { payload = JSON.parse(raw) as ErrorPayload; }
  catch { return json({ error: 'INVALID_JSON' }, 400); }
  const message = text(payload.message);
  const script = text(payload.script, 180) || 'unknown';
  const source = text(payload.source, 100) || 'unknown';
  if (!message) return json({ error: 'MESSAGE_REQUIRED' }, 400);

  const fingerprint = text(payload.fingerprint, 200) || `${script}|${source}|${message.slice(0, 160)}`;
  const nowMs = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  for (const [key, entry] of ingestRate) if (nowMs - entry.started >= RATE_WINDOW_MS) ingestRate.delete(key);
  const ipEntry = ingestRate.get(`ip:${ip}`) || { started: nowMs, count: 0, lastAccepted: 0 };
  if (nowMs - ipEntry.started >= RATE_WINDOW_MS) { ipEntry.started = nowMs; ipEntry.count = 0; }
  if (ipEntry.count >= MAX_EVENTS_PER_IP) return new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  const fingerprintKey = rateKey(request, fingerprint);
  const fingerprintEntry = ingestRate.get(fingerprintKey) || { started: nowMs, count: 0, lastAccepted: 0 };
  if (nowMs - fingerprintEntry.started >= RATE_WINDOW_MS) { fingerprintEntry.started = nowMs; fingerprintEntry.count = 0; fingerprintEntry.lastAccepted = 0; }
  if (nowMs - fingerprintEntry.lastAccepted < FINGERPRINT_COOLDOWN_MS) return new Response(JSON.stringify({ ok: true, deduplicated: true }), { status: 202, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  ipEntry.count++;
  fingerprintEntry.count++;
  fingerprintEntry.lastAccepted = nowMs;
  ingestRate.set(`ip:${ip}`, ipEntry);
  ingestRate.set(fingerprintKey, fingerprintEntry);
  if (ingestRate.size > 5_000) {
    let removed = 0;
    for (const key of ingestRate.keys()) {
      ingestRate.delete(key);
      if (++removed >= 2_500) break;
    }
  }
  const now = new Date().toISOString();
  const firstSeen = text(payload.firstSeen, 40) || now;
  const lastSeen = text(payload.lastSeen, 40) || now;
  if (!env.DEPLOY_DB) return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  await ensureTable(env.DEPLOY_DB);
  await env.DEPLOY_DB.prepare(`INSERT INTO userscript_errors
    (fingerprint, repository, script, source, message, stack, page_url, request_json, response_json, scripts_json, count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      message=excluded.message, stack=excluded.stack, page_url=excluded.page_url,
      request_json=excluded.request_json, response_json=excluded.response_json, scripts_json=excluded.scripts_json,
      count=MAX(userscript_errors.count, excluded.count), last_seen=excluded.last_seen`)
    .bind(fingerprint, REPOSITORY, script, source, message, text(payload.stack), text(payload.url, 2_000),
      jsonPart(payload.request), jsonPart(payload.response), jsonPart(payload.scripts),
      Math.max(1, Math.min(1_000_000, Number(payload.count) || 1)), firstSeen, lastSeen).run();
  await env.DEPLOY_DB.prepare(`DELETE FROM userscript_errors WHERE fingerprint IN (
    SELECT fingerprint FROM userscript_errors WHERE repository = ? ORDER BY last_seen DESC LIMIT -1 OFFSET 2000
  )`).bind(REPOSITORY).run();
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: {
    'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
  } });
}

type ErrorRow = {
  fingerprint: string; repository: string; script: string; source: string; message: string;
  stack: string; page_url: string; request_json: string | null; response_json: string | null;
  scripts_json: string | null;
  count: number; first_seen: string; last_seen: string;
};

export async function userscriptErrorsRoute(request: Request, env: Env, _identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/userscript-errors') return null;
  if (request.method !== 'GET') throw new ApiError(405, 'METHOD', 'Método não permitido');
  const repository = url.searchParams.get('repository');
  if (repository !== REPOSITORY) throw new ApiError(403, 'PROJECT_SCOPE', 'Logs disponíveis somente para userscripts');
  if (!env.DEPLOY_DB) throw new ApiError(503, 'D1_MISSING', 'Banco DEPLOY_DB não configurado');
  await ensureTable(env.DEPLOY_DB);
  const result = await env.DEPLOY_DB.prepare(`SELECT * FROM userscript_errors WHERE repository = ? ORDER BY last_seen DESC LIMIT 250`)
    .bind(REPOSITORY).all<ErrorRow>();
  return json({ repository: REPOSITORY, items: result.results.map(row => ({
    fingerprint: row.fingerprint, script: row.script, source: row.source, message: row.message,
    stack: row.stack, url: row.page_url, request: row.request_json ? JSON.parse(row.request_json) : null,
    response: row.response_json ? JSON.parse(row.response_json) : null,
    scripts: row.scripts_json ? JSON.parse(row.scripts_json) : [], count: row.count,
    firstSeen: row.first_seen, lastSeen: row.last_seen,
  })) });
}
