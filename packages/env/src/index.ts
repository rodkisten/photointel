/**
 * Shared, side-effect-free PhotoIntel environment parser.
 * Never reads process.env, Cloudflare bindings or Secret Manager directly.
 * Runtime adapters own transport, authentication and secret resolution.
 */
export type SecretReference = {
  scope: 'runtime' | 'workflow';
  key: string;
  name: string;
  version: string;
};
export type ParsedEnvironment = {
  entries: Record<string, string>;
  workflows: Record<string, unknown>;
  runtime: Record<string, string>;
  cloudflare: Record<string, string>;
  secrets: SecretReference[];
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\$\$|\$\{([A-Za-z][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}/g;
const SECRET_KEY = /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|SESSION|PEPPER|AUTH)/i;

export function parseDotenv(raw: string): Record<string, string> {
  if (raw.length > 512_000) throw new Error('Configuration exceeds 512 KB');
  const entries: Record<string, string> = Object.create(null);
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error('Invalid .env syntax at line ' + (index + 1));
    const [, key, source] = match;
    let value = source;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    if (value.startsWith('json:')) value = JSON.stringify(JSON.parse(value.slice(5)));
    if (Object.hasOwn(entries, key) && entries[key] !== value) {
      throw new Error('Conflicting duplicate key at line ' + (index + 1) + ': ' + key);
    }
    entries[key] = value;
  }
  return entries;
}

export function resolveReferences(entries: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const visiting = new Set<string>();
  function resolve(key: string, depth: number): string {
    if (Object.hasOwn(result, key)) return result[key];
    if (visiting.has(key) || depth > 32) throw new Error('Circular or deep reference: ' + key);
    if (!Object.hasOwn(entries, key)) throw new Error('Unknown reference: ' + key);
    visiting.add(key);
    try {
      const value = entries[key].replace(PLACEHOLDER, (token, name: string, operator: string, fallback: string) => {
        if (token === '$$') return '$';
        if (!Object.hasOwn(entries, name) || (operator === ':-' && entries[name] === '')) {
          if (!operator) throw new Error('Unknown reference: ' + name);
          return (fallback || '').replace(PLACEHOLDER, (nested, nestedName: string) =>
            nested === '$$' ? '$' : resolve(nestedName, depth + 1));
        }
        return resolve(name, depth + 1);
      });
      if (new TextEncoder().encode(value).length > 65536) throw new Error('Expanded value too large: ' + key);
      result[key] = value;
      return value;
    } finally {
      visiting.delete(key);
    }
  }
  for (const key of Object.keys(entries)) resolve(key, 0);
  return result;
}

function assignNested(target: Record<string, unknown>, parts: string[], value: string): void {
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!IDENTIFIER.test(part) || part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new Error('Invalid nested configuration key');
    }
    if (!Object.hasOwn(node, part)) node[part] = Object.create(null);
    if (typeof node[part] !== 'object' || node[part] === null) throw new Error('Conflicting nested key');
    node = node[part] as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (!last || !IDENTIFIER.test(last) || ['__proto__', 'constructor', 'prototype'].includes(last)) {
    throw new Error('Invalid configuration key');
  }
  node[last] = value;
}

export function parseEnvironment(raw: string): ParsedEnvironment {
  const entries = resolveReferences(
    raw.trimStart().startsWith('{') ? JSON.parse(raw) as Record<string, string> : parseDotenv(raw),
  );
  const workflows: Record<string, unknown> = Object.create(null);
  const runtime: Record<string, string> = Object.create(null);
  const cloudflare: Record<string, string> = Object.create(null);
  const secrets: SecretReference[] = [];
  const prefix = entries.SECRET_NAME_PREFIX?.replace(/-?$/, '-') || 'photointel-';
  const references = new Map<string, SecretReference>();
  const wifKeys = new Set([
    'GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_DEPLOY_SERVICE_ACCOUNT',
    'GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_BOOTSTRAP_SERVICE_ACCOUNT',
  ]);
  const typed = (value: string): unknown => {
    if (value.startsWith('json:')) return JSON.parse(value.slice(5));
    if (/^(?:true|false|null)$/.test(value) ||
        /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$/.test(value)) {
      return JSON.parse(value);
    }
    if (/^[{[]/.test(value)) {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  };
  const validSecretName = /^[a-z][a-z0-9-]{0,254}$/;
  const validVersion = /^(?:latest|[1-9][0-9]{0,9})$/;
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') throw new Error('Expected string value for ' + key);
    if (key === 'SECRET_NAME_PREFIX' || wifKeys.has(key)) continue;
    const explicit = /^(SECRET|WORKFLOW_SECRET)__([A-Z][A-Z0-9_]*)$/.exec(key);
    const legacy = /^(SECRETS|WORKFLOW_SECRETS)__([A-Z][A-Z0-9_]*)__(NAME|VERSION)$/.exec(key);
    if (explicit || legacy || value.startsWith('secret://')) {
      const scope = (explicit?.[1] === 'WORKFLOW_SECRET' || legacy?.[1] === 'WORKFLOW_SECRETS')
        ? 'workflow' : 'runtime';
      const target = explicit?.[2] || legacy?.[2] || key;
      if (!/^[A-Z][A-Z0-9_]*$/.test(target)) throw new Error('Invalid secret binding: ' + key);
      const id = scope + ':' + target;
      const previous = references.get(id);
      let name = previous?.name || '';
      let version = previous?.version || 'latest';
      if (legacy) {
        if (legacy[3] === 'NAME') name = value;
        else version = value;
      } else {
        const reference = value.startsWith('secret://') ? value.slice('secret://'.length) : value;
        const at = reference.lastIndexOf('@');
        name = (at < 0 ? reference : reference.slice(0, at)) ||
          prefix + target.toLowerCase().replaceAll('_', '-');
        version = at < 0 ? 'latest' : reference.slice(at + 1);
      }
      references.set(id, {scope, key: target, name, version});
      continue;
    }
    if (key.startsWith('ENV__') || key.startsWith('EXTRA_ENVIRONMENT__')) {
      const target = key.split('__').slice(1).join('__');
      if (!/^[A-Z][A-Z0-9_]*$/.test(target)) throw new Error('Invalid runtime key: ' + key);
      const parsed = typed(value);
      runtime[target] = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } else if (key.startsWith('CF__')) {
      const target = key.slice(4);
      if (!/^[A-Z][A-Z0-9_]*$/.test(target)) throw new Error('Invalid Cloudflare key: ' + key);
      const parsed = typed(value);
      cloudflare[target] = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } else if (key.startsWith('WF__') || key.startsWith('WORKFLOWS__')) {
      const parts = key.split('__').slice(1);
      assignNested(workflows, parts, value);
    }
  }
  for (const reference of references.values()) {
    if (!validSecretName.test(reference.name) || !validVersion.test(reference.version)) {
      throw new Error('Invalid Secret Manager name/version for ' + reference.key);
    }
    secrets.push(reference);
  }
  return {entries, workflows, runtime, cloudflare, secrets};
}

export function maskValue(key: string, value: string): string {
  if (!SECRET_KEY.test(key)) return value;
  return value.length < 12 ? '••••••••' : value.slice(0, 3) + '••••••' + value.slice(-3);
}

export function previewEnvironment(raw: string): ParsedEnvironment {
  const parsed = parseEnvironment(raw);
  return {
    ...parsed,
    entries: Object.fromEntries(Object.entries(parsed.entries).map(([key, value]) => [key, maskValue(key, value)])),
    runtime: Object.fromEntries(Object.entries(parsed.runtime).map(([key, value]) => [key, maskValue(key, value)])),
    cloudflare: Object.fromEntries(Object.entries(parsed.cloudflare).map(([key, value]) => [key, maskValue(key, value)])),
  };
}
