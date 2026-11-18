import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnvironment } from './index.ts';

export type DeploymentTarget = 'production' | 'preview';

export function normalizeDeployConfig(raw: string) {
  const source = raw.trim();
  if (!source) throw new Error('GCP_CONFIG_ENV is empty');
  if (source.startsWith('{')) {
    const object: unknown = JSON.parse(source);
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected JSON object');
    const config = object as Record<string, unknown>;
    if ('extra_environment' in config || 'workflow_secrets' in config || 'cloudflare_environment' in config) {
      return {
        runtime: normalizeRecord(config.extra_environment),
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
  validateTerminal(config.runtime);
  const runtime = { ...config.runtime };
  if (target === 'preview') {
    delete runtime.MANAGE_TERMINAL_GATEWAY_SECRET;
    delete runtime.MANAGE_CODESPACES_USER_TOKEN;
    delete runtime.MANAGE_TERMINAL_VMS;
    delete runtime.MANAGE_TERMINAL_GATEWAY_URL;
    runtime.PHOTOINTEL_PREVIEW = 'true';
  }
  return { runtime, cloudflare: config.cloudflare, workflows: config.workflows };
}

if (process.argv[1]?.endsWith('/deploy.ts')) {
  const [,, target, output] = process.argv;
  if (target !== 'production' && target !== 'preview') throw new Error('Usage: node deploy.ts production|preview <output.json>');
  if (!output) throw new Error('Output path required');
  const raw = process.env.GCP_CONFIG_ENV ?? (process.env.GCP_CONFIG_ENV_FILE ? readFileSync(process.env.GCP_CONFIG_ENV_FILE, 'utf8') : '');
  const bindings = deployBindings(raw, target);
  writeFileSync(output, JSON.stringify(bindings), { mode: 0o600 });
  console.log(JSON.stringify({ target, runtimeKeys: Object.keys(bindings.runtime).sort(), cloudflareKeys: Object.keys(bindings.cloudflare).sort(), terminalConfigured: Boolean(bindings.runtime.MANAGE_TERMINAL_VMS) }));
}
