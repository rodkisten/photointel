import React, { Suspense, useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { RodModuleContext, RodModuleManifest } from '@rodverse/module-sdk';
import { parseModuleManifest } from '@rodverse/module-sdk';
import { isIsolatedModulePreview } from './preview-policy';
import { api } from '../../lib/client';
import type { Meta } from '../../types';
import { useProject } from '../../context/ProjectContext';
import {
  productionPolicies,
  moduleDefinitions,
  type ModuleId,
  readPreviewPolicy,
  type ModulePolicy,
  fetchManifest,
  loadModule,
  type RemoteApp,
} from './runtime';

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
const initial = (policy: ModulePolicy): Selection => ({
  enabled: false,
  channel: Object.keys(policy.channels)[0],
});
function readSelection(key: string, policy: ModulePolicy): Selection {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (!saved || typeof saved.enabled !== 'boolean' || !policy.channels[saved.channel])
      return initial(policy);
    for (const item of [saved.pinned, saved.previous].filter(Boolean)) {
      parseModuleManifest(
        item,
        item.entry.replace('mf-manifest.json', 'rod-module.json'),
        policy.allowedOrigins,
        policy.development,
      );
      if (item.id !== policy.module.id || item.name !== policy.module.name) return initial(policy);
    }
    return saved;
  } catch {
    return initial(policy);
  }
}
function ModuleMount({
  App,
  workspace,
  identity,
  report,
  policy,
  repository,
}: {
  App: RemoteApp;
  workspace: string;
  identity: string;
  report: (message: string) => void;
  policy: ModulePolicy;
  repository?: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const latest = useRef({ navigate, report });
  useEffect(() => {
    latest.current = { navigate, report };
  }, [navigate, report]);
  const [scope, setScope] = useState<Omit<RodModuleContext, 'location'> | null>(null);
  useEffect(() => {
    const controller = new AbortController(),
      events = new EventTarget();
    const next: Omit<RodModuleContext, 'location'> = {
      contractMajor: 1,
      host: { name: 'Manage', version: '1.0.0', mode: 'federated' },
      workspace: { id: workspace, repository },
      identity: { id: identity },
      navigate: (path) => {
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..'))
          throw new Error('Invalid module path');
        const target = new URL(path, 'https://module.invalid');
        void latest.current.navigate({
          to: policy.module.route + (target.pathname === '/' ? '' : target.pathname),
          search: {
            ...(new URLSearchParams(window.location.search).get('project')
              ? { project: new URLSearchParams(window.location.search).get('project')! }
              : {}),
            ...Object.fromEntries(target.searchParams),
            workspace,
          },
        });
      },
      theme: { mode: 'dark', tokens: {} },
      notify: (message) => latest.current.report(message.title),
      events: {
        publish: (type, payload) => events.dispatchEvent(new CustomEvent(type, { detail: payload })),
        subscribe: (type, listener) => {
          const handler = (event: Event) => listener((event as CustomEvent).detail);
          events.addEventListener(type, handler, { signal: controller.signal });
          return () => events.removeEventListener(type, handler);
        },
      },
      capabilities:
        policy.module.id === 'code'
          ? ['workflow.edit', 'workflow.parse', 'registry.read']
          : ['browser.filesystem', 'browser.build', 'browser.terminal'],
      api: {},
      flags: {},
      lifecycle: { ready: () => latest.current.report('Módulo montado'), dispose: () => {} },
      signal: controller.signal,
    };
    queueMicrotask(() => {
      if (!controller.signal.aborted) setScope(next);
    });
    return () => controller.abort();
  }, [workspace, identity, repository, policy.module.id, policy.module.route]);
  const context = scope
    ? {
        ...scope,
        location: {
          pathname: location.pathname.slice(policy.module.route.length) || '/',
          search: location.searchStr,
        },
      }
    : null;
  return context && !context.signal.aborted ? <App context={context} /> : null;
}
export function ModulePage() {
  const location = useLocation();
  const { project } = useProject();
  const params = new URLSearchParams(location.searchStr);
  const id: ModuleId =
    location.pathname.startsWith('/code') || params.get('module') === 'code' ? 'code' : 'sandbox';
  const isolated = isIsolatedModulePreview(window.location.hostname);
  const previewPolicy = useQuery({
    queryKey: ['module-preview-policy', id],
    queryFn: ({ signal }) => readPreviewPolicy(signal, id),
    enabled: isolated,
    retry: false,
  });
  const policy = isolated ? previewPolicy.data : productionPolicies[id];
  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => api<Meta>('/meta'),
    enabled: !isolated,
    retry: false,
  });
  const search = new URLSearchParams(location.searchStr);
  const workspace = search.get('workspace') || project?.id || 'default-workspace';
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspace)) return <p role="alert">Workspace inválido.</p>;
  if (previewPolicy.error) return <p role="alert">{String(previewPolicy.error)}</p>;
  if (!policy) return <p role="status">Verificando host isolado…</p>;
  if (!isolated && !meta?.email) return <p role="status">Aguardando identidade do Manage…</p>;
  return (
    <WorkspaceModules
      key={`${id}:${isolated ? 'isolated-preview' : meta!.email}:${workspace}`}
      identity={isolated ? 'isolated-preview' : meta!.email}
      policy={policy}
      workspace={workspace}
      mount={location.pathname.startsWith(policy.module.route)}
      repository={project?.repository}
    />
  );
}
function WorkspaceModules({
  workspace,
  mount,
  identity,
  policy,
  repository,
}: {
  workspace: string;
  mount: boolean;
  identity: string;
  policy: ModulePolicy;
  repository?: string;
}) {
  const key = `rodverse:modules:v1:${identity}:${workspace}${policy.module.id === 'sandbox' ? '' : ':' + policy.module.id}`;
  const [selection, setSelection] = useState<Selection>(() => readSelection(key, policy));
  const [App, setApp] = useState<RemoteApp | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(selection.enabled ? 'Carregando' : 'Desabilitado');
  const [diagnosticId] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState(0);
  const manifest = useQuery({
    queryKey: ['module-manifest', policy.module.id, selection.channel, selection.pinned?.gitSha, attempt],
    queryFn: ({ signal }) =>
      fetchManifest(
        selection.pinned
          ? selection.pinned.entry.replace('mf-manifest.json', 'rod-module.json')
          : policy.channels[selection.channel],
        signal,
        policy,
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
    loadModule(manifest.data, controller.signal, attempt > 0, policy)
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
  }, [mount, selection.enabled, manifest.data, attempt, policy]);
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
      <nav aria-label="Módulos" className="flex gap-4">
        {Object.values(moduleDefinitions).map((module) => (
          <a
            key={module.id}
            className="underline"
            href={`/modules?module=${module.id}&workspace=${encodeURIComponent(workspace)}`}
          >
            {module.label}
          </a>
        ))}
      </nav>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Módulos · {policy.module.label}</h1>
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
            {Object.keys(policy.channels).map((channel) => (
              <option key={channel}>{channel}</option>
            ))}
          </select>
        </label>
        <span>
          {policy.isolated
            ? 'Preview isolado · sem APIs privilegiadas'
            : 'Preview de PR: host isolado obrigatório'}
        </span>
        <a
          className="underline"
          href={manifest.data?.standaloneUrl || policy.module.origin + policy.module.standalone}
          target="_blank"
          rel="noreferrer"
        >
          Abrir standalone
        </a>
        <a className="underline" href={`${policy.module.route}?workspace=${encodeURIComponent(workspace)}`}>
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
          <Suspense fallback={<p>Carregando {policy.module.label}…</p>}>
            <div style={{ height: 'min(78dvh, 1000px)', minHeight: 320 }}>
              <ModuleMount
                App={App}
                workspace={workspace}
                identity={identity}
                report={setStatus}
                policy={policy}
                repository={repository}
              />
            </div>
          </Suspense>
        </ModuleBoundary>
      )}
      {!selection.enabled && <p>Ative um release revisado para este workspace.</p>}
    </section>
  );
}
