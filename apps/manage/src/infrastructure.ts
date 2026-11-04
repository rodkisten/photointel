import { ApiError, bodyJson, json, redact } from './auth';
import type { Env, Identity } from './auth';
import { gcpToken, provider } from './providers';

type RecordValue = Record<string, unknown>;
type Source = { status: 'ok' | 'error'; items: RecordValue[]; message?: string };
const PROJECT = 'photointel';
const VM = 'photointel-terminal';
const ZONE = 'us-central1-a';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION = /^[A-Za-z0-9_-]{1,128}$/;
const REGION = 'us-central1';

function projectScope(env: Env) {
  if ((env.GCP_PROJECT_ID || PROJECT) !== PROJECT || (env.GCP_REGION || REGION) !== REGION)
    throw new ApiError(503, 'GCP_SCOPE', 'Infraestrutura limitada a photointel/us-central1');
}
function request(token: string, path: string, method = 'GET', body?: unknown) {
  return provider(path, token, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as Promise<RecordValue>;
}
const base = 'https://compute.googleapis.com/compute/v1/projects/' + PROJECT + '/zones/' + ZONE;
const vmEndpoint = base + '/instances/' + VM;
const buildBase = (location: string) =>
  'https://cloudbuild.googleapis.com/v1/projects/' + PROJECT + '/locations/' + location;

function allowedTriggers(env: Env): Set<string> {
  // Never expose a general-purpose build executor. Administrators allowlist IDs in the Worker.
  const items = (env.GCP_CLOUDBUILD_ALLOWED_TRIGGERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const allowed = new Set<string>();
  for (const item of items) {
    if (!/^(us-central1|global):[0-9a-f-]{16,64}$/i.test(item))
      throw new ApiError(503, 'BUILD_ALLOWLIST', 'GCP_CLOUDBUILD_ALLOWED_TRIGGERS contém um ID inválido');
    allowed.add(item.toLowerCase());
  }
  return allowed;
}
function asItems(value: RecordValue, key: string): RecordValue[] {
  return Array.isArray(value[key]) ? (value[key] as RecordValue[]) : [];
}
function issue(reason: unknown) {
  return reason instanceof ApiError ? reason.message : 'Integração GCP indisponível';
}
async function settled(promise: Promise<unknown>): Promise<Source> {
  try {
    const data = await promise;
    return { status: 'ok', items: Array.isArray(data) ? data as RecordValue[] : [data as RecordValue] };
  } catch (error) {
    return { status: 'error', items: [], message: issue(error) };
  }
}

export function parseVm(raw: RecordValue) {
  const labels = (raw.labels || {}) as Record<string, unknown>;
  if (raw.name !== VM || labels.app !== 'photointel' || labels.purpose !== 'terminal')
    throw new ApiError(409, 'VM_IDENTITY', 'A VM não corresponde à instância terminal gerenciada');
  const scheduling = (raw.scheduling || {}) as RecordValue;
  const status = (raw.resourceStatus || {}) as RecordValue;
  const effective = (status.scheduling || {}) as RecordValue;
  const run = (scheduling.maxRunDuration || {}) as RecordValue;
  const start = typeof raw.lastStartTimestamp === 'string' ? raw.lastStartTimestamp : null;
  const seconds = Number(run.seconds);
  const duration = Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
  const estimate = start && duration && raw.status === 'RUNNING'
    ? new Date(Date.parse(start) + duration * 60_000).toISOString()
    : null;
  return {
    id: String(raw.id || ''), name: VM, zone: ZONE,
    status: String(raw.status || 'UNKNOWN'),
    machine: String(raw.machineType || '').split('/').pop(),
    started_at: start, stopped_at: raw.lastStopTimestamp || null,
    expiration_at: typeof effective.terminationTimestamp === 'string'
      ? effective.terminationTimestamp : estimate,
    duration_minutes: duration,
    expiration_action: scheduling.instanceTerminationAction || null,
    max_duration_enforced: Boolean(duration && scheduling.instanceTerminationAction === 'STOP'),
    console_url: 'https://console.cloud.google.com/compute/instancesDetail/zones/' + ZONE +
      '/instances/' + VM + '?project=' + PROJECT,
  };
}
async function readVm(token: string) {
  const raw = await request(token, vmEndpoint);
  return parseVm(raw);
}

function triggerInfo(raw: RecordValue, location: string, allowed: Set<string>) {
  const id = String(raw.id || '');
  const name = String(raw.name || '');
  return {
    id, location, name, description: String(raw.description || ''),
    disabled: Boolean(raw.disabled), authorized: allowed.has((location + ':' + id).toLowerCase()),
    filename: String(raw.filename || ''),
    service_account: typeof raw.serviceAccount === 'string' ? raw.serviceAccount : null,
  };
}
function buildInfo(raw: RecordValue) {
  return {
    id: String(raw.id || ''), status: String(raw.status || 'UNKNOWN'),
    create_time: raw.createTime || null, start_time: raw.startTime || null,
    finish_time: raw.finishTime || null, log_url: raw.logUrl || null,
    images: raw.images || [],
    steps: Array.isArray(raw.steps) ? raw.steps.map((step: RecordValue) => ({
      id: step.id || step.name, name: step.name, status: step.status || 'QUEUED',
      timing: step.timing || null,
    })) : [],
  };
}
export function safeSerial(raw: unknown, boot?: string | null) {
  const content = typeof raw === 'string' ? raw : '';
  const bootMs = boot ? Date.parse(boot) : NaN;
  return content.split(/\r?\n/).filter((line) => {
    if (!line.includes('google_metadata_script_runner')) return false;
    if (!/terminal-startup:|Terminal ready:|startup-script.*failed/i.test(line)) return false;
    const timestamp = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)?.[0];
    return !timestamp || !Number.isFinite(bootMs) || Date.parse(timestamp + 'Z') >= bootMs - 5000;
  }).slice(-70).map((line) => {
    // Do not forward arbitrary serial output: filter to recognized diagnostics only.
    const stage = line.match(/terminal-startup: [A-Za-z0-9 _.:/@=\-]{1,180}/);
    const failed = line.match(/startup-script.*failed with error: exit status (\d{1,3})/i);
    const ready = line.match(/Terminal ready: ssh rod@[A-Za-z0-9.\-]{1,60}\. Maximum uptime: \d+ minutes\./);
    const message = stage?.[0] || (failed && 'startup-script failed with exit status ' + failed[1]) || ready?.[0];
    if (!message) return null;
    return { timestamp: line.slice(0, 19) + 'Z', severity: failed ? 'ERROR' : ready ? 'NOTICE' : 'INFO', message };
  }).filter((x) => x !== null);
}
function logItems(raw: RecordValue) {
  return asItems(raw, 'entries').map((item) => {
    const payload = item.jsonPayload || item.textPayload || item.protoPayload;
    const text = typeof payload === 'string' ? payload : payload ? JSON.stringify(payload) : '';
    return {
      timestamp: item.timestamp || '',
      severity: String(item.severity || 'INFO'),
      message: redact(text).slice(0, 6000),
      id: String(item.insertId || ''),
    };
  });
}

export async function infrastructureRoute(req: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/infrastructure')) return null;
  projectScope(env);
  const token = await gcpToken(env, identity);
  const { pathname: path } = url;
  const allowed = allowedTriggers(env);

  if (req.method === 'GET' && path === '/api/infrastructure') {
    const [vm, services, jobs, scheduler, builds, globalBuilds, triggers, globalTriggers] = await Promise.all([
      settled(readVm(token)),
      settled(request(token, 'https://run.googleapis.com/v2/projects/' + PROJECT + '/locations/' + REGION + '/services')
        .then((r) => asItems(r, 'services').map((x) => ({ name: x.name, uri: x.uri, reconciling: x.reconciling, condition: (x.terminalCondition as RecordValue | undefined)?.state })))),
      settled(request(token, 'https://run.googleapis.com/v2/projects/' + PROJECT + '/locations/' + REGION + '/jobs')
        .then((r) => asItems(r, 'jobs').map((x) => ({ name: x.name, latest: x.latestCreatedExecution, reconciling: x.reconciling })))),
      settled(request(token, 'https://cloudscheduler.googleapis.com/v1/projects/' + PROJECT + '/locations/' + REGION + '/jobs?pageSize=100')
        .then((r) => asItems(r, 'jobs').map((x) => ({ name: x.name, state: x.state, last_attempt: x.lastAttemptTime, schedule_time: x.scheduleTime })))),
      settled(request(token, buildBase(REGION) + '/builds?pageSize=30').then((r) => asItems(r, 'builds').map(buildInfo))),
      settled(request(token, buildBase('global') + '/builds?pageSize=30').then((r) => asItems(r, 'builds').map(buildInfo))),
      settled(request(token, buildBase(REGION) + '/triggers?pageSize=100').then((r) => asItems(r, 'triggers').map((t) => triggerInfo(t, REGION, allowed)))),
      settled(request(token, buildBase('global') + '/triggers?pageSize=100').then((r) => asItems(r, 'triggers').map((t) => triggerInfo(t, 'global', allowed)))),
    ]);
    return json({ checked_at: new Date().toISOString(), project: PROJECT, region: REGION, vm,
      services, jobs, scheduler, builds, global_builds: globalBuilds, triggers, global_triggers: globalTriggers,
      trigger_configured: allowed.size > 0 });
  }

  if (req.method === 'POST' && path === '/api/infrastructure/builds/run') {
    const input = await bodyJson<{ id?: unknown; location?: unknown; confirm?: unknown }>(req, 2048);
    const id = String(input.id || ''), location = String(input.location || '');
    if (!UUID.test(id) || ![REGION, 'global'].includes(location) || !allowed.has((location + ':' + id).toLowerCase()))
      throw new ApiError(403, 'BUILD_DENIED', 'Somente triggers previamente autorizados podem executar');
    if (input.confirm !== 'RUN ' + location + ':' + id)
      throw new ApiError(422, 'BUILD_CONFIRM', 'Confirmação do pipeline inválida');
    const detail = await request(token, buildBase(location) + '/triggers/' + id);
    if (detail.disabled) throw new ApiError(409, 'BUILD_DISABLED', 'Trigger desativado');
    const result = await request(token, buildBase(location) + '/triggers/' + id + ':run', 'POST', {
      projectId: PROJECT, triggerId: id, source: { branchName: 'main' },
    });
    console.log(JSON.stringify({ event: 'cloud_build_trigger_run', by: identity.email, id, location }));
    return json({ ok: true, operation: result.name || null, requested_at: new Date().toISOString() }, 202);
  }

  if (req.method === 'GET' && path === '/api/infrastructure/builds/logs') {
    const id = url.searchParams.get('id') || '';
    if (!UUID.test(id)) throw new ApiError(422, 'BUILD_ID', 'ID de build inválido');
    const raw = await request(token, 'https://logging.googleapis.com/v2/entries:list', 'POST', {
      resourceNames: ['projects/' + PROJECT],
      filter: 'resource.type="build" AND resource.labels.build_id="' + id + '" AND timestamp>="' +
        new Date(Date.now() - 3 * 86400_000).toISOString() + '"',
      orderBy: 'timestamp desc', pageSize: 100,
    });
    return json({ items: logItems(raw).reverse(), checked_at: new Date().toISOString() });
  }

  if (path === '/api/infrastructure/vm' && req.method === 'GET') return json({ vm: await readVm(token) });

  if (req.method === 'POST' && path === '/api/infrastructure/vm/prepare') {
    const input = await bodyJson<{ minutes?: unknown }>(req, 1024);
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720)
      throw new ApiError(422, 'VM_DURATION', 'Duração deve estar entre 15 e 720 minutos');
    const vm = await readVm(token);
    if (vm.status !== 'TERMINATED') throw new ApiError(409, 'VM_RUNNING', 'Para alterar o limite, desligue primeiro a VM');
    const operation = await request(token, vmEndpoint + '/setScheduling', 'POST', {
      maxRunDuration: { seconds: String(minutes * 60) },
      instanceTerminationAction: 'STOP', automaticRestart: false,
    });
    console.log(JSON.stringify({ event: 'terminal_expiration_configured', by: identity.email, minutes }));
    return json({ operation: String(operation.name || ''), minutes }, 202);
  }

  if (req.method === 'GET' && path.startsWith('/api/infrastructure/vm/operations/')) {
    const name = path.slice('/api/infrastructure/vm/operations/'.length);
    if (!OPERATION.test(name)) throw new ApiError(422, 'ZONE_OP', 'Operação inválida');
    const data = await request(token, base + '/operations/' + name);
    return json({ name: data.name, status: data.status, error: data.error ? 'O Compute Engine recusou a operação' : null });
  }

  if (req.method === 'POST' && path === '/api/infrastructure/vm/start') {
    const input = await bodyJson<{ minutes?: unknown }>(req, 1024);
    const minutes = Number(input.minutes), vm = await readVm(token);
    if (vm.status !== 'TERMINATED') throw new ApiError(409, 'VM_RUNNING', 'VM não está parada');
    if (!vm.max_duration_enforced || vm.duration_minutes !== minutes || minutes < 15 || minutes > 720)
      throw new ApiError(409, 'VM_PREPARE', 'Configure e confirme o tempo máximo antes de ligar');
    const op = await request(token, vmEndpoint + '/start', 'POST');
    console.log(JSON.stringify({ event: 'terminal_started', by: identity.email, minutes }));
    return json({ operation: op.name, status: 'STARTING' }, 202);
  }
  if (req.method === 'POST' && path === '/api/infrastructure/vm/stop') {
    const vm = await readVm(token);
    if (vm.status !== 'RUNNING') throw new ApiError(409, 'VM_NOT_RUNNING', 'VM não está em execução');
    const op = await request(token, vmEndpoint + '/stop', 'POST');
    console.log(JSON.stringify({ event: 'terminal_stopped', by: identity.email }));
    return json({ operation: op.name, status: 'STOPPING' }, 202);
  }

  if (req.method === 'GET' && path === '/api/infrastructure/vm/logs') {
    const vm = await readVm(token);
    const since = vm.started_at && vm.status !== 'TERMINATED' ? vm.started_at :
      new Date(Date.now() - 3 * 3600_000).toISOString();
    const [cloud, serial] = await Promise.allSettled([
      request(token, 'https://logging.googleapis.com/v2/entries:list', 'POST', {
        resourceNames: ['projects/' + PROJECT],
        filter: 'resource.type="gce_instance" AND resource.labels.instance_id="' + vm.id +
          '" AND timestamp>="' + since + '"', orderBy: 'timestamp desc', pageSize: 100,
      }),
      request(token, vmEndpoint + '/serialPort?port=1&start=-65536'),
    ]);
    return json({
      checked_at: new Date().toISOString(),
      items: cloud.status === 'fulfilled' ? logItems(cloud.value).reverse() : [],
      serial: serial.status === 'fulfilled'
        ? safeSerial(serial.value.contents, vm.started_at) : [],
      errors: [
        ...(cloud.status === 'rejected' ? [issue(cloud.reason)] : []),
        ...(serial.status === 'rejected' ? [issue(serial.reason)] : []),
      ],
    });
  }
  return null;
}
