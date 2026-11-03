import { useQuery } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  Link,
  useNavigate,
} from '@tanstack/react-router';

import App from './App';
import { Card } from './components/ui';
import { IssueBanner, Spinner } from './components/shared';
import { RunDetail } from './components/runs';
import { SecretManagerPage } from './features/secrets/SecretManagerPage';
import { api } from './lib/client';
import { readLogLink, type LogLink } from './log-deeplink';
import { ConfigEditor } from './pages/ConfigEditor';
import { Deploys } from './pages/Deploys';
import { ICloudDiagnostics } from './pages/ICloudDiagnostics';
import { LogViewer } from './pages/LogViewer';
import { Overview } from './pages/Overview';
import { SystemInfo } from './pages/SystemInfo';
import type { Meta } from './types';

function NotFound() {
  return (
    <Card className="space-y-3 p-6">
      <h2 className="text-lg font-semibold text-carbon-100">Página não encontrada</h2>
      <p className="text-sm text-carbon-400">Esta rota não existe no Manage.</p>
      <Link to="/" className="text-sm text-carbon-200 underline underline-offset-4">
        Voltar à visão geral
      </Link>
    </Card>
  );
}

const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: NotFound,
});

function RunPage() {
  const { runId } = runRoute.useParams();
  const navigate = useNavigate();
  const id = Number(runId);
  if (!Number.isSafeInteger(id) || id <= 0) return <NotFound />;
  return <RunDetail id={id} onBack={() => void navigate({ to: '/deploys' })} />;
}

function SystemPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ['meta'],
    queryFn: () => api<Meta>('/meta'),
    retry: false,
  });
  if (isPending) {
    return (
      <Card className="flex items-center justify-center p-12">
        <Spinner />
      </Card>
    );
  }
  if (error) return <IssueBanner error={error} />;
  return <SystemInfo meta={data} />;
}

function validatedLogSearch(search: Record<string, unknown>): LogLink {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.set(key, value);
  }
  return readLogLink(params.toString());
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ location }) => {
    // Old PhotoIntel / Telegram links use ?tab=...; keep them working.
    const tab = new URLSearchParams(location.searchStr).get('tab');
    switch (tab) {
      case 'logs':
        throw redirect({
          to: '/logs',
          search: readLogLink(location.searchStr),
          replace: true,
        });
      case 'deploy':
        throw redirect({ to: '/deploys', replace: true });
      case 'config':
        throw redirect({ to: '/environment', replace: true });
      case 'secrets':
        throw redirect({ to: '/secrets', replace: true });
      case 'icloud':
        throw redirect({ to: '/icloud', replace: true });
      case 'settings':
        throw redirect({ to: '/system', replace: true });
      default:
        break;
    }
  },
  component: Overview,
});

const deploysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deploys',
  component: Deploys,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deploys/$runId',
  component: RunPage,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  validateSearch: validatedLogSearch,
  component: LogViewer,
});

const environmentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/environment',
  component: ConfigEditor,
});

const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/secrets',
  component: SecretManagerPage,
});

const icloudRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/icloud',
  component: ICloudDiagnostics,
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/system',
  component: SystemPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  deploysRoute,
  runRoute,
  logsRoute,
  environmentRoute,
  secretsRoute,
  icloudRoute,
  systemRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultNotFoundComponent: NotFound,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
