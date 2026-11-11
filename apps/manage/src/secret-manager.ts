import { ApiError } from './auth';
import type { Env, Identity } from './auth';
import { parseConfiguration, planConfigChange } from './config-reconcile';
import { configPath, digest, gcpToken, gh, provider, readConfig } from './providers';

const PROJECT = 'photointel';
const ROOT = 'https://secretmanager.googleapis.com/v1/projects/' + PROJECT + '/secrets';
const NAME = /^[A-Za-z0-9_-]{1,255}$/;
const CREATE_NAME = /^photointel-[a-z0-9-]{1,90}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,120}$/;
const VERSION = /^[1-9][0-9]{0,15}$/;
const MAX_BYTES = 65536;

export type SecretReference = {
  scope: 'secrets' | 'workflow_secrets' | 'expected';
  key: string;
  name: string;
  version: string;
};

export type SecretItem = {
  name: string;
  exists: boolean | 'unknown';
  references: SecretReference[];
  created_at?: string;
};

export type SecretVersion = {
  version: string;
  state: string;
  created_at?: string;
  destroyed_at?: string;
};

export function listReferences(raw: string): SecretReference[] {
  const isJson = raw.trimStart().startsWith('{');
  const parsed = parseConfiguration(raw);
  const refs = new Map<string, Partial<SecretReference>>();
  for (const [path, serialized] of Object.entries(parsed)) {
    const match = isJson
      ? /^(secrets|workflow_secrets)\.([A-Z][A-Z0-9_]*)\.(name|version)$/.exec(path)
      : /^(SECRETS|WORKFLOW_SECRETS)__([A-Z][A-Z0-9_]*)__(NAME|VERSION)$/.exec(path);
    if (!match || !KEY.test(match[2])) continue;
    const scope = match[1].toLowerCase() as 'secrets' | 'workflow_secrets';
    const field = match[3].toLowerCase() as 'name' | 'version';
    const id = scope + ':' + match[2];
    const entry = refs.get(id) || { scope, key: match[2] };
    const value = isJson ? JSON.parse(serialized) as unknown : serialized;
    entry[field] = value === null || value === undefined ? '' : String(value);
    refs.set(id, entry);
  }
  if (!isJson) {
    const prefix = parsed.SECRET_NAME_PREFIX?.replace(/-?$/, '-') || 'photointel-';
    for (const [path, value] of Object.entries(parsed)) {
      const compact = /^(SECRET|WORKFLOW_SECRET)__([A-Z][A-Z0-9_]*)$/.exec(path);
      const uri = !compact && /^([A-Z][A-Z0-9_]*)$/.exec(path) && value.startsWith('secret://');
      if (!compact && !uri) continue;
      const scope = compact?.[1] === 'WORKFLOW_SECRET' ? 'workflow_secrets' : 'secrets';
      const key = compact?.[2] || path;
      const reference = uri ? value.slice('secret://'.length) : value;
      const at = reference.lastIndexOf('@');
      const name = (at >= 0 ? reference.slice(0, at) : reference) ||
        prefix + key.toLowerCase().replaceAll('_', '-');
      const version = at >= 0 ? reference.slice(at + 1) : 'latest';
      if (!NAME.test(name) || !(VERSION.test(version) || version === 'latest')) continue;
      refs.set(scope + ':' + key, { scope, key, name, version });
    }
  }
  return [...refs.values()]
    .filter((entry) => NAME.test(entry.name || ''))
    .map((entry) => ({
      scope: entry.scope!,
      key: entry.key!,
      name: entry.name!,
      version: VERSION.test(entry.version || '') || entry.version === 'latest' ? entry.version! : '',
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function replaceReference(
  raw: string,
  key: string,
  oldVersion: string,
  newVersion: string,
  scope: 'secrets' | 'workflow_secrets' = 'workflow_secrets',
): string {
  if (!KEY.test(key) || !VERSION.test(oldVersion) || !VERSION.test(newVersion))
    throw new ApiError(422, 'SECRET_VERSION', 'Referência de versão inválida');
  if (raw.trimStart().startsWith('{')) {
    const parsed = JSON.parse(raw) as Record<string, Record<string, { name?: string; version?: string | number }>>;
    const ref = parsed[scope]?.[key];
    if (!ref || String(ref.version) !== oldVersion)
      throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referência alterada; atualize a tela');
    ref.version = newVersion;
    return JSON.stringify(parsed, null, 2) + '\n';
  }
  const prefix = (scope === 'secrets' ? 'SECRETS__' : 'WORKFLOW_SECRETS__') + key + '__VERSION';
  const pattern = new RegExp(
    '^([ \\t]*(?:export[ \\t]+)?' + prefix + '[ \\t]*=[ \\t]*)([0-9]+)([ \\t]*(?:#.*)?)$',
    'gm',
  );
  let matches = 0;
  const updated = raw.replace(pattern, (_line, head: string, value: string, tail: string) => {
    if (value !== oldVersion)
      throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referência desatualizada');
    matches += 1;
    return head + newVersion + tail;
  });
  if (!matches) {
    const compactKey = (scope === 'secrets' ? 'SECRET__' : 'WORKFLOW_SECRET__') + key;
    const compactPattern = new RegExp(
      '^([ \\t]*(?:export[ \\t]+)?' + compactKey + '[ \\t]*=[ \\t]*)([^\\r\\n#]*?)([ \\t]*(?:#.*)?)$',
      'gm',
    );
    let count = 0;
    const compactUpdated = raw.replace(compactPattern, (_line, head: string, value: string, tail: string) => {
      const ref = value.trim();
      const at = ref.lastIndexOf('@');
      const version = at < 0 ? 'latest' : ref.slice(at + 1);
      if (version !== oldVersion)
        throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referência desatualizada');
      count += 1;
      return head + (at < 0 ? ref : ref.slice(0, at)) + '@' + newVersion + tail;
    });
    if (count === 1) return compactUpdated;
    if (count > 1) throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referências duplicadas');
    throw new ApiError(409, 'SECRET_VERSION_MISSING', 'Referência ausente');
  }
  return updated;
}

export function secretFragment(value: string): string {
  if (value.length < 12 || /[^\x20-\x7e]/.test(value)) return '••••••••';
  return value.slice(0, 3) + '••••••••' + value.slice(-3);
}

export function validateSecretValue(name: string, value: string): void {
  if (typeof value !== 'string' || !value || value.includes('\0') || new TextEncoder().encode(value).length > MAX_BYTES)
    throw new ApiError(422, 'SECRET_VALUE', 'Informe um valor de até 64 KiB, sem bytes nulos');
  if (name === 'photointel-session-aead-key') {
    try {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ||
          atob(value).length !== 32)
        throw new Error('invalid key length');
    } catch {
      throw new ApiError(
        422,
        'ICLOUD_SESSION_KEY_INVALID',
        'ICLOUD_SESSION_KEY exige 32 bytes aleatórios em base64 (44 caracteres). Não use a senha Apple.',
      );
    }
  }
}

function parseName(value: string): string {
  if (!NAME.test(value)) throw new ApiError(422, 'SECRET_NAME', 'Nome de secret inválido');
  return value;
}

async function gcpSecrets(env: Env, identity: Identity): Promise<{ secrets: Array<{ name: string; createTime?: string }> }> {
  const token = await gcpToken(env, identity);
  const items: Array<{ name: string; createTime?: string }> = [];
  let cursor = '';
  for (let page = 0; page < 50; page += 1) {
    const result = await provider(
      ROOT + '?pageSize=100' + (cursor ? '&pageToken=' + encodeURIComponent(cursor) : ''),
      token,
    ) as { secrets?: Array<{ name?: string; createTime?: string }>; nextPageToken?: string };
    for (const entry of result.secrets || []) {
      const name = typeof entry.name === 'string' ? entry.name.split('/').pop() || '' : '';
      if (NAME.test(name)) items.push({ name, createTime: entry.createTime });
    }
    cursor = result.nextPageToken || '';
    if (!cursor) return { secrets: items };
  }
  throw new ApiError(502, 'SECRET_LIST_LIMIT', 'Há mais de 5.000 secrets; inventário incompleto');
}

export async function listManageSecrets(env: Env, identity: Identity): Promise<{
  items: SecretItem[];
  config_version: string;
  warning?: string;
}> {
  const config = await readConfig(env);
  const refs = listReferences(config.value);
  if (!refs.some((ref) => ref.key === 'ICLOUD_SESSION_KEY'))
    refs.push({
      scope: 'expected',
      key: 'ICLOUD_SESSION_KEY',
      name: 'photointel-session-aead-key',
      version: '',
    });
  let inventory: Array<{ name: string; createTime?: string }> = [];
  let warning: string | undefined;
  try {
    inventory = (await gcpSecrets(env, identity)).secrets;
  } catch (error) {
    if (!(error instanceof ApiError) || !['PROVIDER_403', 'GCP_SECRET_MANAGER_403'].includes(error.code)) throw error;
    warning = 'Sem permissão para listar segredos no GCP. Execute Setup GCP → permissions; as referências abaixo vêm apenas do .env.';
  }
  const indexed = new Map<string, SecretItem>();
  for (const entry of inventory)
    indexed.set(entry.name, { name: entry.name, exists: true, references: [], created_at: entry.createTime });
  for (const ref of refs) {
    const entry: SecretItem = indexed.get(ref.name) || {
      name: ref.name,
      exists: warning ? 'unknown' as const : false,
      references: [],
    };
    entry.references.push(ref);
    indexed.set(ref.name, entry);
  }
  return {
    items: [...indexed.values()].sort((a, b) => {
      const aIcloud = a.references.some((r) => r.key === 'ICLOUD_SESSION_KEY') ? -1 : 0;
      const bIcloud = b.references.some((r) => r.key === 'ICLOUD_SESSION_KEY') ? -1 : 0;
      return aIcloud - bIcloud || a.name.localeCompare(b.name);
    }),
    config_version: config.version,
    ...(warning ? { warning } : {}),
  };
}

export async function listSecretVersions(
  env: Env,
  identity: Identity,
  name: string,
  pageToken = '',
): Promise<{ items: SecretVersion[]; next_page_token: string }> {
  parseName(name);
  if (pageToken.length > 512 || !/^[A-Za-z0-9_+/\-=]*$/.test(pageToken))
    throw new ApiError(422, 'PAGE_TOKEN', 'Marcador de página inválido');
  const token = await gcpToken(env, identity);
  const response = await provider(
    ROOT + '/' + name + '/versions?pageSize=100' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''),
    token,
  ) as {
    versions?: Array<{ name?: string; state?: string; createTime?: string; destroyTime?: string }>;
    nextPageToken?: string;
  };
  return {
    items: (response.versions || [])
      .map((version) => ({
        version: String(version.name || '').split('/').pop() || '',
        state: version.state || 'UNKNOWN',
        created_at: version.createTime,
        destroyed_at: version.destroyTime,
      }))
      .filter((item) => VERSION.test(item.version)),
    next_page_token: response.nextPageToken || '',
  };
}

export async function previewSecret(
  env: Env,
  identity: Identity,
  name: string,
  version: string,
): Promise<{ name: string; version: string; fragment: string }> {
  parseName(name);
  if (!VERSION.test(version)) throw new ApiError(422, 'SECRET_VERSION', 'Escolha uma versão numérica');
  const token = await gcpToken(env, identity);
  const result = await provider(ROOT + '/' + name + '/versions/' + version + ':access', token) as {
    payload?: { data?: unknown };
  };
  if (typeof result.payload?.data !== 'string' || result.payload.data.length > 100_000)
    throw new ApiError(502, 'SECRET_PAYLOAD', 'Versão não pode ser exibida como texto');
  try {
    const bytes = Uint8Array.from(atob(result.payload.data), (c) => c.charCodeAt(0));
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { name, version, fragment: secretFragment(value) };
  } catch {
    return { name, version, fragment: '••••••••' };
  }
}

export async function createSecret(
  env: Env,
  identity: Identity,
  input: { name?: unknown; confirm?: unknown },
): Promise<{ ok: true; name: string }> {
  if (typeof input.name !== 'string' || !CREATE_NAME.test(input.name) ||
      input.confirm !== 'CRIAR ' + input.name)
    throw new ApiError(422, 'SECRET_CREATE_FIELDS', 'Nome photointel-* e confirmação obrigatórios');
  const token = await gcpToken(env, identity);
  await provider(ROOT + '?secretId=' + encodeURIComponent(input.name), token, {
    method: 'POST',
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  console.log(JSON.stringify({ event: 'manage_secret_created', name: input.name, operator: identity.email }));
  return { ok: true, name: input.name };
}

export async function createSecretVersion(
  env: Env,
  identity: Identity,
  name: string,
  input: {
    value?: unknown;
    config_version?: unknown;
    confirm?: unknown;
    auto_apply?: unknown;
    update_references?: unknown;
  },
): Promise<{
  ok: true;
  name: string;
  created_version: string;
  config_updated: boolean;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
  manual: string[];
}> {
  parseName(name);
  if (typeof input.value !== 'string' || typeof input.config_version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.config_version) ||
      input.confirm !== 'ROTACIONAR ' + name ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean') ||
      (input.update_references !== undefined && typeof input.update_references !== 'boolean'))
    throw new ApiError(422, 'SECRET_FIELDS', 'Informe o valor e confirme a criação da versão');
  validateSecretValue(name, input.value);
  const original = await readConfig(env);
  if (original.version !== input.config_version)
    throw new ApiError(409, 'CONFIG_CONFLICT', 'O .env mudou. Atualize a tela antes de gravar.');
  const referenced = listReferences(original.value)
    .filter((ref) => ref.name === name && ref.scope !== 'expected');
  const toUpdate = input.update_references === false ? [] : referenced;
  if (toUpdate.some((ref) => !VERSION.test(ref.version)))
    throw new ApiError(409, 'SECRET_REFERENCE_VERSION', 'Referência sem versão numérica. Corrija o .env antes de ativar.');
  const token = await gcpToken(env, identity);
  const bytes = new TextEncoder().encode(input.value);
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  const created = await provider(ROOT + '/' + name + ':addVersion', token, {
    method: 'POST',
    body: JSON.stringify({ payload: { data: encoded } }),
  }) as { name?: unknown };
  const version = typeof created.name === 'string' ? created.name.split('/').pop() || '' : '';
  if (!VERSION.test(version))
    throw new ApiError(502, 'SECRET_CREATE', 'GCP não confirmou o número da nova versão');

  const dispatches: Array<{ file: string; status: 'queued' | 'failed' }> = [];
  const manual: string[] = [];
  if (!toUpdate.length) {
    manual.push('Versão criada no GCP, mas nenhuma referência de produção foi alterada.');
  } else {
    const latest = await readConfig(env);
    if (latest.version !== original.version)
      throw new ApiError(
        409, 'SECRET_CREATED_CONFIG_CONFLICT',
        'Versão ' + version + ' criada, mas o .env mudou. Atualize manualmente a referência.',
      );
    let updated = original.value;
    for (const ref of toUpdate)
      updated = replaceReference(updated, ref.key, ref.version, version, ref.scope as 'secrets' | 'workflow_secrets');
    const plan = planConfigChange(original.value, updated);
    if (plan.blocked)
      throw new ApiError(
        409, 'SECRET_CREATED_MANUAL',
        'Versão ' + version + ' criada; o plano exige atualização manual da referência.',
      );
    try {
      await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: updated });
    } catch {
      throw new ApiError(
        502, 'SECRET_CREATED_GITHUB_FAILED',
        'Versão ' + version + ' criada, mas o GitHub não foi atualizado. Ajuste a referência manualmente.',
      );
    }
    manual.push(...plan.manual);
    if (input.auto_apply !== false) {
      for (const workflow of plan.workflows) {
        try {
          await gh(env, '/actions/workflows/' + workflow.file + '/dispatches', 'POST', {
            ref: 'main',
            inputs: workflow.file === 'config-sync.yml'
              ? { ...workflow.inputs, config_version: await digest(updated) }
              : workflow.inputs,
          });
          dispatches.push({ file: workflow.file, status: 'queued' });
        } catch {
          dispatches.push({ file: workflow.file, status: 'failed' });
        }
      }
    }
  }
  console.log(JSON.stringify({
    event: 'manage_secret_version_created',
    name, version, operator: identity.email,
    config_updated: toUpdate.length > 0, dispatches,
  }));
  return {
    ok: true, name, created_version: version,
    config_updated: toUpdate.length > 0, dispatches, manual,
  };
}


/** Repoint production to an already-existing, ENABLED version (rollback). */
export async function activateSecretVersion(
  env: Env,
  identity: Identity,
  name: string,
  input: { version?: unknown; config_version?: unknown; confirm?: unknown; auto_apply?: unknown },
): Promise<{
  ok: true;
  name: string;
  activated_version: string;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
  manual: string[];
}> {
  parseName(name);
  if (typeof input.version !== 'string' || !VERSION.test(input.version) ||
      typeof input.config_version !== 'string' || !/^[a-f0-9]{64}$/.test(input.config_version) ||
      input.confirm !== 'ATIVAR ' + name + ' v' + input.version ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean'))
    throw new ApiError(422, 'SECRET_ACTIVATE_FIELDS', 'Informe a versão e confirme a ativação');
  const original = await readConfig(env);
  if (original.version !== input.config_version)
    throw new ApiError(409, 'CONFIG_CONFLICT', 'O .env mudou. Atualize a tela antes de ativar.');
  const references = listReferences(original.value).filter((ref) => ref.name === name && ref.scope !== 'expected');
  if (!references.length)
    throw new ApiError(409, 'SECRET_NOT_REFERENCED', 'Secret não referenciado no .env de produção.');
  if (references.some((ref) => !VERSION.test(ref.version)))
    throw new ApiError(409, 'SECRET_REFERENCE_VERSION', 'Há referência sem versão válida.');
  if (references.every((ref) => ref.version === input.version))
    throw new ApiError(409, 'SECRET_ALREADY_ACTIVE', 'Essa versão já está referenciada.');
  const token = await gcpToken(env, identity);
  const check = await provider(ROOT + '/' + name + '/versions/' + input.version, token) as { state?: string };
  if (check.state !== 'ENABLED')
    throw new ApiError(422, 'SECRET_NOT_ENABLED', 'Somente versões ENABLED podem ser ativadas.');
  const latest = await readConfig(env);
  if (latest.version !== original.version)
    throw new ApiError(409, 'CONFIG_CONFLICT', 'A configuração mudou durante a verificação.');
  let updated = original.value;
  for (const ref of references)
    if (ref.version !== input.version)
      updated = replaceReference(updated, ref.key, ref.version, input.version, ref.scope as 'secrets' | 'workflow_secrets');
  const plan = planConfigChange(original.value, updated);
  if (plan.blocked)
    throw new ApiError(409, 'SECRET_ACTIVATION_MANUAL', 'O plano exige atualização manual.');
  await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: updated });
  const dispatches: Array<{ file: string; status: 'queued' | 'failed' }> = [];
  if (input.auto_apply !== false) {
    for (const workflow of plan.workflows) {
      try {
        await gh(env, '/actions/workflows/' + workflow.file + '/dispatches', 'POST', {
          ref: 'main',
          inputs: workflow.file === 'config-sync.yml'
            ? { ...workflow.inputs, config_version: await digest(updated) }
            : workflow.inputs,
        });
        dispatches.push({ file: workflow.file, status: 'queued' });
      } catch {
        dispatches.push({ file: workflow.file, status: 'failed' });
      }
    }
  }
  console.log(JSON.stringify({
    event: 'manage_secret_version_activated',
    name, version: input.version, operator: identity.email, dispatches,
  }));
  return {
    ok: true, name, activated_version: input.version,
    dispatches, manual: plan.manual,
  };
}
