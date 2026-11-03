import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CloudCog, Code2, KeyRound, Logs, Settings2, Shield, Workflow } from 'lucide-react';

import { Badge, Card } from './components/ui';
import { IssueBanner, Spinner } from './components/shared';
import { RunDetail } from './components/runs';

import { Overview } from './pages/Overview';
import { Deploys } from './pages/Deploys';
import { LogViewer } from './pages/LogViewer';
import { ConfigEditor } from './pages/ConfigEditor';
import { SystemInfo } from './pages/SystemInfo';
import { SecretManagerPage } from './features/secrets/SecretManagerPage';

import { api } from './lib/client';
import { cn } from './lib/utils';
import type { Meta, Tab } from './types';
import './style.css';

// ==========================================
// Constantes & Dicionários
// ==========================================

const NAV: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Visão geral', icon: Activity },
  { id: 'deploy', label: 'Deploys', icon: Workflow },
  { id: 'logs', label: 'Logs', icon: Logs },
  { id: 'config', label: 'Ambiente', icon: Code2 },
  { id: 'secrets', label: 'Secrets', icon: KeyRound },
  { id: 'settings', label: 'Sistema', icon: Settings2 },
];

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  overview: 'Saúde, atividade e infraestrutura em um só lugar',
  deploy: 'Dispare e acompanhe pipelines com segurança',
  logs: 'Eventos investigáveis em cada provedor',
  config: 'Edição segura das configurações de produção',
  secrets: 'Versões e credenciais do Google Secret Manager',
  settings: 'Integrações, jobs e acesso',
};

// ==========================================
// Componente Principal
// ==========================================

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return NAV.some((item) => item.id === requested) ? (requested as Tab) : 'overview';
  });
  const [openedRunId, setOpenedRunId] = useState<number | null>(null);

  const {
    data: meta,
    isPending,
    error,
  } = useQuery({
    queryKey: ['meta'],
    queryFn: () => api<Meta>('/meta'),
    retry: false,
  });

  const navigate = (nextTab: Tab) => {
    setOpenedRunId(null);
    setTab(nextTab);
    // Drop deep-linked log filters when navigating elsewhere.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  // --- Helpers de Renderização e UI ---

  const currentNav = NAV.find((n) => n.id === tab);
  const isViewingRun = openedRunId !== null;

  const pageTitle = isViewingRun ? 'Detalhes da execução' : currentNav?.label;
  const pageDescription = isViewingRun ? 'Etapas e logs técnicos' : TAB_DESCRIPTIONS[tab];

  const renderContent = () => {
    if (isPending) {
      return (
        <Card className="flex items-center justify-center p-12 bg-slate-950">
          <Spinner />
        </Card>
      );
    }
    if (error) {
      return <IssueBanner error={error} />;
    }
    if (openedRunId !== null) {
      return <RunDetail id={openedRunId} onBack={() => setOpenedRunId(null)} />;
    }

    switch (tab) {
      case 'overview':
        return <Overview openRun={setOpenedRunId} />;
      case 'deploy':
        return <Deploys openRun={setOpenedRunId} />;
      case 'logs':
        return <LogViewer />;
      case 'config':
        return <ConfigEditor />;
      case 'secrets':
        return <SecretManagerPage />;
      case 'settings':
        return <SystemInfo meta={meta!} />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 selection:bg-slate-800">
      {/* Top Header */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[66px] max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-slate-200 text-slate-900 shadow-sm">
              <CloudCog size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight text-slate-100">PhotoIntel</p>
              <p className="text-[11px] font-medium tracking-wider text-slate-500">CONTROL CENTER</p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="hidden max-w-44 truncate sm:inline">{meta?.email}</span>
            <Shield size={17} className={meta ? 'text-emerald-400' : 'text-slate-600'} />
            <Badge tone="neutral">Production</Badge>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
        {/* Desktop Sidebar */}
        <aside className="hidden w-48 shrink-0 md:block">
          <nav className="sticky top-24 space-y-1">
            {NAV.map((n) => {
              const isActive = tab === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => navigate(n.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-slate-800/80 text-slate-100 shadow-sm'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
                  )}
                >
                  <n.icon size={17} className={isActive ? 'text-slate-200' : 'text-slate-500'} />
                  {n.label}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content Area */}
        <main className="min-w-0 flex-1 space-y-6">
          {/* Page Header */}
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-[11px] font-medium tracking-wider text-slate-500 uppercase">
                PRODUCTION / {meta?.project || 'photointel'}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
                {pageTitle}
              </h1>
              <p className="text-sm text-slate-400">{pageDescription}</p>
            </div>
            {currentNav && !isViewingRun && <currentNav.icon size={20} className="mt-3 text-slate-600" />}
          </div>

          {/* Dynamic Content */}
          {renderContent()}

          {/* Desktop Footer */}
          <footer className="border-t border-slate-800/60 pt-5 text-xs text-slate-500">
            PhotoIntel Manage · Operações auditáveis · Cloudflare Access
          </footer>
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav
        aria-label="Navegação principal"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-800 bg-slate-950/90 px-1 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl md:hidden"
      >
        {NAV.map((n) => {
          const isActive = tab === n.id;
          return (
            <button
              key={n.id}
              onClick={() => navigate(n.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 text-[10px] transition-colors',
                isActive ? 'text-slate-200' : 'text-slate-500 hover:text-slate-400',
              )}
            >
              <n.icon size={21} className={isActive ? 'text-slate-300' : 'opacity-80'} />
              <span className="truncate font-medium">{n.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
