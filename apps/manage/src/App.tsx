import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Apple,
  CloudCog,
  Code2,
  Images,
  KeyRound,
  Logs,
  Settings2,
  Shield,
  Workflow,
} from 'lucide-react';

import { Badge, Card } from './components/ui';
import { IssueBanner, Spinner } from './components/shared';
import { api } from './lib/client';
import { cn } from './lib/utils';
import type { Meta, Tab } from './types';
import './style.css';

const NAV = [
  { id: 'overview', to: '/', label: 'Visão geral', icon: Activity },
  { id: 'deploy', to: '/deploys', label: 'Deploys', icon: Workflow },
  { id: 'logs', to: '/logs', label: 'Logs', icon: Logs },
  { id: 'config', to: '/environment', label: 'Ambiente', icon: Code2 },
  { id: 'secrets', to: '/secrets', label: 'Secrets', icon: KeyRound },
  { id: 'icloud', to: '/icloud', label: 'iCloud', icon: Apple },
  { id: 'settings', to: '/system', label: 'Sistema', icon: Settings2 },
] as const;

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  overview: 'Saúde, atividade e infraestrutura em um só lugar',
  deploy: 'Dispare e acompanhe pipelines com segurança',
  logs: 'Eventos investigáveis em cada provedor',
  config: 'Edição segura das configurações de produção',
  secrets: 'Versões e credenciais do Google Secret Manager',
  icloud: 'Diagnóstico e recuperação do acesso Apple',
  settings: 'Integrações, jobs e acesso',
};

function sectionForPath(pathname: string): Tab {
  if (pathname.startsWith('/deploys')) return 'deploy';
  if (pathname.startsWith('/logs')) return 'logs';
  if (pathname.startsWith('/environment')) return 'config';
  if (pathname.startsWith('/secrets')) return 'secrets';
  if (pathname.startsWith('/icloud')) return 'icloud';
  if (pathname.startsWith('/system')) return 'settings';
  return 'overview';
}

export default function App() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = sectionForPath(pathname);
  const isViewingRun = /^\/deploys\/[^/]+\/?$/.test(pathname);
  const currentNav = NAV.find((item) => item.id === tab);
  const pageTitle = isViewingRun ? 'Detalhes da execução' : currentNav?.label;
  const pageDescription = isViewingRun ? 'Etapas e logs técnicos' : TAB_DESCRIPTIONS[tab];
  const {
    data: meta,
    isPending,
    error,
  } = useQuery({
    queryKey: ['meta'],
    queryFn: () => api<Meta>('/meta'),
    retry: false,
  });

  return (
    <div className="min-h-screen bg-carbon-950 text-carbon-200 selection:bg-carbon-800">
      <header className="sticky top-0 z-20 border-b border-carbon-800 bg-carbon-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[66px] max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="Ir para a home do Manage" className="flex items-center gap-3 text-left">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-carbon-200 text-carbon-900 shadow-sm">
              <CloudCog size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight text-carbon-100">PhotoIntel</p>
              <p className="text-[11px] font-medium tracking-wider text-carbon-500">CONTROL CENTER</p>
            </div>
          </Link>

          <div className="flex items-center gap-3 text-xs text-carbon-400">
            <a
              href="https://photos.migos.club/"
              className="inline-flex items-center gap-1 rounded-lg border border-carbon-800 px-2.5 py-2 text-xs text-carbon-300 hover:bg-carbon-900"
              aria-label="Abrir PhotoIntel"
            >
              <Images size={16} />
              <span className="hidden sm:inline">Fotos</span>
            </a>
            <span className="hidden max-w-44 truncate sm:inline">{meta?.email}</span>
            <Shield size={17} className={meta ? 'text-emerald-400' : 'text-carbon-600'} />
            <Badge tone="neutral">Production</Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
        <aside className="hidden w-48 shrink-0 md:block">
          <nav aria-label="Navegação principal" className="sticky top-24 space-y-1">
            {NAV.map((item) => {
              const isActive = tab === item.id;
              return (
                <Link
                  key={item.id}
                  to={item.to}
                  preload="intent"
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-carbon-800/80 text-carbon-100 shadow-sm'
                      : 'text-carbon-400 hover:bg-carbon-900 hover:text-carbon-200',
                  )}
                >
                  <item.icon size={17} className={isActive ? 'text-carbon-200' : 'text-carbon-500'} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 space-y-6">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-[11px] font-medium tracking-wider text-carbon-500 uppercase">
                PRODUCTION / {meta?.project || 'photointel'}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-carbon-100 sm:text-3xl">
                {pageTitle}
              </h1>
              <p className="text-sm text-carbon-400">{pageDescription}</p>
            </div>
            {currentNav && !isViewingRun && <currentNav.icon size={20} className="mt-3 text-carbon-600" />}
          </div>

          {isPending ? (
            <Card className="flex items-center justify-center bg-carbon-950 p-12">
              <Spinner />
            </Card>
          ) : error ? (
            <IssueBanner error={error} />
          ) : (
            <Outlet />
          )}

          <footer className="border-t border-carbon-800/60 pt-5 text-xs text-carbon-500">
            PhotoIntel Manage · Operações auditáveis · Cloudflare Access
          </footer>
        </main>
      </div>

      <nav
        aria-label="Navegação principal mobile"
        className="fixed inset-x-0 bottom-0 z-30 flex overflow-x-auto border-t border-carbon-800 bg-carbon-950/90 px-1 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl md:hidden"
      >
        {NAV.map((item) => {
          const isActive = tab === item.id;
          return (
            <Link
              key={item.id}
              to={item.to}
              preload="intent"
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex min-w-[56px] flex-1 flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 text-[10px] transition-colors',
                isActive ? 'text-carbon-200' : 'text-carbon-500 hover:text-carbon-400',
              )}
            >
              <item.icon size={21} className={isActive ? 'text-carbon-300' : 'opacity-80'} />
              <span className="truncate font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
