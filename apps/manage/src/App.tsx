import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Bell,
  Apple,
  CloudCog,
  ServerCog,
  Wallet,
  Code2,
  Images,
  KeyRound,
  Logs,
  Settings2,
  Shield,
  Workflow,
  GitPullRequestArrow,
  Menu,
  GripVertical,
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
  { id: 'infrastructure', to: '/infrastructure', label: 'GCP', icon: ServerCog },
  { id: 'triggers', to: '/triggers', label: 'Gatilhos', icon: GitPullRequestArrow },
  { id: 'costs', to: '/costs', label: 'Custos', icon: Wallet },
  { id: 'logs', to: '/logs', label: 'Logs', icon: Logs },
  { id: 'notifications', to: '/notifications', label: 'Notificações', icon: Bell },
  { id: 'config', to: '/environment', label: 'Ambiente', icon: Code2 },
  { id: 'secrets', to: '/secrets', label: 'Secrets', icon: KeyRound },
  { id: 'icloud', to: '/icloud', label: 'iCloud', icon: Apple },
  { id: 'settings', to: '/system', label: 'Sistema', icon: Settings2 },
] as const;

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  overview: 'Saúde, atividade e infraestrutura em um só lugar',
  deploy: 'Dispare e acompanhe pipelines com segurança',
  infrastructure: 'Cloud Build, infraestrutura e terminal SSH',
  triggers: 'Webhooks GitHub, regras por caminho e status de deploy',
  costs: 'Faturas, consumo, cota e custos por execução',
  logs: 'Eventos investigáveis em cada provedor',
  notifications: 'Templates, agrupamento e limpeza automática do Telegram',
  config: 'Edição segura das configurações de produção',
  secrets: 'Versões e credenciais do Google Secret Manager',
  icloud: 'Diagnóstico e recuperação do acesso Apple',
  settings: 'Integrações, jobs e acesso',
};

function sectionForPath(pathname: string): Tab {
  if (pathname.startsWith('/deploys')) return 'deploy';
  if (pathname.startsWith('/triggers')) return 'triggers';
  if (pathname.startsWith('/infrastructure')) return 'infrastructure';
  if (pathname.startsWith('/costs')) return 'costs';
  if (pathname.startsWith('/logs')) return 'logs';
  if (pathname.startsWith('/notifications')) return 'notifications';
  if (pathname.startsWith('/environment')) return 'config';
  if (pathname.startsWith('/secrets')) return 'secrets';
  if (pathname.startsWith('/icloud')) return 'icloud';
  if (pathname.startsWith('/system')) return 'settings';
  return 'overview';
}

export default function App() {
  const [mobileMenu, setMobileMenu] = useState(false);
  const [topVisible, setTopVisible] = useState(true);
  const [navOrder, setNavOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('photointel-manage-nav-v1') || '[]') as string[]; }
    catch { return []; }
  });
  const [dragged, setDragged] = useState<string | null>(null);
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const current = window.scrollY;
      if (Math.abs(current - last) > 8) setTopVisible(current < 70 || current < last);
      last = current;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const orderedNav = [...NAV].sort((a, b) => {
    const rank = (id: string) => { const index = navOrder.indexOf(id); return index < 0 ? NAV.findIndex(x => x.id === id) + NAV.length : index; };
    return rank(a.id) - rank(b.id);
  });
  const reorder = (from: string, to: string) => {
    const ids = orderedNav.map(item => item.id);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to), 0, from);
    setNavOrder(ids);
    localStorage.setItem('photointel-manage-nav-v1', JSON.stringify(ids));
  };
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
      <header className={cn("sticky top-0 z-20 border-b border-carbon-800 bg-carbon-950/80 backdrop-blur-xl transition-transform duration-200", !topVisible && "-translate-y-full -mb-[66px]")}>
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
            {orderedNav.map((item) => {
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

      <nav aria-label="Navegação principal mobile"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-carbon-800 bg-carbon-950/95 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl md:hidden">
        {mobileMenu && <div className="absolute bottom-full inset-x-2 mb-2 max-h-[65vh] overflow-y-auto rounded-xl border border-carbon-700 bg-carbon-950 p-3 shadow-2xl">
          <p className="mb-2 text-xs text-carbon-400">Arraste para organizar os atalhos</p>
          {orderedNav.map(item => <div key={item.id} draggable
            onDragStart={() => setDragged(item.id)}
            onDragOver={event => event.preventDefault()}
            onDrop={() => { if (dragged && dragged !== item.id) reorder(dragged, item.id); setDragged(null); }}
            className="flex items-center gap-2 rounded-lg p-1 hover:bg-carbon-900">
            <GripVertical size={16} className="text-carbon-500" />
            <Link to={item.to} onClick={() => setMobileMenu(false)}
              className="flex flex-1 items-center gap-3 p-2 text-sm"><item.icon size={17} />{item.label}</Link>
            <button type="button" aria-label={'Mover ' + item.label + ' para cima'} className="rounded px-2 py-1 text-xs"
              onClick={() => { const index = orderedNav.findIndex(x => x.id === item.id); if (index > 0) reorder(item.id, orderedNav[index - 1].id); }}>↑</button>
            <button type="button" aria-label={'Mover ' + item.label + ' para baixo'} className="rounded px-2 py-1 text-xs"
              onClick={() => { const index = orderedNav.findIndex(x => x.id === item.id); if (index < orderedNav.length - 1) reorder(item.id, orderedNav[index + 1].id); }}>↓</button>
          </div>)}
        </div>}
        <div className="flex items-center justify-around gap-1">
          {orderedNav.slice(0, 4).map(item => <Link key={item.id} to={item.to} aria-current={tab === item.id ? 'page' : undefined}
            className={cn("flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[10px]", tab === item.id ? "bg-carbon-800 text-white" : "text-carbon-400")}>
            <item.icon size={20} /><span className="truncate">{item.label}</span>
          </Link>)}
          <button type="button" aria-expanded={mobileMenu} aria-label="Mais páginas e organizar menu"
            onClick={() => setMobileMenu(value => !value)}
            className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[10px] text-carbon-300">
            <Menu size={20} /><span>Mais</span>
          </button>
        </div>
      </nav>   </div>
  );
  
}
