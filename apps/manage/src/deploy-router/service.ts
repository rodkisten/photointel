import { ApiError, bodyJson, json, redact } from '../auth';
import type { Env, Identity } from '../auth';
import { cf, gh } from '../providers';
import { checkPaths, matchRules, validatePatterns, validateTarget } from './matching';
import type { DeployRule, TreeEntry } from './matching';

type Statement = {
  bind(...values: (string | number | null)[]): Statement;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};
type DB = { prepare(sql: string): Statement };
type Run = { id: string; delivery_id: string; rule_id: string; rule_name: string;
  provider: string; target: string; sha: string; state: string; provider_id: string | null;
  status_url: string | null; detail: string | null; created_at: string; updated_at: string };
type RuleRow = Omit<DeployRule, 'enabled' | 'patterns'> & { enabled: number; patterns_json: string };
type Delivery = { id: string; sha: string; changed_files: string; created_at: string };
const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const FINISHED = new Set(['success', 'failed', 'cancelled']);
const SQL_RULES = 'SELECT id,name,enabled,provider,target,patterns_json,created_at,updated_at FROM deploy_rules';
const SQL_RUNS = 'SELECT id,delivery_id,rule_id,rule_name,provider,target,sha,state,provider_id,status_url,detail,created_at,updated_at FROM deploy_runs';
const now = () => new Date().toISOString();
function db(env: Env): DB {
  if (!env.DEPLOY_DB) throw new ApiError(503, 'D1_MISSING', 'Configure DEPLOY_DB e aplique as migrations D1');
  return env.DEPLOY_DB as DB;
}
function toRule(row: RuleRow): DeployRule {
  return { id: row.id, name: row.name, enabled: row.enabled === 1,
    provider: row.provider, target: row.target, patterns: JSON.parse(row.patterns_json),
    created_at: row.created_at, updated_at: row.updated_at };
}
async function rules(database: DB): Promise<DeployRule[]> {
  const rows = await database.prepare(SQL_RULES + ' ORDER BY name LIMIT 100').all<RuleRow>();
  return rows.results.map(toRule);
}
export async function getTree(env: Env): Promise<TreeEntry[]> {
  const response = (await gh(env, '/git/trees/main?recursive=1')) as {
    truncated?: boolean; tree?: Array<{ path?: string; type?: string }> };
  if (response.truncated || !Array.isArray(response.tree))
    throw new ApiError(502, 'TREE_INCOMPLETE', 'GitHub não retornou a árvore completa; não é seguro validar caminhos');
  return response.tree.filter((x) => x.type === 'blob' || x.type === 'tree')
    .map((x) => ({ path: String(x.path || ''), type: x.type as 'blob' | 'tree' }));
}
function validatedInput(raw: Record<string, unknown>): { name: string; provider: DeployRule['provider'];
  target: string; patterns: string[]; enabled: boolean } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name))
    throw new ApiError(422, 'ROUTE_NAME', 'Nome de 1 a 80 caracteres obrigatório');
  const { provider, target } = validateTarget(raw.provider, raw.target);
  return { name, provider, target, patterns: validatePatterns(raw.patterns),
    enabled: raw.enabled === true };
}
function hookUrl(env: Env, target: string): string {
  const value = target === 'release' ? env.GCP_BUILD_WEBHOOK_RELEASE_URL : env.GCP_BUILD_WEBHOOK_PROVISION_URL;
  if (!value) throw new ApiError(503, 'GCP_BUILD_WEBHOOK', 'Configure o webhook Cloud Build ' + target + ' como secret do Worker');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cloudbuild.googleapis.com' ||
    !/^\/v1\/projects\/photointel\/(?:locations\/us-central1\/)?triggers\/[A-Za-z0-9_-]+:webhook$/.test(parsed.pathname) ||
    !parsed.searchParams.has('key') || !parsed.searchParams.has('secret') ||
    parsed.username || parsed.password || parsed.hash)
    throw new ApiError(503, 'GCP_BUILD_URL', 'Webhook Cloud Build deve pertencer ao projeto photointel');
  return value;
}
function relayUrl(env: Env): string | null {
  if (!env.XRELAY_NOTIFICATION_URL) return null;
  const u = new URL(env.XRELAY_NOTIFICATION_URL);
  if (u.protocol !== 'https:' || (!u.hostname.endsWith('.migos.club') && u.hostname !== 'migos.club') ||
    u.username || u.password || u.hash)
    throw new ApiError(503, 'RELAY_URL', 'URL do xrelay deve usar HTTPS em migos.club');
  return u.href;
}
async function notify(env: Env, run: Run, status: string): Promise<void> {
  const url = relayUrl(env);
  if (!url) return;
  const message = (status === 'success' ? '✅' : status === 'failed' ? '❌' : '🚀') +
    ' PhotoIntel ' + run.rule_name + ' · ' + status + '\n' +
    run.provider + ' · ' + run.sha.slice(0, 8) +
    (run.status_url ? '\n' + run.status_url : '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.XRELAY_NOTIFICATION_TOKEN) headers.Authorization = 'Bearer ' + env.XRELAY_NOTIFICATION_TOKEN;
  const response = await fetch(url, { method: 'POST', redirect: 'manual', headers,
    body: JSON.stringify({ action: 'send', event: 'photointel.deploy', status, text: message,
      chat_id: env.XRELAY_CHAT_ID || undefined, activity_id: run.id,
      workflow: 'Deploy Router', job: run.rule_name,
      commit: run.sha, provider: run.provider, provider_url: run.status_url }),
    signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('xrelay notification HTTP ' + response.status);
}
async function announce(env: Env, run: Run, state: string): Promise<void> {
  try { await notify(env, run, state); }
  catch { console.error(JSON.stringify({ event: 'deploy_notification_failed', run_id: run.id, state })); }
}
async function setState(database: DB, run: Run, state: string, providerId: string | null = null,
  url: string | null = null, detail: string | null = null): Promise<Run> {
  await database.prepare('UPDATE deploy_runs SET state=?,provider_id=COALESCE(?,provider_id),status_url=COALESCE(?,status_url),detail=?,updated_at=? WHERE id=?')
    .bind(state, providerId, url, detail, now(), run.id).run();
  return { ...run, state, provider_id: providerId || run.provider_id,
    status_url: url || run.status_url, detail, updated_at: now() };
}
async function dispatch(env: Env, database: DB, run: Run): Promise<void> {
  const locked = await database.prepare("UPDATE deploy_runs SET state='dispatching',updated_at=? WHERE id=? AND state='queued'")
    .bind(now(), run.id).run();
  if (locked.meta?.changes !== 1) return;
  try {
    let id: string | null = null;
    let url: string | null = null;
    if (run.provider === 'cloudflare') {
      const response = (await cf(env, '/builds/triggers/' + run.target + '/builds', 'POST',
        { commit_hash: run.sha })) as { result?: { build_uuid?: string; status?: string; build_outcome?: string } };
      id = response.result?.build_uuid || null;
      if (!id || !UUID.test(id)) throw new ApiError(502, 'CF_BUILD_ID', 'Cloudflare não retornou ID de build');
      url = 'https://dash.cloudflare.com/' + env.CLOUDFLARE_ACCOUNT_ID + '/workers-and-pages';
    } else {
      const endpoint = hookUrl(env, run.target);
      const response = await fetch(endpoint, { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'refs/heads/main', after: run.sha, run_id: run.id,
          repository: { full_name: env.GITHUB_REPO || 'rodkisten/photointel' } }),
        signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new ApiError(502, 'GCP_HOOK_FAILED', 'Cloud Build webhook HTTP ' + response.status);
      url = 'https://console.cloud.google.com/cloud-build/builds?project=photointel';
    }
    await announce(env, await setState(database, run, 'submitted', id, url), 'submitted');
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'PROVIDER_FAILURE';
    await announce(env, await setState(database, run, 'failed', null, null, code), 'failed');
  }
}
function result(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  return obj.result && typeof obj.result === 'object' ? obj.result as Record<string, unknown> : obj;
}
async function pollCloudflare(env: Env, database: DB, run: Run): Promise<void> {
  if (!run.provider_id || !UUID.test(run.provider_id)) return;
  const response = result(await cf(env, '/builds/builds/' + run.provider_id));
  const status = String(response.status || '');
  const outcome = String(response.build_outcome || '');
  const state = status === 'stopped'
    ? (outcome === 'success' ? 'success' : outcome === 'cancelled' ? 'cancelled' : 'failed')
    : status === 'running' || status === 'initializing' ? 'running' : 'submitted';
  if (state === run.state) return;
  const updated = await setState(database, run, state);
  if (FINISHED.has(state) || run.state !== 'running') await announce(env, updated, state);
}
export async function tick(env: Env): Promise<void> {
  if (!env.DEPLOY_DB) return;
  const database = db(env);
  // Dispatch records are persisted before response. A failed/crashed HTTP call
  // is deliberately NOT auto-retried: a second request could incur duplicate charges.
  const waiting = await database.prepare(SQL_RUNS + " WHERE state='queued' ORDER BY created_at LIMIT 8").all<Run>();
  for (const run of waiting.results) await dispatch(env, database, run);
  const running = await database.prepare(SQL_RUNS +
    " WHERE provider='cloudflare' AND state IN ('submitted','running') AND provider_id IS NOT NULL ORDER BY created_at LIMIT 20").all<Run>();
  for (const run of running.results) {
    try { await pollCloudflare(env, database, run); }
    catch { console.error(JSON.stringify({ event: 'deploy_poll_failed', run_id: run.id })); }
  }
}
async function changedFiles(env: Env, before: string, after: string): Promise<string[]> {
  if (!SHA.test(before) || /^0{40}$/.test(before))
    throw new ApiError(422, 'BASE_SHA', 'Push inicial sem base verificável; execute manualmente as regras');
  const response = (await gh(env, '/compare/' + before + '...' + after + '?per_page=300')) as {
    files?: Array<{ filename?: string; previous_filename?: string }>; total_commits?: number };
  if (!Array.isArray(response.files) || response.files.length >= 300)
    throw new ApiError(422, 'DIFF_TRUNCATED', 'Diff do GitHub está incompleto ou muito grande; não executado');
  return [...new Set(response.files.flatMap((file) => [file.filename, file.previous_filename])
    .filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, 500);
}
async function validSignature(request: Request, secret: string, body: string): Promise<boolean> {
  const signature = request.headers.get('X-Hub-Signature-256') || '';
  if (!secret || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g) || [], (x) => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', key, bytes as BufferSource, new TextEncoder().encode(body));
}
export async function githubHook(request: Request, env: Env, context: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD', 'Webhook requer POST');
  if (!env.GITHUB_WEBHOOK_SECRET) throw new ApiError(503, 'WEBHOOK_SECRET', 'Configure GITHUB_WEBHOOK_SECRET');
  if (Number(request.headers.get('Content-Length') || 0) > 600_000)
    throw new ApiError(413, 'BODY_LIMIT', 'Payload muito grande');
  const body = await request.text();
  if (body.length > 600_000) throw new ApiError(413, 'BODY_LIMIT', 'Payload muito grande');
  if (!(await validSignature(request, env.GITHUB_WEBHOOK_SECRET, body)))
    throw new ApiError(401, 'WEBHOOK_SIGNATURE', 'Assinatura GitHub inválida');
  const event = request.headers.get('X-GitHub-Event');
  if (event === 'ping') return json({ accepted: true, kind: 'ping' });
  if (event !== 'push') return json({ accepted: false, reason: 'not_push' }, 202);
  const delivery = request.headers.get('X-GitHub-Delivery') || '';
  if (!UUID.test(delivery)) throw new ApiError(422, 'DELIVERY_ID', 'Identificador de entrega inválido');
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body); }
  catch { throw new ApiError(400, 'WEBHOOK_JSON', 'Payload inválido'); }
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (repository?.full_name !== (env.GITHUB_REPO || 'rodkisten/photointel'))
    throw new ApiError(403, 'WEBHOOK_REPO', 'Evento de outro repositório');
  if (payload.ref !== 'refs/heads/main' || payload.deleted === true)
    return json({ accepted: false, reason: 'branch_filtered' }, 202);
  const after = String(payload.after || ''), before = String(payload.before || '');
  if (!SHA.test(after) || /^0{40}$/.test(after))
    throw new ApiError(422, 'HEAD_SHA', 'Commit SHA inválido');
  const database = db(env);
  const changed = await changedFiles(env, before, after);
  const selected = matchRules(await rules(database), changed);
  const stamp = now();
  const inserted = await database.prepare('INSERT OR IGNORE INTO deploy_deliveries (id,sha,changed_files,created_at) VALUES (?,?,?,?)')
    .bind(delivery, after, JSON.stringify(changed), stamp).run();
  if (inserted.meta?.changes !== 1) return json({ accepted: true, duplicate: true });
  const runs: Run[] = [];
  for (const { rule } of selected) {
    const id = crypto.randomUUID();
    await database.prepare(
      "INSERT OR IGNORE INTO deploy_runs (id,delivery_id,rule_id,rule_name,provider,target,sha,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',?,?)")
      .bind(id, delivery, rule.id, rule.name, rule.provider, rule.target, after, stamp, stamp).run();
    runs.push({ id, delivery_id: delivery, rule_id: rule.id, rule_name: rule.name,
      provider: rule.provider, target: rule.target, sha: after, state: 'queued',
      provider_id: null, status_url: null, detail: null, created_at: stamp, updated_at: stamp });
  }
  context.waitUntil(Promise.all(runs.map((run) => dispatch(env, database, run))).then(() => undefined));
  return json({ accepted: true, delivery, sha: after, changed: changed.length,
    matched: selected.map((x) => ({ rule: x.rule.name, paths: x.files.length })) }, 202);
}
export async function cloudBuildCallback(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD', 'Callback requer POST');
  if (!env.GCP_BUILD_CALLBACK_SECRET) throw new ApiError(503, 'CALLBACK_SECRET', 'Callback não configurado');
  const token = request.headers.get('Authorization') || '';
  const input = new TextEncoder();
  const a = await crypto.subtle.digest('SHA-256', input.encode(token));
  const b = await crypto.subtle.digest('SHA-256', input.encode('Bearer ' + env.GCP_BUILD_CALLBACK_SECRET));
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  if (!av.every((v, i) => v === bv[i])) throw new ApiError(401, 'CALLBACK_AUTH', 'Callback não autorizado');
  const body = await bodyJson<{ run_id?: string; status?: string; build_id?: string }>(request, 4_000);
  if (!body.run_id || !UUID.test(body.run_id) ||
    !['running','success','failed','cancelled'].includes(body.status || ''))
    throw new ApiError(422, 'CALLBACK_BODY', 'Run e estado inválidos');
  const database = db(env);
  const run = await database.prepare(SQL_RUNS + ' WHERE id=?').bind(body.run_id).first<Run>();
  if (!run || run.provider !== 'gcp') throw new ApiError(404, 'RUN_NOT_FOUND', 'Execução GCP não encontrada');
  if (FINISHED.has(run.state)) return json({ accepted: true, duplicate: true });
  const build = body.build_id && UUID.test(body.build_id) ? body.build_id : null;
  const url = build ? 'https://console.cloud.google.com/cloud-build/builds;region=us-central1/' +
    build + '?project=photointel' : null;
  const updated = await setState(database, run, body.status!, build, url);
  await announce(env, updated, body.status!);
  return json({ accepted: true });
}
export async function routerApi(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/deploy-router')) return null;
  const database = db(env);
  if (request.method === 'GET' && path === '/api/deploy-router') {
    const [rs, runs] = await Promise.all([rules(database), database.prepare(SQL_RUNS +
      ' ORDER BY created_at DESC LIMIT 50').all<Run>()]);
    return json({ rules: rs, runs: runs.results, webhook: 'https://photos-hooks.migos.club/hooks/github',
      configured: { github: Boolean(env.GITHUB_WEBHOOK_SECRET),
        gcp_release: Boolean(env.GCP_BUILD_WEBHOOK_RELEASE_URL),
        gcp_provision: Boolean(env.GCP_BUILD_WEBHOOK_PROVISION_URL),
        cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN),
        xrelay: Boolean(env.XRELAY_NOTIFICATION_URL) } });
  }
  if (request.method === 'GET' && path === '/api/deploy-router/tree') {
    const tree = await getTree(env);
    const search = new URL(request.url).searchParams.get('q') || '';
    return json({ entries: tree.filter((x) => x.path.toLowerCase().includes(search.toLowerCase())).slice(0, 300),
      total: tree.length });
  }
  if (request.method === 'POST' && path === '/api/deploy-router/validate') {
    const input = await bodyJson<{ patterns?: unknown }>(request);
    const patterns = validatePatterns(input.patterns);
    const inspected = checkPaths(patterns, await getTree(env));
    return json({ items: inspected, valid: inspected.every((x) => x.exists) });
  }
  if (request.method === 'POST' && path === '/api/deploy-router/simulate') {
    const input = await bodyJson<{ paths?: string[] }>(request);
    if (!Array.isArray(input.paths) || input.paths.length > 200 ||
      input.paths.some((p) => typeof p !== 'string' || p.length > 240))
      throw new ApiError(422, 'SIMULATION_PATHS', 'Informe até 200 caminhos válidos');
    return json({ items: matchRules(await rules(database), input.paths).map(({ rule, files }) =>
      ({ id: rule.id, name: rule.name, provider: rule.provider, target: rule.target, files })) });
  }
  if (request.method === 'POST' && path === '/api/deploy-router/rules') {
    const input = validatedInput(await bodyJson<Record<string, unknown>>(request));
    const checks = checkPaths(input.patterns, await getTree(env));
    if (!checks.every((x) => x.exists)) throw new ApiError(422, 'PATH_NOT_FOUND', 'Alguns caminhos não existem no GitHub; valide antes de salvar');
    const id = crypto.randomUUID(), stamp = now();
    await database.prepare('INSERT INTO deploy_rules (id,name,enabled,provider,target,patterns_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, input.name, Number(input.enabled), input.provider, input.target,
        JSON.stringify(input.patterns), stamp, stamp).run();
    return json({ id }, 201);
  }
  const route = path.match(/^\/api\/deploy-router\/rules\/([0-9a-f-]{36})$/i);
  if (route && UUID.test(route[1])) {
    const current = await database.prepare(SQL_RULES + ' WHERE id=?').bind(route[1]).first<RuleRow>();
    if (!current) throw new ApiError(404, 'ROUTE_NOT_FOUND', 'Regra não encontrada');
    if (request.method === 'DELETE') {
      await database.prepare('DELETE FROM deploy_rules WHERE id=?').bind(route[1]).run();
      return json({ deleted: true });
    }
    if (request.method === 'PUT') {
      const input = validatedInput(await bodyJson<Record<string, unknown>>(request));
      const checks = checkPaths(input.patterns, await getTree(env));
      if (!checks.every((x) => x.exists)) throw new ApiError(422, 'PATH_NOT_FOUND', 'Alguns caminhos não existem no GitHub');
      await database.prepare('UPDATE deploy_rules SET name=?,enabled=?,provider=?,target=?,patterns_json=?,updated_at=? WHERE id=?')
        .bind(input.name, Number(input.enabled), input.provider, input.target,
          JSON.stringify(input.patterns), now(), route[1]).run();
      return json({ updated: true });
    }
  }
  const runLogs = path.match(/^\/api\/deploy-router\/runs\/([0-9a-f-]{36})\/logs$/i);
  if (request.method === 'GET' && runLogs && UUID.test(runLogs[1])) {
    const run = await database.prepare(SQL_RUNS + ' WHERE id=?').bind(runLogs[1]).first<Run>();
    if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', 'Execução não encontrada');
    if (run.provider !== 'cloudflare' || !run.provider_id)
      return json({ message: 'Consulte o Cloud Build no GCP; logs não disponíveis neste provedor', entries: [] });
    const raw = await cf(env, '/builds/builds/' + run.provider_id + '/logs');
    return json({ entries: [redact(raw).slice(0, 80_000)] });
  }
  if (request.method === 'POST' && path === '/api/deploy-router/refresh') {
    const waiting = await database.prepare(SQL_RUNS +
      " WHERE provider='cloudflare' AND state IN ('submitted','running') AND provider_id IS NOT NULL ORDER BY created_at LIMIT 20").all<Run>();
    await Promise.all(waiting.results.map(async (run) => pollCloudflare(env, database, run)));
    return json({ refreshed: waiting.results.length });
  }
  return null;
}
