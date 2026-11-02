import {
  Activity,
  Album,
  Aperture,
  ChevronRight,
  Cloud,
  Copy,
  Fingerprint,
  Home,
  Images,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useApi } from './api/client';
import { checkForUpdate, refreshApplication } from './lib/app-update';
import { FRONTEND_RELEASE_ID } from './lib/release';
import type { Info } from './api/types';
import { Dialog } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Toast } from './components/common';
import { JobsDrawer } from './components/jobs-drawer';
import { Overview } from './pages/overview';
import { Library } from './pages/library';
import { SearchPage } from './pages/search';
import { TagsPage } from './pages/tags';
import { AlbumsPage } from './pages/albums';
import { DuplicatesPage } from './pages/duplicates';
import { JobsPage } from './pages/jobs';
import { ICloudPage } from './pages/icloud';
import { BridgePage } from './pages/bridge';
import { SettingsPage } from './pages/settings';
import { SetupPage } from './pages/setup';

const navigation = [
  { to: '/', label: 'Visão geral', icon: Home },
  { to: '/library', label: 'Biblioteca', icon: Images },
  { to: '/search', label: 'Busca inteligente', icon: Search },
  { to: '/albums', label: 'Álbuns', icon: Album },
  { to: '/tags', label: 'Palavras-chave', icon: Tags },
  { to: '/duplicates', label: 'Duplicadas', icon: Copy },
  { to: '/jobs', label: 'Processamento', icon: Activity },
  { to: '/icloud', label: 'Sincronização iCloud', icon: Cloud },
  { to: '/bridge', label: 'Apple Bridge', icon: Fingerprint },
  { to: '/settings', label: 'Configurações', icon: Settings },
  { to: '/setup', label: 'Preparação e validação', icon: ShieldCheck },
];
function Shell() {
  const [menu, setMenu] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const location = useLocation();
  const { data, isError } = useApi<Info>('/v1/system/status', 30_000);
  const current = navigation.find((item) => item.to === location.pathname);
  useEffect(() => {
    document.getElementById('boot-splash')?.remove();
    let stopped = false;
    const check = () => {
      if (document.visibilityState === 'visible') {
        void checkForUpdate()
          .then((ready) => {
            if (!stopped) setUpdateAvailable(ready);
          })
          .catch(() => undefined);
      }
    };
    check();
    document.addEventListener('visibilitychange', check);
    const interval = window.setInterval(check, 300_000);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(interval);
    };
  }, []);
  async function updateApp() {
    setUpdating(true);
    try {
      await refreshApplication();
    } catch {
      setUpdating(false);
      window.location.reload();
    }
  }
  useEffect(() => {
    setMenu(false);
    document.title = `${current?.label ?? 'PhotoIntel'} · Photo Intelligence`;
  }, [location.pathname, current?.label]);
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Ir para conteúdo
      </a>
      <aside className="sidebar">
        <NavLink className="brand" to="/">
          <span className="brand-icon">
            <Aperture size={23} />
          </span>
          <span>
            Photo Intelligence<small>PRIVATE CLOUD · v1.1</small>
          </span>
        </NavLink>
        <nav aria-label="Navegação principal">
          {navigation.map(({ to, label, icon: Icon }, index) => (
            <NavLink key={to} to={to} end={to === '/'} className={index === 6 ? 'nav-divider' : ''}>
              <Icon size={17} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={16} />
          <div>
            Seu acervo, sob seu controle
            <small>Mídia privada · originais preservados</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Aperture size={17} />
            <span>Workspace pessoal</span>
            <ChevronRight size={13} />
            <strong>{current?.label ?? 'Biblioteca'}</strong>
          </div>
          <button
            type="button"
            className={`app-update-button ${updateAvailable ? 'is-available' : ''}`}
            onClick={() => void updateApp()}
            disabled={updating}
            aria-label={
              updateAvailable
                ? 'Nova versão disponível. Atualizar aplicativo'
                : 'Verificar e atualizar aplicativo'
            }
            title={FRONTEND_RELEASE_ID ? `Versão ${FRONTEND_RELEASE_ID.slice(0, 7)}` : 'Atualizar aplicativo'}
          >
            <RefreshCw size={15} className={updating ? 'spinning' : ''} />
            <span>{updating ? 'Atualizando' : updateAvailable ? 'Nova versão' : 'Atualizar'}</span>
          </button>
          <div className="connection">
            <span className={data ? 'connection-dot online' : 'connection-dot'} />
            {data
              ? data.environment === 'production'
                ? 'Privado e conectado'
                : 'Ambiente local'
              : isError
                ? 'Sem conexão com a API'
                : 'Conectando à API'}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <JobsDrawer hidden={menu} />
      <nav className="bottom-nav" aria-label="Navegação móvel">
        {[navigation[1], navigation[2], navigation[3], navigation[6]].map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to}>
            <Icon size={21} />
            <span>
              {label === 'Busca inteligente' ? 'Buscar' : label === 'Processamento' ? 'Jobs' : label}
            </span>
          </NavLink>
        ))}
        <button onClick={() => setMenu(true)} aria-label="Mais páginas">
          <Menu size={21} />
          <span>Mais</span>
        </button>
      </nav>
      <Dialog open={menu} onOpenChange={setMenu} title="Seu workspace" className="mobile-menu">
        <nav aria-label="Todas as páginas">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'}>
              <Icon size={18} />
              {label}
              <ChevronRight size={14} />
            </NavLink>
          ))}
        </nav>
      </Dialog>
      <Toast />
    </div>
  );
}
export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="library" element={<Library />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="tags" element={<TagsPage />} />
        <Route path="albums" element={<AlbumsPage />} />
        <Route path="duplicates" element={<DuplicatesPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="icloud" element={<ICloudPage />} />
        <Route path="bridge" element={<BridgePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route
          path="*"
          element={
            <div className="empty-state">
              <h1>Página não encontrada</h1>
              <Button asChild>
                <NavLink to="/library">Voltar à biblioteca</NavLink>
              </Button>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
