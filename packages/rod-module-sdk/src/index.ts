/** Browser-safe contracts only. Never carry infrastructure credentials. */
export const CONTRACT_MAJOR = 1;
export interface RodModuleManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  gitSha: string;
  contractMajor: number;
  entry: string;
  standaloneUrl: string;
  exposes: string[];
  capabilities: string[];
}
export interface RodModuleContext {
  contractMajor: 1;
  host: { name: string; version: string; mode: 'standalone' | 'federated' };
  workspace: { id: string; repository?: string };
  identity: { id: string; displayName?: string } | null;
  location: { pathname: string; search: string };
  navigate: (relativePath: string) => void;
  theme: { mode: 'light' | 'dark'; tokens: Readonly<Record<string, string>> };
  /** Portal must remain in the module's styled boundary. */
  portalContainer?: HTMLElement;
  notify: (notification: { title: string; message?: string; level?: 'info' | 'error' }) => void;
  events: {
    publish: (type: string, payload: unknown) => void;
    subscribe: (type: string, listener: (payload: unknown) => void) => () => void;
  };
  capabilities: readonly string[];
  /** Named authorized adapters, never an arbitrary authenticated fetch proxy. */
  api: Readonly<Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>>;
  flags: Readonly<Record<string, boolean>>;
  lifecycle: { ready: () => void; dispose: () => void };
  signal: AbortSignal;
}
export interface RodModuleProps {
  context: RodModuleContext;
}
export function assertModuleContext(value: RodModuleContext): void {
  if (
    !value ||
    value.contractMajor !== CONTRACT_MAJOR ||
    !value.workspace?.id ||
    !value.host ||
    !['standalone', 'federated'].includes(value.host.mode) ||
    typeof value.navigate !== 'function' ||
    !value.signal ||
    typeof value.signal.addEventListener !== 'function' ||
    !value.theme ||
    !value.lifecycle ||
    typeof value.lifecycle.ready !== 'function' ||
    typeof value.lifecycle.dispose !== 'function'
  )
    throw new Error('Incompatible Rod module context');
}
/** Validate before registering any executable URL. */
export function parseModuleManifest(
  input: unknown,
  manifestUrl: string,
  allowedOrigins: readonly string[],
  development = false,
): RodModuleManifest {
  if (!input || typeof input !== 'object') throw new Error('Invalid module manifest');
  const m = input as RodModuleManifest;
  if (
    typeof m.id !== 'string' ||
    typeof m.name !== 'string' ||
    typeof m.gitSha !== 'string' ||
    typeof m.entry !== 'string' ||
    typeof m.standaloneUrl !== 'string' ||
    m.schemaVersion !== 1 ||
    m.contractMajor !== CONTRACT_MAJOR ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(m.id) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(m.name) ||
    typeof m.version !== 'string' ||
    !/^[a-f0-9]{40}$/.test(m.gitSha) ||
    !Array.isArray(m.exposes) ||
    !m.exposes.includes('./App') ||
    !Array.isArray(m.capabilities) ||
    !m.capabilities.every((x) => typeof x === 'string')
  )
    throw new Error('Incompatible module manifest');
  const source = new URL(manifestUrl);
  for (const address of [source.href, m.entry, m.standaloneUrl]) {
    const url = new URL(address);
    const local = development && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      (!local && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      !allowedOrigins.includes(url.origin) ||
      url.hash ||
      url.search
    )
      throw new Error('Untrusted module URL');
  }
  const entry = new URL(m.entry);
  if (
    entry.origin !== source.origin ||
    !entry.pathname.startsWith(`/modules/${m.id}/${m.gitSha}/`) ||
    !entry.pathname.endsWith('/mf-manifest.json')
  )
    throw new Error('Module entry must be immutable and match SHA');
  return m;
}
