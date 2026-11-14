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

const NAV_GROUPS = [
  { label: 'Operação', ids: ['overview', 'deploy', 'infrastructure', 'triggers'] },
  { label: 'Observabilidade', ids: ['costs', 'logs', 'notifications'] },
  { label: 'Configuração', ids: ['config', 'secrets', 'icloud', 'settings'] },
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
  const [editNav, setEditNav] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('photointel-manage-pinned-v1') || 'null');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 4) : ['overview', 'deploy', 'costs', 'settings'];
    } catch { return ['overview', 'deploy', 'costs', 'settings']; }
  });
  useEffect(() => {
    let last = window.scrollY;
    let directionDistance = 0;
    const onScroll = () => {
      const current = Math.max(0, window.scrollY);
      const delta = current - last;
      if (Math.sign(delta) !== Math.sign(directionDistance)) directionDistance = 0;
      directionDistance += delta;
      if (current < 80) setTopVisible(true);
      else if (directionDistance > 48) { setTopVisible(false); directionDistance = 0; }
      else if (directionDistance < -32) { setTopVisible(true); directionDistance = 0; }
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
    const ids: string[] = orderedNav.map(item => item.id);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to), 0, from);
    setNavOrder(ids);
    localStorage.setItem('photointel-manage-nav-v1', JSON.stringify(ids));
  };
  const pinned = pinnedIds.map(id => orderedNav.find(item => item.id === id)).filter((item): item is (typeof NAV)[number] => Boolean(item));
  const togglePin = (id: string) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter(value => value !== id) :
      pinnedIds.length < 4 ? [...pinnedIds, id] : [...pinnedIds.slice(1), id];
    setPinnedIds(next);
    localStorage.setItem('photointel-manage-pinned-v1', JSON.stringify(next));
  };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = sectionForPath(pathname);
  useEffect(() => { setMobileMenu(false); }, [pathname]);
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
      <header className={cn("sticky top-0 z-20 border-b border-carbon-800 bg-carbon-950/80 backdrop-blur-xl transition-transform duration-200", !topVisible && "-translate-y-full")}>
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
          <nav aria-label="Navegação principal" className="sticky top-24 space-y-5">
            {NAV_GROUPS.map(group => <div key={group.label} className="space-y-1">
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-carbon-500">{group.label}</p>
              {orderedNav.filter(item => (group.ids as readonly string[]).includes(item.id)).map(item => <Link
                key={item.id} to={item.to} preload="intent" aria-current={tab === item.id ? 'page' : undefined}
                className={cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  tab === item.id ? 'bg-carbon-800 text-carbon-100' : 'text-carbon-400 hover:bg-carbon-900 hover:text-carbon-200')}>
                <item.icon size={17} />{item.label}
              </Link>)}
            </div>)}
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

      {mobileMenu && <button type="button" aria-label="Fechar menu" onClick={() => setMobileMenu(false)}
        className="fixed inset-0 z-[50] bg-black/60 md:hidden" />}
      {mobileMenu && <div role="dialog" aria-label="Menu de navegação"
        className="fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[61] max-h-[65dvh] overflow-y-auto overscroll-contain rounded-xl border border-carbon-700 bg-carbon-950 p-3 shadow-2xl md:hidden">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-carbon-100">Navegação</p>
          <button type="button" onClick={() => setEditNav(value => !value)}
            className="rounded-lg border border-carbon-700 px-3 py-1.5 text-xs text-carbon-300">
            {editNav ? 'Concluir' : 'Organizar'}
          </button>
        </div>
        {NAV_GROUPS.map(group => <section key={group.label} className="mb-3">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-carbon-500">{group.label}</p>
          {orderedNav.filter(item => (group.ids as readonly string[]).includes(item.id)).map(item =>
            <div key={item.id} draggable={editNav} onDragStart={() => setDragged(item.id)}
              onDragOver={event => { if (editNav) event.preventDefault(); }}
              onDrop={() => { if (editNav && dragged && dragged !== item.id) reorder(dragged, item.id); setDragged(null); }}
              className="flex min-h-11 items-center gap-2 rounded-lg hover:bg-carbon-900">
              {editNav && <GripVertical size={16} className="ml-1 text-carbon-500" />}
              <Link to={item.to} onClick={() => setMobileMenu(false)}
                className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-sm text-carbon-200">
                <item.icon size={17} />{item.label}
              </Link>
              {editNav && <button type="button" aria-label={pinnedIds.includes(item.id) ? 'Desafixar ' + item.label : 'Fixar ' + item.label}
                onClick={() => togglePin(item.id)} className="rounded-lg px-3 py-2 text-xs text-carbon-300">
                {pinnedIds.includes(item.id) ? '★' : '☆'}
              </button>}
              {editNav && <button type="button" aria-label={'Mover ' + item.label + ' para cima'}
                onClick={() => { const index = orderedNav.findIndex(x => x.id === item.id); if (index > 0) reorder(item.id, orderedNav[index - 1].id); }}
                className="rounded-lg px-2 py-2 text-sm">↑</button>}
              {editNav && <button type="button" aria-label={'Mover ' + item.label + ' para baixo'}
                onClick={() => { const index = orderedNav.findIndex(x => x.id === item.id); if (index < orderedNav.length - 1) reorder(item.id, orderedNav[index + 1].id); }}
                className="rounded-lg px-2 py-2 text-sm">↓</button>}
            </div>)}
        </section>)}
        {editNav && <p className="text-xs text-carbon-500">Marque até quatro favoritos para a barra inferior. Use as setas para organizar no iPhone.</p>}
      </div>}
      <nav aria-label="Navegação principal mobile"
        className="fixed inset-x-0 bottom-0 z-[60] border-t border-carbon-800 bg-carbon-950/95 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl md:hidden">
        <div className="flex items-center justify-around gap-1">
          {pinned.map(item => <Link key={item.id} to={item.to} aria-current={tab === item.id ? 'page' : undefined}
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
