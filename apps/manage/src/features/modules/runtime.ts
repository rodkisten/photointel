import React from 'react';
import { ISOLATED_SANDBOX_ORIGIN, ISOLATED_CODE_ORIGIN } from './security';
import { loadRemote, registerRemotes } from '@module-federation/enhanced/runtime';
import { parseModuleManifest, type RodModuleManifest, type RodModuleProps } from '@rodverse/module-sdk';

// Reviewed release origins only. PR previews deliberately absent from this privileged host.
export const development = import.meta.env.DEV || import.meta.env.MODE === 'federation-smoke';
export const moduleDefinitions = {
  sandbox: {
    id: 'sandbox',
    name: 'rod_sandbox',
    label: 'RodSandbox',
    origin: 'https://sandbox.migos.club',
    manifest: '/rod-module.json',
    route: '/sandbox',
    standalone: '/',
    developmentOrigin: 'http://localhost:4173',
  },
  code: {
    id: 'code',
    name: 'rod_code',
    label: 'Code · Workflow Studio',
    origin: 'https://shell.migos.club',
    manifest: '/workflow/rod-module.json',
    route: '/code',
    standalone: '/workflow/',
    developmentOrigin: 'http://localhost:4175',
  },
} as const;
export type ModuleId = keyof typeof moduleDefinitions;
export interface ModulePolicy {
  module: (typeof moduleDefinitions)[ModuleId];
  allowedOrigins: readonly string[];
  development: boolean;
  channels: Record<string, string>;
  isolated: boolean;
}
export function releasePolicy(id: ModuleId): ModulePolicy {
  const module = moduleDefinitions[id];
  return {
    module,
    allowedOrigins: [module.origin, ...(development ? [module.developmentOrigin] : [])],
    development,
    isolated: false,
    channels: {
      production: module.origin + module.manifest,
      ...(development ? { development: module.developmentOrigin + module.manifest } : {}),
    },
  };
}
export const productionPolicy = releasePolicy('sandbox');
export const productionPolicies = { sandbox: productionPolicy, code: releasePolicy('code') };
export async function readPreviewPolicy(
  signal: AbortSignal,
  id: ModuleId = 'sandbox',
): Promise<ModulePolicy> {
  const response = await fetch('/module-host.json', {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Isolated preview host configuration unavailable');
  const config = (await response.json()) as { mode?: string; sandboxOrigin?: string; codeOrigin?: string };
  if (
    config.mode !== 'isolated-preview' ||
    config.sandboxOrigin !== ISOLATED_SANDBOX_ORIGIN ||
    config.codeOrigin !== ISOLATED_CODE_ORIGIN
  )
    throw new Error('Untrusted preview host configuration');
  const origin = id === 'code' ? ISOLATED_CODE_ORIGIN : ISOLATED_SANDBOX_ORIGIN;
  return {
    module: moduleDefinitions[id],
    allowedOrigins: [origin],
    development: false,
    isolated: true,
    channels: { preview: origin + moduleDefinitions[id].manifest },
  };
}
export type RemoteApp = React.ComponentType<RodModuleProps>;
interface RemoteExports {
  default: RemoteApp;
  reactIdentity: { useState: typeof React.useState; version: string };
}
function trustedManifestUrl(url: string, policy: ModulePolicy) {
  const parsed = new URL(url);
  if (
    !policy.allowedOrigins.includes(parsed.origin) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !(
      parsed.pathname === policy.module.manifest ||
      new RegExp('^/modules/' + policy.module.id + '/[a-f0-9]{40}/rod-module\\.json$').test(parsed.pathname)
    )
  )
    throw new Error('Untrusted manifest URL');
  return parsed.href;
}
export async function fetchManifest(
  url: string,
  signal: AbortSignal,
  policy = productionPolicy,
): Promise<RodModuleManifest> {
  trustedManifestUrl(url, policy);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('json'))
    throw new Error(`Module manifest HTTP ${response.status}: expected JSON (check Access)`);
  const manifest = parseModuleManifest(await response.json(), url, policy.allowedOrigins, policy.development);
  if (manifest.id !== policy.module.id || manifest.name !== policy.module.name)
    throw new Error('Unexpected module identity');
  return manifest;
}
const pinnedShas = new Map<string, string>();
export async function loadModule(
  manifest: RodModuleManifest,
  signal: AbortSignal,
  retry = false,
  policy = productionPolicy,
): Promise<RemoteApp> {
  parseModuleManifest(
    manifest,
    manifest.entry.replace('mf-manifest.json', 'rod-module.json'),
    policy.allowedOrigins,
    policy.development,
  );
  if (manifest.id !== policy.module.id || manifest.name !== policy.module.name)
    throw new Error('Unexpected module identity');
  const pinnedSha = pinnedShas.get(manifest.id);
  if (pinnedSha && pinnedSha !== manifest.gitSha) throw new Error('Reload the page to change module version');
  pinnedShas.set(manifest.id, manifest.gitSha);
  registerRemotes([{ name: manifest.name, entry: manifest.entry, type: 'module' }], { force: retry });
  const remote = await new Promise<RemoteExports>((resolve, reject) => {
    let settled = false;
    const finish = (value: RemoteExports | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const abort = () => finish(new Error('Module load cancelled'));
    const timer = setTimeout(() => finish(new Error('Module load timed out after 20 seconds')), 20000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    loadRemote<RemoteExports>(`${manifest.name}/App`).then(
      (value) => finish(value ?? new Error('Empty module export')),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
  signal.throwIfAborted();
  if (!remote?.default || remote.reactIdentity?.useState !== React.useState)
    throw new Error('Remote React singleton mismatch');
  return remote.default;
}
