import { useState } from 'react';
import { Activity, CloudCog, Code2, KeyRound, Logs, Settings2, Shield, Workflow } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
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

const NAV: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Visão geral', icon: Activity },
  { id: 'deploy', label: 'Deploys', icon: Workflow },
  { id: 'logs', label: 'Logs', icon: Logs },
  { id: 'config', label: 'Ambiente', icon: Code2 },
  { id: 'secrets', label: 'Secrets', icon: KeyRound },
  { id: 'settings', label: 'Sistema', icon: Settings2 },
];
export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [opened, setOpened] = useState<number | null>(null);
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/meta'), retry: false });
  function navigate(next: Tab) {
    setOpened(null);
    setTab(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[#25272b] bg-[#0d0e10]/95 backdrop-blur-xl">
        <div className="mx-auto flex h-[66px] max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white text-black">
              <CloudCog size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight">PhotoIntel</p>
              <p className="text-[11px] tracking-wide text-slate-500">CONTROL CENTER</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="hidden max-w-44 truncate sm:inline">{meta.data?.email}</span>
            <Shield size={17} className={meta.data ? 'text-emerald-400' : 'text-slate-500'} />
            <Badge tone="neutral">Production</Badge>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
        <aside className="hidden w-48 shrink-0 md:block">
          <nav className="sticky top-24 space-y-1">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                  tab === n.id
                    ? 'bg-[#292b2f] text-white'
                    : 'text-slate-500 hover:bg-[#191b1e] hover:text-slate-200',
                )}
              >
                <n.icon size={17} />
                {n.label}
              </button>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 space-y-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-600">PRODUCTION / {meta.data?.project || 'photointel'}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
                {opened !== null ? 'Detalhes da execução' : NAV.find((n) => n.id === tab)?.label}
              </h1>
              <p className="mt-1.5 text-sm text-slate-500">
                {opened !== null
                  ? 'Etapas e logs técnicos'
                  : tab === 'overview'
                    ? 'Saúde, atividade e infraestrutura em um só lugar'
                    : tab === 'deploy'
                      ? 'Dispare e acompanhe pipelines com segurança'
                      : tab === 'logs'
                        ? 'Eventos investigáveis em cada provedor'
                        : tab === 'config'
                          ? 'Edição segura das configurações de produção'
                          : tab === 'secrets'
                            ? 'Versões e credenciais do Google Secret Manager'
                          : 'Integrações, jobs e acesso'}
              </p>
            </div>
            <Activity size={20} className="mt-3 text-slate-600" />
          </div>
          {meta.isPending ? (
            <Card className="p-8">
              <Spinner />
            </Card>
          ) : meta.error ? (
            <IssueBanner error={meta.error} />
          ) : opened !== null ? (
            <RunDetail id={opened} onBack={() => setOpened(null)} />
          ) : tab === 'overview' ? (
            <Overview openRun={(id) => setOpened(id)} />
          ) : tab === 'deploy' ? (
            <Deploys openRun={(id) => setOpened(id)} />
          ) : tab === 'logs' ? (
            <LogViewer />
          ) : tab === 'config' ? (
            <ConfigEditor />
          ) : tab === 'secrets' ? (
            <SecretManagerPage />
          ) : (
            <SystemInfo meta={meta.data!} />
          )}
          <footer className="border-t border-[#282a2e] pt-5 text-xs text-slate-600">
            PhotoIntel Manage · Operações auditáveis · Cloudflare Access
          </footer>
        </main>
      </div>
      <nav
        aria-label="Navegação principal"
        className="fixed bottom-0 inset-x-0 z-30 flex border-t border-[#313338] bg-[#121315]/95 px-1 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl md:hidden"
      >
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => navigate(n.id)}
            aria-current={tab === n.id ? 'page' : undefined}
            className={cn(
              'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 text-[10px]',
              tab === n.id ? 'text-white' : 'text-slate-500',
            )}
          >
            <n.icon size={21} />
            <span className="truncate">{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
