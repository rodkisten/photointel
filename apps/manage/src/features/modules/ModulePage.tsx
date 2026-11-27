import React, { Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { RodModuleContext, RodModuleManifest } from '@rodverse/module-sdk';
import { parseModuleManifest } from '@rodverse/module-sdk';
import { api } from '../../lib/client';
import type { Meta } from '../../types';
import { useProject } from '../../context/ProjectContext';
import { allowedOrigins, channels, development, fetchManifest, loadSandbox, type RemoteApp } from './runtime';

class ModuleBoundary extends React.Component<
  React.PropsWithChildren<{ fallback: (error: string) => React.ReactNode }>,
  { error: string }
> {
  state = { error: '' };
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
interface Selection {
  enabled: boolean;
  channel: string;
  pinned?: RodModuleManifest;
  previous?: RodModuleManifest;
}
const initial = (): Selection => ({ enabled: false, channel: 'production' });
function readSelection(key: string): Selection {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (!saved || typeof saved.enabled !== 'boolean' || !channels[saved.channel]) return initial();
    for (const item of [saved.pinned, saved.previous].filter(Boolean)) {
      parseModuleManifest(
        item,
        item.entry.replace('mf-manifest.json', 'rod-module.json'),
        allowedOrigins,
        development,
      );
      if (item.id !== 'sandbox' || item.name !== 'rod_sandbox') return initial();
    }
    return saved;
  } catch {
    return initial();
  }
}
function ModuleMount({
  App,
  workspace,
  identity,
  report,
}: {
  App: RemoteApp;
  workspace: string;
  identity: string;
  report: (message: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [context, setContext] = useState<RodModuleContext | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const events = new EventTarget();
    const nextContext: RodModuleContext = {
      contractMajor: 1,
      host: { name: 'Manage', version: '1.0.0', mode: 'federated' },
      workspace: { id: workspace },
      identity: { id: identity },
      location: { pathname: location.pathname.replace(/^\/sandbox/, '') || '/', search: location.searchStr },
      navigate: (path) => {
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..'))
          throw new Error('Invalid module path');
        void navigate({ to: `/sandbox${path === '/' ? '' : path}`, search: { workspace } });
      },
      theme: { mode: 'dark', tokens: {} },
      notify: (message) => report(message.title),
      events: {
        publish: (type, payload) => events.dispatchEvent(new CustomEvent(type, { detail: payload })),
        subscribe: (type, listener) => {
          const handler = (event: Event) => listener((event as CustomEvent).detail);
          events.addEventListener(type, handler, { signal: controller.signal });
          return () => events.removeEventListener(type, handler);
        },
      },
      capabilities: ['browser.filesystem', 'browser.build', 'browser.terminal'],
      api: {},
      flags: {},
      lifecycle: { ready: () => report('Módulo montado'), dispose: () => {} },
      signal: controller.signal,
    };
    // Do not publish a scope disposed by StrictMode effect replay.
    queueMicrotask(() => {
      if (!controller.signal.aborted) setContext(nextContext);
    });
    return () => controller.abort();
  }, [workspace, identity, location.pathname, location.searchStr, navigate, report]);
  return context && !context.signal.aborted ? <App context={context} /> : null;
}
export function ModulePage() {
  const location = useLocation();
  const { project } = useProject();
  const { data: meta } = useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/meta'), retry: false });
  const search = new URLSearchParams(location.searchStr);
  const workspace = search.get('workspace') || project?.id || 'default-workspace';
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspace)) return <p role="alert">Workspace inválido.</p>;
  if (!meta?.email) return <p role="status">Aguardando identidade do Manage…</p>;
  return (
    <WorkspaceModules
      key={`${meta.email}:${workspace}`}
      identity={meta.email}
      workspace={workspace}
      mount={location.pathname.startsWith('/sandbox')}
    />
  );
}
function WorkspaceModules({
  workspace,
  mount,
  identity,
}: {
  workspace: string;
  mount: boolean;
  identity: string;
}) {
  const key = `rodverse:modules:v1:${identity}:${workspace}`;
  const [selection, setSelection] = useState<Selection>(() => readSelection(key));
  const [App, setApp] = useState<RemoteApp | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(selection.enabled ? 'Carregando' : 'Desabilitado');
  const [diagnosticId] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState(0);
  const manifest = useQuery({
    queryKey: ['module-manifest', 'sandbox', selection.channel, selection.pinned?.gitSha, attempt],
    queryFn: ({ signal }) =>
      fetchManifest(
        selection.pinned
          ? selection.pinned.entry.replace('mf-manifest.json', 'rod-module.json')
          : channels[selection.channel],
        signal,
      ),
    enabled: selection.enabled,
    retry: 1,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(selection));
    } catch {
      /* session selection still works */
    }
  }, [key, selection]);
  useEffect(() => {
    if (!mount || !selection.enabled || !manifest.data) return;
    const controller = new AbortController();
    loadSandbox(manifest.data, controller.signal, attempt > 0)
      .then((component) => {
        if (controller.signal.aborted) return;
        setApp(() => component);
        setStatus('Carregado');
        setSelection((previous) => ({ ...previous, pinned: manifest.data }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(String(error));
          setStatus('Falha');
        }
      });
    return () => controller.abort();
  }, [mount, selection.enabled, manifest.data, attempt]);
  function change(next: Selection) {
    localStorage.setItem(key, JSON.stringify(next));
    // Federation runtime caches module identities. Version changes use a fresh session.
    window.location.reload();
  }
  const failure = (message: string) => (
    <div role="alert" className="space-y-2 rounded border border-red-400 p-3">
      <p>{message}</p>
      <p className="text-xs">Diagnóstico: {diagnosticId}</p>
      <button
        onClick={() => {
          setApp(null);
          setError('');
          setAttempt((x) => x + 1);
        }}
      >
        Tentar novamente
      </button>
      <p>Se a versão mudou, recarregue o Manage.</p>
    </div>
  );
  return (
    <section className="space-y-3" aria-label="Module Registry">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Módulos · RodSandbox</h1>
        <span className="text-xs">Experimental · {workspace}</span>
      </header>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label>
          <input
            type="checkbox"
            checked={selection.enabled}
            onChange={(event) => change({ ...selection, enabled: event.target.checked })}
          />{' '}
          Habilitar
        </label>
        <label>
          Canal{' '}
          <select
            className="rounded bg-neutral-900 p-2 text-base"
            value={selection.channel}
            onChange={(event) => change({ enabled: selection.enabled, channel: event.target.value })}
          >
            {Object.keys(channels).map((channel) => (
              <option key={channel}>{channel}</option>
            ))}
          </select>
        </label>
        <span>Preview de PR: host isolado obrigatório</span>
        <a
          className="underline"
          href={manifest.data?.standaloneUrl || 'https://sandbox.migos.club'}
          target="_blank"
          rel="noreferrer"
        >
          Abrir standalone
        </a>
        <a className="underline" href={`/sandbox?workspace=${encodeURIComponent(workspace)}`}>
          Abrir no Manage
        </a>
        {selection.pinned && (
          <button onClick={() => change({ ...selection, previous: selection.pinned, pinned: undefined })}>
            Buscar release atual
          </button>
        )}
        {selection.previous && (
          <button
            onClick={() => change({ ...selection, pinned: selection.previous, previous: selection.pinned })}
          >
            Rollback
          </button>
        )}
      </div>
      <p className="text-xs text-neutral-400">
        Preferências locais por workspace. Releases confiáveis e contrato v1; sem credenciais do host.
      </p>
      {manifest.data && (
        <div className="break-all text-xs">
          v{manifest.data.version} · SHA {manifest.data.gitSha}
          <p>Capabilities: {manifest.data.capabilities.join(', ')}</p>
        </div>
      )}
      <p role="status" className="text-sm">
        {manifest.isPending && selection.enabled ? 'Consultando manifest…' : status}
      </p>
      {manifest.error && failure(String(manifest.error))}
      {error && failure(error)}
      {mount && selection.enabled && App && !error && (
        <ModuleBoundary key={`${manifest.data?.gitSha}:${attempt}`} fallback={failure}>
          <Suspense fallback={<p>Carregando RodSandbox…</p>}>
            <div style={{ height: 'min(78dvh, 1000px)', minHeight: 320 }}>
              <ModuleMount App={App} workspace={workspace} identity={identity} report={setStatus} />
            </div>
          </Suspense>
        </ModuleBoundary>
      )}
      {!selection.enabled && <p>Ative um release revisado para este workspace.</p>}
    </section>
  );
}
