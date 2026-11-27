import React from 'react';
import { loadRemote, registerRemotes } from '@module-federation/enhanced/runtime';
import { parseModuleManifest, type RodModuleManifest, type RodModuleProps } from '@rodverse/module-sdk';

// Reviewed release origins only. PR previews deliberately absent from this privileged host.
export const development = import.meta.env.DEV || import.meta.env.MODE === 'federation-smoke';
export const allowedOrigins = [
  'https://sandbox.migos.club',
  ...(development ? ['http://localhost:4173', 'http://127.0.0.1:4173'] : []),
];
export const channels = {
  production: 'https://sandbox.migos.club/rod-module.json',
  ...(development ? { development: 'http://localhost:4173/rod-module.json' } : {}),
} as Record<string, string>;
export type RemoteApp = React.ComponentType<RodModuleProps>;
interface RemoteExports {
  default: RemoteApp;
  reactIdentity: { useState: typeof React.useState; version: string };
}
function trustedManifestUrl(url: string) {
  const parsed = new URL(url);
  if (
    !allowedOrigins.includes(parsed.origin) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !(
      /^\/rod-module.json$/.test(parsed.pathname) ||
      /^\/modules\/sandbox\/[a-f0-9]{40}\/rod-module.json$/.test(parsed.pathname)
    )
  )
    throw new Error('Untrusted manifest URL');
  return parsed.href;
}
export async function fetchManifest(url: string, signal: AbortSignal): Promise<RodModuleManifest> {
  trustedManifestUrl(url);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('json'))
    throw new Error(`Module manifest HTTP ${response.status}: expected JSON (check Access)`);
  const manifest = parseModuleManifest(await response.json(), url, allowedOrigins, development);
  if (manifest.id !== 'sandbox' || manifest.name !== 'rod_sandbox')
    throw new Error('Unexpected module identity');
  return manifest;
}
let pinnedSha: string | undefined;
export async function loadSandbox(
  manifest: RodModuleManifest,
  signal: AbortSignal,
  retry = false,
): Promise<RemoteApp> {
  parseModuleManifest(
    manifest,
    manifest.entry.replace('mf-manifest.json', 'rod-module.json'),
    allowedOrigins,
    development,
  );
  if (pinnedSha && pinnedSha !== manifest.gitSha) throw new Error('Reload the page to change module version');
  pinnedSha = manifest.gitSha;
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
