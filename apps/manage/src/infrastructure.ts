import { ApiError, bodyJson, json, redact } from './auth';
import type { Env, Identity } from './auth';
import { gcpToken, provider } from './providers';

// --- TYPES & INTERFACES ---

export type RecordValue = Record<string, unknown>;

export interface Source {
  status: 'ok' | 'error';
  items: RecordValue[];
  message?: string;
}

export type ProviderMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// --- CONFIGURATION & CONSTANTS ---

const INFRA_CONFIG = {
  PROJECT: 'photointel',
  VM: 'photointel-terminal',
  ZONE: 'us-central1-a',
  REGION: 'us-central1',
  MAX_DURATION_MINUTES: 720,
  MIN_DURATION_MINUTES: 15,
  LOGS_MAX_PAGE_SIZE: 100,
  SCHEDULER_PAGE_SIZE: 100,
  BUILDS_PAGE_SIZE: 30,
  TRIGGERS_PAGE_SIZE: 100,
  SERIAL_PORT_BYTES: -65536,
  SERIAL_LINE_LIMIT: 70,
  MAX_BODY_SIZE_BYTES: 2048,
  SMALL_BODY_SIZE_BYTES: 1024,
  TIME_WINDOWS: {
    THREE_DAYS_MS: 3 * 86400_000,
    THREE_HOURS_MS: 3 * 3600_000,
    BOOT_TOLERANCE_MS: 5000,
  }
} as const;

const PATTERNS = {
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  OPERATION: /^[A-Za-z0-9_-]{1,128}$/,
  TRIGGER_ALLOWLIST: /^(us-central1|global):[0-9a-f-]{16,64}$/i,
  SERIAL_STARTUP: /terminal-startup: [A-Za-z0-9 _.:/@=\-]{1,180}/,
  SERIAL_FAILED: /startup-script.*failed with error: exit status (\d{1,3})/i,
  SERIAL_READY: /Terminal ready: ssh rod@[A-Za-z0-9.\-]{1,60}\. Maximum uptime: \d+ minutes\./,
};

// --- API ENDPOINTS BUILDERS ---

const COMPUTE_BASE = `https://compute.googleapis.com/compute/v1/projects/${INFRA_CONFIG.PROJECT}/zones/${INFRA_CONFIG.ZONE}`;
const VM_ENDPOINT = `${COMPUTE_BASE}/instances/${INFRA_CONFIG.VM}`;

const buildBase = (location: string): string =>
  `https://cloudbuild.googleapis.com/v1/projects/${INFRA_CONFIG.PROJECT}/locations/${location}`;

// --- CORE UTILITIES ---

function projectScope(env: Env): void {
  const currentProject = env.GCP_PROJECT_ID || INFRA_CONFIG.PROJECT;
  const currentRegion = env.GCP_REGION || INFRA_CONFIG.REGION;

  if (currentProject !== INFRA_CONFIG.PROJECT || currentRegion !== INFRA_CONFIG.REGION) {
    throw new ApiError(503, 'GCP_SCOPE', 'Infraestrutura limitada a photointel/us-central1');
  }
}

function request(token: string, path: string, method: ProviderMethod = 'GET', body?: unknown): Promise<RecordValue> {
  return provider(path, token, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as Promise<RecordValue>;
}

function allowedTriggers(env: Env): Set<string> {
  // Never expose a general-purpose build executor. Administrators allowlist IDs in the Worker.
  const rawItems = (env.GCP_CLOUDBUILD_ALLOWED_TRIGGERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const allowed = new Set<string>();

  for (const item of rawItems) {
    if (!PATTERNS.TRIGGER_ALLOWLIST.test(item)) {
      throw new ApiError(503, 'BUILD_ALLOWLIST', 'GCP_CLOUDBUILD_ALLOWED_TRIGGERS contém um ID inválido');
    }
    allowed.add(item.toLowerCase());
  }

  return allowed;
}

function asItems(value: RecordValue, key: string): RecordValue[] {
  return Array.isArray(value[key]) ? (value[key] as RecordValue[]) : [];
}

function issue(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : 'Integração GCP indisponível';
}

async function settled(promise: Promise<unknown>): Promise<Source> {
  try {
    const data = await promise;
    return { 
      status: 'ok', 
      items: Array.isArray(data) ? (data as RecordValue[]) : [data as RecordValue] 
    };
  } catch (error) {
    return { status: 'error', items: [], message: issue(error) };
  }
}

// --- PARSERS & FORMATTERS ---

export function parseVm(raw: RecordValue) {
  const labels = (raw.labels || {}) as Record<string, unknown>;
  
  if (
    raw.name !== INFRA_CONFIG.VM || 
    labels.app !== 'photointel' || 
    labels.purpose !== 'terminal'
  ) {
    throw new ApiError(409, 'VM_IDENTITY', 'A VM não corresponde à instância terminal gerenciada');
  }

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
    id: String(raw.id || ''), 
    name: INFRA_CONFIG.VM, 
    zone: INFRA_CONFIG.ZONE,
    status: String(raw.status || 'UNKNOWN'),
    machine: String(raw.machineType || '').split('/').pop(),
    started_at: start, 
    stopped_at: raw.lastStopTimestamp || null,
    expiration_at: typeof effective.terminationTimestamp === 'string'
      ? effective.terminationTimestamp 
      : estimate,
    duration_minutes: duration,
    expiration_action: scheduling.instanceTerminationAction || null,
    max_duration_enforced: Boolean(duration && scheduling.instanceTerminationAction === 'STOP'),
    console_url: `https://console.cloud.google.com/compute/instancesDetail/zones/${INFRA_CONFIG.ZONE}/instances/${INFRA_CONFIG.VM}?project=${INFRA_CONFIG.PROJECT}`,
  };
}

async function readVm(token: string) {
  const raw = await request(token, VM_ENDPOINT);
  return parseVm(raw);
}

function triggerInfo(raw: RecordValue, location: string, allowed: Set<string>) {
  const id = String(raw.id || '');
  const name = String(raw.name || '');
  
  return {
    id, 
    location, 
    name, 
    description: String(raw.description || ''),
    disabled: Boolean(raw.disabled), 
    authorized: allowed.has(`${location}:${id}`.toLowerCase()),
    filename: String(raw.filename || ''),
    service_account: typeof raw.serviceAccount === 'string' ? raw.serviceAccount : null,
  };
}

function buildInfo(raw: RecordValue) {
  return {
    id: String(raw.id || ''), 
    status: String(raw.status || 'UNKNOWN'),
    create_time: raw.createTime || null, 
    start_time: raw.startTime || null,
    finish_time: raw.finishTime || null, 
    log_url: raw.logUrl || null,
    images: raw.images || [],
    steps: Array.isArray(raw.steps) 
      ? raw.steps.map((step: RecordValue) => ({
          id: step.id || step.name, 
          name: step.name, 
          status: step.status || 'QUEUED',
          timing: step.timing || null,
        })) 
      : [],
  };
}

export function safeSerial(raw: unknown, boot?: string | null) {
  const content = typeof raw === 'string' ? raw : '';
  const bootMs = boot ? Date.parse(boot) : NaN;

  return content
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.includes('google_metadata_script_runner')) return false;
      if (!/terminal-startup:|Terminal ready:|startup-script.*failed/i.test(line)) return false;
      
      const timestamp = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)?.[0];
      return !timestamp || !Number.isFinite(bootMs) || Date.parse(timestamp + 'Z') >= bootMs - INFRA_CONFIG.TIME_WINDOWS.BOOT_TOLERANCE_MS;
    })
    .slice(-INFRA_CONFIG.SERIAL_LINE_LIMIT)
    .map((line) => {
      // Do not forward arbitrary serial output: filter to recognized diagnostics only.
      const stage = line.match(PATTERNS.SERIAL_STARTUP);
      const failed = line.match(PATTERNS.SERIAL_FAILED);
      const ready = line.match(PATTERNS.SERIAL_READY);
      
      const message = stage?.[0] || (failed && `startup-script failed with exit status ${failed[1]}`) || ready?.[0];
      if (!message) return null;
      
      return { 
        timestamp: `${line.slice(0, 19)}Z`, 
        severity: failed ? 'ERROR' : ready ? 'NOTICE' : 'INFO', 
        message 
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

function logItems(raw: RecordValue) {
  return asItems(raw, 'entries').map((item) => {
    const payload = item.jsonPayload || item.textPayload || item.protoPayload;
    const text = typeof payload === 'string' ? payload : payload ? JSON.stringify(payload) : '';
    
    return {
      timestamp: String(item.timestamp || ''),
      severity: String(item.severity || 'INFO'),
      message: redact(text).slice(0, 6000),
      id: String(item.insertId || ''),
    };
  });
}

// --- ROUTE HANDLER ---

export async function infrastructureRoute(req: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/infrastructure')) return null;
  
  projectScope(env);
  const token = await gcpToken(env, identity);
  const { pathname: path } = url;
  const allowed = allowedTriggers(env);
  const region = INFRA_CONFIG.REGION;
  const project = INFRA_CONFIG.PROJECT;

  // 1. GET /api/infrastructure (Dashboard overview)
  if (req.method === 'GET' && path === '/api/infrastructure') {
    const [vm, services, jobs, scheduler, builds, globalBuilds, triggers, globalTriggers] = await Promise.all([
      settled(readVm(token)),
      settled(request(token, `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`)
        .then((r) => asItems(r, 'services').map((x) => ({ name: x.name, uri: x.uri, reconciling: x.reconciling, condition: (x.terminalCondition as RecordValue | undefined)?.state })))),
      settled(request(token, `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs`)
        .then((r) => asItems(r, 'jobs').map((x) => ({ name: x.name, latest: x.latestCreatedExecution, reconciling: x.reconciling })))),
      settled(request(token, `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${region}/jobs?pageSize=${INFRA_CONFIG.SCHEDULER_PAGE_SIZE}`)
        .then((r) => asItems(r, 'jobs').map((x) => ({ name: x.name, state: x.state, last_attempt: x.lastAttemptTime, schedule_time: x.scheduleTime })))),
      settled(request(token, `${buildBase(region)}/builds?pageSize=${INFRA_CONFIG.BUILDS_PAGE_SIZE}`).then((r) => asItems(r, 'builds').map(buildInfo))),
      settled(request(token, `${buildBase('global')}/builds?pageSize=${INFRA_CONFIG.BUILDS_PAGE_SIZE}`).then((r) => asItems(r, 'builds').map(buildInfo))),
      settled(request(token, `${buildBase(region)}/triggers?pageSize=${INFRA_CONFIG.TRIGGERS_PAGE_SIZE}`).then((r) => asItems(r, 'triggers').map((t) => triggerInfo(t, region, allowed)))),
      settled(request(token, `${buildBase('global')}/triggers?pageSize=${INFRA_CONFIG.TRIGGERS_PAGE_SIZE}`).then((r) => asItems(r, 'triggers').map((t) => triggerInfo(t, 'global', allowed)))),
    ]);
    
    return json({ 
      checked_at: new Date().toISOString(), 
      project, 
      region, 
      vm,
      services, 
      jobs, 
      scheduler, 
      builds, 
      global_builds: globalBuilds, 
      triggers, 
      global_triggers: globalTriggers,
      trigger_configured: allowed.size > 0 
    });
  }

  // 2. POST /api/infrastructure/builds/run
  if (req.method === 'POST' && path === '/api/infrastructure/builds/run') {
    const input = await bodyJson<{ id?: unknown; location?: unknown; confirm?: unknown }>(req, INFRA_CONFIG.MAX_BODY_SIZE_BYTES);
    const id = String(input.id || '');
    const location = String(input.location || '');
    
    if (!PATTERNS.UUID.test(id) || ![region, 'global'].includes(location) || !allowed.has(`${location}:${id}`.toLowerCase())) {
      throw new ApiError(403, 'BUILD_DENIED', 'Somente triggers previamente autorizados podem executar');
    }
    if (input.confirm !== `RUN ${location}:${id}`) {
      throw new ApiError(422, 'BUILD_CONFIRM', 'Confirmação do pipeline inválida');
    }

    const detail = await request(token, `${buildBase(location)}/triggers/${id}`);
    if (detail.disabled) throw new ApiError(409, 'BUILD_DISABLED', 'Trigger desativado');

    const result = await request(token, `${buildBase(location)}/triggers/${id}:run`, 'POST', {
      projectId: project, 
      triggerId: id, 
      source: { branchName: 'main' },
    });

    console.log(JSON.stringify({ event: 'cloud_build_trigger_run', by: identity.email, id, location }));
    return json({ ok: true, operation: result.name || null, requested_at: new Date().toISOString() }, 202);
  }

  // 3. GET /api/infrastructure/builds/logs
  if (req.method === 'GET' && path === '/api/infrastructure/builds/logs') {
    const id = url.searchParams.get('id') || '';
    if (!PATTERNS.UUID.test(id)) throw new ApiError(422, 'BUILD_ID', 'ID de build inválido');

    const threeDaysAgoIso = new Date(Date.now() - INFRA_CONFIG.TIME_WINDOWS.THREE_DAYS_MS).toISOString();
    const raw = await request(token, 'https://logging.googleapis.com/v2/entries:list', 'POST', {
      resourceNames: [`projects/${project}`],
      filter: `resource.type="build" AND resource.labels.build_id="${id}" AND timestamp>="${threeDaysAgoIso}"`,
      orderBy: 'timestamp desc', 
      pageSize: INFRA_CONFIG.LOGS_MAX_PAGE_SIZE,
    });

    return json({ items: logItems(raw).reverse(), checked_at: new Date().toISOString() });
  }

  // 4. GET /api/infrastructure/vm
  if (path === '/api/infrastructure/vm' && req.method === 'GET') {
    return json({ vm: await readVm(token) });
  }

  // 5. POST /api/infrastructure/vm/prepare
  if (req.method === 'POST' && path === '/api/infrastructure/vm/prepare') {
    const input = await bodyJson<{ minutes?: unknown }>(req, INFRA_CONFIG.SMALL_BODY_SIZE_BYTES);
    const minutes = Number(input.minutes);
    
    if (!Number.isInteger(minutes) || minutes < INFRA_CONFIG.MIN_DURATION_MINUTES || minutes > INFRA_CONFIG.MAX_DURATION_MINUTES) {
      throw new ApiError(422, 'VM_DURATION', 'Duração deve estar entre 15 e 720 minutos');
    }

    const vm = await readVm(token);
    if (vm.status !== 'TERMINATED') {
      throw new ApiError(409, 'VM_RUNNING', 'Para alterar o limite, desligue primeiro a VM');
    }

    const operation = await request(token, `${VM_ENDPOINT}/setScheduling`, 'POST', {
      maxRunDuration: { seconds: String(minutes * 60) },
      instanceTerminationAction: 'STOP', 
      automaticRestart: false,
    });

    console.log(JSON.stringify({ event: 'terminal_expiration_configured', by: identity.email, minutes }));
    return json({ operation: String(operation.name || ''), minutes }, 202);
  }

  // 6. GET /api/infrastructure/vm/operations/:name
  if (req.method === 'GET' && path.startsWith('/api/infrastructure/vm/operations/')) {
    const name = path.slice('/api/infrastructure/vm/operations/'.length);
    if (!PATTERNS.OPERATION.test(name)) throw new ApiError(422, 'ZONE_OP', 'Operação inválida');

    const data = await request(token, `${COMPUTE_BASE}/operations/${name}`);
    return json({ 
      name: data.name, 
      status: data.status, 
      error: data.error ? 'O Compute Engine recusou a operação' : null 
    });
  }

  // 7. POST /api/infrastructure/vm/start
  if (req.method === 'POST' && path === '/api/infrastructure/vm/start') {
    const input = await bodyJson<{ minutes?: unknown }>(req, INFRA_CONFIG.SMALL_BODY_SIZE_BYTES);
    const minutes = Number(input.minutes);
    const vm = await readVm(token);

    if (vm.status !== 'TERMINATED') {
      throw new ApiError(409, 'VM_RUNNING', 'VM não está parada');
    }
    if (
      !vm.max_duration_enforced || 
      vm.duration_minutes !== minutes || 
      minutes < INFRA_CONFIG.MIN_DURATION_MINUTES || 
      minutes > INFRA_CONFIG.MAX_DURATION_MINUTES
    ) {
      throw new ApiError(409, 'VM_PREPARE', 'Configure e confirme o tempo máximo antes de ligar');
    }

    const op = await request(token, `${VM_ENDPOINT}/start`, 'POST');
    console.log(JSON.stringify({ event: 'terminal_started', by: identity.email, minutes }));
    return json({ operation: op.name, status: 'STARTING' }, 202);
  }

  // 8. POST /api/infrastructure/vm/stop
  if (req.method === 'POST' && path === '/api/infrastructure/vm/stop') {
    const vm = await readVm(token);
    if (vm.status !== 'RUNNING') throw new ApiError(409, 'VM_NOT_RUNNING', 'VM não está em execução');

    const op = await request(token, `${VM_ENDPOINT}/stop`, 'POST');
    console.log(JSON.stringify({ event: 'terminal_stopped', by: identity.email }));
    return json({ operation: op.name, status: 'STOPPING' }, 202);
  }

  // 9. GET /api/infrastructure/vm/logs
  if (req.method === 'GET' && path === '/api/infrastructure/vm/logs') {
    const vm = await readVm(token);
    const threeHoursAgoIso = new Date(Date.now() - INFRA_CONFIG.TIME_WINDOWS.THREE_HOURS_MS).toISOString();
    
    const since = vm.started_at && vm.status !== 'TERMINATED' 
      ? vm.started_at 
      : threeHoursAgoIso;

    const [cloud, serial] = await Promise.allSettled([
      request(token, 'https://logging.googleapis.com/v2/entries:list', 'POST', {
        resourceNames: [`projects/${project}`],
        filter: `resource.type="gce_instance" AND resource.labels.instance_id="${vm.id}" AND timestamp>="${since}"`, 
        orderBy: 'timestamp desc', 
        pageSize: INFRA_CONFIG.LOGS_MAX_PAGE_SIZE,
      }),
      request(token, `${VM_ENDPOINT}/serialPort?port=1&start=${INFRA_CONFIG.SERIAL_PORT_BYTES}`),
    ]);

    return json({
      checked_at: new Date().toISOString(),
      items: cloud.status === 'fulfilled' ? logItems(cloud.value).reverse() : [],
      serial: serial.status === 'fulfilled'
        ? safeSerial(serial.value.contents, vm.started_at) 
        : [],
      errors: [
        ...(cloud.status === 'rejected' ? [issue(cloud.reason)] : []),
        ...(serial.status === 'rejected' ? [issue(serial.reason)] : []),
      ],
    });
  }

  return null;
}
