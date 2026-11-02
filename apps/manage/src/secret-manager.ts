import { ApiError } from './auth';
import type { Env, Identity } from './auth';
import { parseConfiguration, planConfigChange } from './config-reconcile';
import { configPath, digest, gcpToken, gh, provider, readConfig } from './providers';

const NAME = /^photointel-[a-z0-9-]{1,90}$/;
const KEY = /^MANAGE_[A-Z0-9_]{2,100}$/;
const VERSION = /^[1-9][0-9]{0,9}$/;
const GCP = 'https://secretmanager.googleapis.com/v1/projects/photointel/secrets/';

export type SecretReference = {
  key: string;
  name: string;
  version: string;
};

export function listReferences(raw: string): SecretReference[] {
  const parsed = parseConfiguration(raw);
  const refs = new Map<string, Partial<SecretReference>>();
  for (const [path, value] of Object.entries(parsed)) {
    const match = raw.trimStart().startsWith('{')
      ? /^workflow_secrets\.(MANAGE_[A-Z0-9_]+)\.(name|version)$/.exec(path)
      : /^WORKFLOW_SECRETS__(MANAGE_[A-Z0-9_]+)__(NAME|VERSION)$/.exec(path);
    if (!match || !KEY.test(match[1])) continue;
    const field = match[2].toLowerCase() as 'name' | 'version';
    const entry = refs.get(match[1]) || {};
    entry[field] = raw.trimStart().startsWith('{') ? JSON.parse(value) : value;
    refs.set(match[1], entry);
  }
  return [...refs.entries()]
    .filter(([, v]) => NAME.test(v.name || '') && VERSION.test(v.version || ''))
    .map(([key, v]) => ({ key, name: v.name!, version: v.version! }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function pick(raw: string, key: string): SecretReference {
  if (!KEY.test(key)) throw new ApiError(422, 'SECRET_KEY', 'Secret fora do escopo autorizado');
  const ref = listReferences(raw).find((candidate) => candidate.key === key);
  if (!ref) throw new ApiError(404, 'SECRET_NOT_REFERENCED', 'Secret do Manage não encontrado na configuração');
  return ref;
}

export function replaceReference(raw: string, key: string, oldVersion: string, newVersion: string): string {
  if (raw.trimStart().startsWith('{')) {
    const parsed = JSON.parse(raw) as {
      workflow_secrets?: Record<string, { name?: string; version?: string | number }>;
    };
    const ref = parsed.workflow_secrets?.[key];
    if (!ref || String(ref.version) !== oldVersion)
      throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referência alterada; atualize a tela');
    ref.version = newVersion;
    return JSON.stringify(parsed, null, 2) + '\n';
  }
  // Change *only* the VERSION assignment, preserving all other .env lines,
  // comments, blank lines, CRLFs and repeated identical references.
  const pattern = new RegExp('^([ \\t]*WORKFLOW_SECRETS__' + key +
    '__VERSION[ \\t]*=[ \\t]*)([0-9]+)([ \\t]*(?:#.*)?)$', 'gm');
  let matches = 0;
  const updated = raw.replace(pattern, (_line, prefix: string, value: string, suffix: string) => {
    if (value !== oldVersion) throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referência desatualizada');
    matches += 1;
    return prefix + newVersion + suffix;
  });
  if (!matches) throw new ApiError(409, 'SECRET_VERSION_MISSING', 'Referência ausente');
  return updated;
}

/** Only tiny ASCII fragments may leave the Worker. Never return secret payloads or raw provider errors. */
export function secretFragment(value: string): string {
  if (value.length < 12 || /[^\x20-\x7e]/.test(value)) return '••••••••';
  return value.slice(0, 3) + '••••••••' + value.slice(-3);
}

export async function listManageSecrets(env: Env): Promise<{
  items: SecretReference[];
  config_version: string;
}> {
  const config = await readConfig(env);
  return { items: listReferences(config.value), config_version: config.version };
}

export async function previewSecret(env: Env, identity: Identity, key: string): Promise<{
  key: string; name: string; version: string; fragment: string;
}> {
  const config = await readConfig(env);
  const ref = pick(config.value, key);
  const token = await gcpToken(env, identity);
  // No catch with raw provider body: provider() sanitizes upstream errors.
  const result = await provider(GCP + ref.name + '/versions/' + ref.version + ':access', token) as {
    payload?: { data?: unknown };
  };
  if (typeof result.payload?.data !== 'string' || result.payload.data.length > 10000)
    throw new ApiError(502, 'SECRET_PAYLOAD', 'Versão não pode ser exibida como texto');
  let value: string;
  try {
    const data = Uint8Array.from(atob(result.payload.data), (character) => character.charCodeAt(0));
    value = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ApiError(422, 'SECRET_ENCODING', 'Secret binário não pode ser pré-visualizado');
  }
  return { key, name: ref.name, version: ref.version, fragment: secretFragment(value) };
}

export async function createSecretVersion(
  env: Env,
  identity: Identity,
  input: {
    key?: unknown;
    value?: unknown;
    current_version?: unknown;
    config_version?: unknown;
    confirm?: unknown;
    auto_apply?: unknown;
  },
): Promise<{
  ok: true;
  key: string;
  name: string;
  created_version: string;
  config_updated: boolean;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
}> {
  if (typeof input.key !== 'string' || !KEY.test(input.key) ||
      typeof input.value !== 'string' || input.value.length < 1 || input.value.length > 4096 ||
      /[\r\n\0]/.test(input.value) ||
      typeof input.current_version !== 'string' || !VERSION.test(input.current_version) ||
      typeof input.config_version !== 'string' || !/^[a-f0-9]{64}$/.test(input.config_version) ||
      input.confirm !== 'ROTACIONAR ' + input.key ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean'))
    throw new ApiError(422, 'SECRET_FIELDS', 'Informe um valor de uma linha e confirme a rotação');
  const original = await readConfig(env);
  if (original.version !== input.config_version)
    throw new ApiError(409, 'CONFIG_CONFLICT', 'O .env mudou; recarregue para evitar sobrescrever alterações');
  const ref = pick(original.value, input.key);
  if (ref.version !== input.current_version)
    throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Outra versão está referenciada; recarregue');

  const token = await gcpToken(env, identity);
  const bytes = new TextEncoder().encode(input.value);
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  const created = await provider(GCP + ref.name + ':addVersion', token, {
    method: 'POST',
    body: JSON.stringify({ payload: { data: encoded } }),
  }) as { name?: unknown };
  const version = typeof created.name === 'string' ? created.name.split('/').pop() || '' : '';
  if (!VERSION.test(version))
    throw new ApiError(502, 'SECRET_CREATE', 'Google Cloud não confirmou o número da nova versão');

  // Optimistic check. If GitHub changed after the addVersion, leave the new
  // version available in GCP and do not overwrite someone's configuration.
  const latest = await readConfig(env);
  if (latest.version !== original.version)
    throw new ApiError(409, 'SECRET_CREATED_CONFIG_CONFLICT',
      'Versão ' + version + ' criada, mas o .env mudou. Atualize manualmente a referência.');

  const updated = replaceReference(original.value, input.key, ref.version, version);
  const plan = planConfigChange(original.value, updated);
  if (plan.blocked) throw new ApiError(409, 'SECRET_CREATED_MANUAL',
    'Versão ' + version + ' criada; o plano exige atualização manual da referência.');
  try {
    await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: updated });
  } catch {
    throw new ApiError(502, 'SECRET_CREATED_GITHUB_FAILED',
      'Versão ' + version + ' criada no GCP, mas a referência GitHub não foi atualizada. Atualize manualmente.');
  }

  const dispatches: Array<{ file: string; status: 'queued' | 'failed' }> = [];
  if (input.auto_apply !== false) {
    for (const workflow of plan.workflows) {
      try {
        await gh(env, '/actions/workflows/' + workflow.file + '/dispatches', 'POST', {
          ref: 'main',
          inputs: workflow.file === 'config-sync.yml'
            ? { ...workflow.inputs, config_version: await digest(updated) } : workflow.inputs,
        });
        dispatches.push({ file: workflow.file, status: 'queued' });
      } catch {
        dispatches.push({ file: workflow.file, status: 'failed' });
      }
    }
  }
  console.log(JSON.stringify({
    event: 'manage_secret_version_created',
    key: input.key,
    version,
    operator: identity.email,
    config_updated: true,
    dispatches,
  }));
  return {
    ok: true, key: input.key, name: ref.name, created_version: version,
    config_updated: true, dispatches,
  };
}
, 'gm');
  let matches = 0;
  const updated = raw.replace(pattern, (_line, prefix: string, value: string, suffix: string) => {
    if (value !== oldVersion) throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Referência desatualizada');
    matches += 1;
    return prefix + newVersion + suffix;
  });
  if (!matches) throw new ApiError(409, 'SECRET_VERSION_MISSING', 'Referência ausente');
  return updated;
}

/** Only tiny ASCII fragments may leave the Worker. Never return secret payloads or raw provider errors. */
export function secretFragment(value: string): string {
  if (value.length < 12 || /[^\x20-\x7e]/.test(value)) return '••••••••';
  return value.slice(0, 3) + '••••••••' + value.slice(-3);
}

export async function listManageSecrets(env: Env): Promise<{
  items: SecretReference[];
  config_version: string;
}> {
  const config = await readConfig(env);
  return { items: listReferences(config.value), config_version: config.version };
}

export async function previewSecret(env: Env, identity: Identity, key: string): Promise<{
  key: string; name: string; version: string; fragment: string;
}> {
  const config = await readConfig(env);
  const ref = pick(config.value, key);
  const token = await gcpToken(env, identity);
  // No catch with raw provider body: provider() sanitizes upstream errors.
  const result = await provider(GCP + ref.name + '/versions/' + ref.version + ':access', token) as {
    payload?: { data?: unknown };
  };
  if (typeof result.payload?.data !== 'string' || result.payload.data.length > 10000)
    throw new ApiError(502, 'SECRET_PAYLOAD', 'Versão não pode ser exibida como texto');
  let value: string;
  try {
    const data = Uint8Array.from(atob(result.payload.data), (character) => character.charCodeAt(0));
    value = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ApiError(422, 'SECRET_ENCODING', 'Secret binário não pode ser pré-visualizado');
  }
  return { key, name: ref.name, version: ref.version, fragment: secretFragment(value) };
}

export async function createSecretVersion(
  env: Env,
  identity: Identity,
  input: {
    key?: unknown;
    value?: unknown;
    current_version?: unknown;
    config_version?: unknown;
    confirm?: unknown;
    auto_apply?: unknown;
  },
): Promise<{
  ok: true;
  key: string;
  name: string;
  created_version: string;
  config_updated: boolean;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
}> {
  if (typeof input.key !== 'string' || !KEY.test(input.key) ||
      typeof input.value !== 'string' || input.value.length < 1 || input.value.length > 4096 ||
      /[\r\n\0]/.test(input.value) ||
      typeof input.current_version !== 'string' || !VERSION.test(input.current_version) ||
      typeof input.config_version !== 'string' || !/^[a-f0-9]{64}$/.test(input.config_version) ||
      input.confirm !== 'ROTACIONAR ' + input.key ||
      (input.auto_apply !== undefined && typeof input.auto_apply !== 'boolean'))
    throw new ApiError(422, 'SECRET_FIELDS', 'Informe um valor de uma linha e confirme a rotação');
  const original = await readConfig(env);
  if (original.version !== input.config_version)
    throw new ApiError(409, 'CONFIG_CONFLICT', 'O .env mudou; recarregue para evitar sobrescrever alterações');
  const ref = pick(original.value, input.key);
  if (ref.version !== input.current_version)
    throw new ApiError(409, 'SECRET_VERSION_CONFLICT', 'Outra versão está referenciada; recarregue');

  const token = await gcpToken(env, identity);
  const bytes = new TextEncoder().encode(input.value);
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  const created = await provider(GCP + ref.name + ':addVersion', token, {
    method: 'POST',
    body: JSON.stringify({ payload: { data: encoded } }),
  }) as { name?: unknown };
  const version = typeof created.name === 'string' ? created.name.split('/').pop() || '' : '';
  if (!VERSION.test(version))
    throw new ApiError(502, 'SECRET_CREATE', 'Google Cloud não confirmou o número da nova versão');

  // Optimistic check. If GitHub changed after the addVersion, leave the new
  // version available in GCP and do not overwrite someone's configuration.
  const latest = await readConfig(env);
  if (latest.version !== original.version)
    throw new ApiError(409, 'SECRET_CREATED_CONFIG_CONFLICT',
      'Versão ' + version + ' criada, mas o .env mudou. Atualize manualmente a referência.');

  const updated = replaceReference(original.value, input.key, ref.version, version);
  const plan = planConfigChange(original.value, updated);
  if (plan.blocked) throw new ApiError(409, 'SECRET_CREATED_MANUAL',
    'Versão ' + version + ' criada; o plano exige atualização manual da referência.');
  try {
    await gh(env, configPath(env), 'PATCH', { name: 'GCP_CONFIG_ENV', value: updated });
  } catch {
    throw new ApiError(502, 'SECRET_CREATED_GITHUB_FAILED',
      'Versão ' + version + ' criada no GCP, mas a referência GitHub não foi atualizada. Atualize manualmente.');
  }

  const dispatches: Array<{ file: string; status: 'queued' | 'failed' }> = [];
  if (input.auto_apply !== false) {
    for (const workflow of plan.workflows) {
      try {
        await gh(env, '/actions/workflows/' + workflow.file + '/dispatches', 'POST', {
          ref: 'main',
          inputs: workflow.file === 'config-sync.yml'
            ? { ...workflow.inputs, config_version: await digest(updated) } : workflow.inputs,
        });
        dispatches.push({ file: workflow.file, status: 'queued' });
      } catch {
        dispatches.push({ file: workflow.file, status: 'failed' });
      }
    }
  }
  console.log(JSON.stringify({
    event: 'manage_secret_version_created',
    key: input.key,
    version,
    operator: identity.email,
    config_updated: true,
    dispatches,
  }));
  return {
    ok: true, key: input.key, name: ref.name, created_version: version,
    config_updated: true, dispatches,
  };
}
