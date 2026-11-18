import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnvironment } from './index.ts';

export type DeploymentTarget = 'production' | 'preview';

export type WorkloadIdentity = {
  provider: string;
  serviceAccount: string;
  bootstrapProvider?: string;
  bootstrapServiceAccount?: string;
};

const WIF_PROVIDER = /^projects\\/[0-9]+\\/locations\\/global\\/workloadIdentityPools\\/[A-Za-z0-9_-]+\\/providers\\/[A-Za-z0-9_-]+$/;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]*@[a-z][a-z0-9.-]*\\.iam\\.gserviceaccount\\.com$/;

/** Validate metadata only. Authentication and secret retrieval stay in trusted deployment adapters. */
export function validateWorkloadIdentity(entries: Record<string, string>): WorkloadIdentity {
  const provider = entries.GCP_WORKLOAD_IDENTITY_PROVIDER;
  const serviceAccount = entries.GCP_DEPLOY_SERVICE_ACCOUNT;
  if (!provider || !serviceAccount) {
    throw new Error('Missing Workload Identity entries: GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_DEPLOY_SERVICE_ACCOUNT');
  }
  if (!WIF_PROVIDER.test(provider)) throw new Error('Invalid GCP_WORKLOAD_IDENTITY_PROVIDER resource name');
  if (!SERVICE_ACCOUNT.test(serviceAccount)) throw new Error('Invalid GCP_DEPLOY_SERVICE_ACCOUNT email');
  const bootstrapProvider = entries.GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER || undefined;
  const bootstrapServiceAccount = entries.GCP_BOOTSTRAP_SERVICE_ACCOUNT || undefined;
  if (Boolean(bootstrapProvider) !== Boolean(bootstrapServiceAccount)) {
    throw new Error('Bootstrap WIF provider and service account must be configured together');
  }
  if (bootstrapProvider && bootstrapServiceAccount &&
      (!WIF_PROVIDER.test(bootstrapProvider) || !SERVICE_ACCOUNT.test(bootstrapServiceAccount) ||
       (bootstrapProvider === provider && bootstrapServiceAccount === serviceAccount))) {
    throw new Error('Invalid or insufficiently separated bootstrap WIF identity');
  }
  return {provider, serviceAccount, ...(bootstrapProvider ? {bootstrapProvider, bootstrapServiceAccount} : {})};
}



export function normalizeDeployConfig(raw: string) {
  const source = raw.trim();
  if (!source) throw new Error('GCP_CONFIG_ENV is empty');
  if (source.startsWith('{')) {
    const object: unknown = JSON.parse(source);
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected JSON object');
    const config = object as Record<string, unknown>;
    if (Object.values(config).some(value => value !== null && typeof value === 'object') ||
      'extra_environment' in config || 'workflow_secrets' in config || 'cloudflare_environment' in config) {
      return {
        runtime: normalizeRecord(config.extra_environment ?? config.extra),
        cloudflare: normalizeRecord(config.cloudflare_environment),
        workflows: config.workflows ?? {},
        secrets: config.secrets ?? {},
        workflowSecrets: config.workflow_secrets ?? {},
      };
    }
  }
  const parsed = parseEnvironment(raw);
  return {
    runtime: parsed.runtime,
    cloudflare: parsed.cloudflare,
    workflows: parsed.workflows,
    secrets: parsed.secrets.filter(s => s.scope === 'runtime'),
    workflowSecrets: parsed.secrets.filter(s => s.scope === 'workflow'),
  };
}

function normalizeRecord(input: unknown): Record<string, string> {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected environment object');
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (value == null) throw new Error('Null environment binding: ' + key);
    return [key, typeof value === 'string' ? value : JSON.stringify(value)];
  }));
}

export function validateTerminal(runtime: Record<string, string>): void {
  const raw = runtime.MANAGE_TERMINAL_VMS;
  if (!raw) return;
  const targets: unknown = JSON.parse(raw);
  if (!Array.isArray(targets) || !targets.length || targets.length > 30) throw new Error('MANAGE_TERMINAL_VMS must be a nonempty array (max 30)');
  const ids = new Set<string>();
  for (const item of targets) {
    if (!item || typeof item !== 'object') throw new Error('Invalid VM target');
    const vm = item as Record<string, unknown>;
    if (typeof vm.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(vm.id) || ids.has(vm.id) ||
      typeof vm.label !== 'string' || !vm.label.trim() || vm.label.length > 80 ||
      typeof vm.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(vm.host) ||
      !Number.isInteger(vm.port) || Number(vm.port) < 1 || Number(vm.port) > 65535 ||
      typeof vm.username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(vm.username) ||
      typeof vm.hostKeySha256 !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(vm.hostKeySha256)) {
      throw new Error('Invalid VM target fields: id, label, host, port, username, hostKeySha256');
    }
    ids.add(vm.id);
  }
  if (runtime.MANAGE_TERMINAL_GATEWAY_URL !== 'https://photointel-ssh.migos.club')
    throw new Error('Terminal gateway must use the approved Access-protected hostname');
}

export function deployBindings(raw: string, target: DeploymentTarget) {
  const config = normalizeDeployConfig(raw);
  if (target === 'production') validateTerminal(config.runtime);
  const runtime = { ...config.runtime };
  if (target === 'preview') {
    for (const key of Object.keys(runtime)) {
      if (/^(?:MANAGE_TERMINAL_|MANAGE_CODESPACES_|GITHUB_API_TOKEN|GITHUB_TOKEN|.*(?:SECRET|PRIVATE_KEY|PASSWORD|CREDENTIAL|TOKEN))$/i.test(key)) delete runtime[key];
    }
    delete runtime.MANAGE_TERMINAL_GATEWAY_SECRET;
    delete runtime.MANAGE_CODESPACES_USER_TOKEN;
    delete runtime.MANAGE_TERMINAL_VMS;
    delete runtime.MANAGE_TERMINAL_GATEWAY_URL;
    runtime.PHOTOINTEL_PREVIEW = 'true';
  }
  return { runtime, cloudflare: target === 'preview' ? {} : config.cloudflare, workflows: target === 'preview' ? {} : config.workflows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [,, target, output] = process.argv;
  if (target !== 'production' && target !== 'preview' && target !== 'diagnose' && target !== 'compare') throw new Error('Usage: node deploy.ts production|preview|diagnose|compare [output.json]');
  if (target !== 'diagnose' && !output) throw new Error('Output path required');
  const raw = process.env.GCP_CONFIG_ENV ?? (process.env.GCP_CONFIG_ENV_FILE ? readFileSync(process.env.GCP_CONFIG_ENV_FILE, 'utf8') : '');
  const config = normalizeDeployConfig(raw);
  if (target === 'compare') {
    const actual = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
    const legacy = normalizeRecord(actual.extra_environment);
    const expected = config.runtime;
    const keys = [...new Set([...Object.keys(legacy), ...Object.keys(expected)])].sort();
    const missing = keys.filter(key => !(key in legacy));
    const extra = keys.filter(key => !(key in expected));
    const mismatched = keys.filter(key => key in legacy && key in expected && legacy[key] !== expected[key]);
    console.log(JSON.stringify({ contract: 'typescript-vs-legacy', matching: !missing.length && !extra.length && !mismatched.length, missing, extra, mismatched }));
    if (missing.length || extra.length || mismatched.length) process.exitCode = 1;
  } else if (target === 'diagnose') {
    let terminalValid = false;
    let terminalError = '';
    try { validateTerminal(config.runtime); terminalValid = Boolean(config.runtime.MANAGE_TERMINAL_VMS); }
    catch (error) { terminalError = error instanceof Error ? error.message : 'Invalid terminal configuration'; }
    console.log(JSON.stringify({ source: 'GCP_CONFIG_ENV', runtimeKeys: Object.keys(config.runtime).sort(), terminalPresent: Boolean(config.runtime.MANAGE_TERMINAL_VMS), terminalValid, terminalError, gatewayPresent: Boolean(config.runtime.MANAGE_TERMINAL_GATEWAY_URL) }));
    if (terminalError) process.exitCode = 1;
  } else {
    const bindings = deployBindings(raw, target);
    writeFileSync(output, JSON.stringify(bindings), { mode: 0o600 });
    console.log(JSON.stringify({ target, runtimeKeys: Object.keys(bindings.runtime).sort(), cloudflareKeys: Object.keys(bindings.cloudflare).sort(), terminalConfigured: Boolean(bindings.runtime.MANAGE_TERMINAL_VMS) }));
  }
}
