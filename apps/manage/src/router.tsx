import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
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
import { readLogLink, toLogSearch } from './log-deeplink';
import { NotificationsPage } from './pages/Notifications';
import { ConfigEditor } from './pages/ConfigEditor';
import { Deploys } from './pages/Deploys';
import { Infrastructure } from './pages/Infrastructure';
import { DeployTriggers } from './pages/DeployTriggers';
import { WorkflowStudio } from './pages/WorkflowStudio';
import { ProjectsPage } from './pages/Projects';
import { CostsPage } from './pages/Costs';
import { ICloudDiagnostics } from './pages/ICloudDiagnostics';
import { LogViewer } from './pages/LogViewer';
import { CloudRunJobsPage } from './pages/CloudRunJobs';
import { OperationsPage } from './pages/Operations';
import { Overview } from './pages/Overview';
import { SystemInfo } from './pages/SystemInfo';
import { TerminalPage } from './features/terminal/TerminalPage';
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
  const project = new URLSearchParams(window.location.search).get('project') || undefined;
  const id = Number(runId);
  if (!Number.isSafeInteger(id) || id <= 0) return <NotFound />;
  return <RunDetail id={id} onBack={() => void navigate({ to: '/deploys', search: project ? { project } : {} })} />;
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

// Zod v4 keeps URL inputs optional while exposing a fully normalized LogLink to the page.
const logSearchSchema = z
  .object({
    source: z.string().optional(),
    correlation: z.string().optional(),
    job: z.string().optional(),
    job_type: z.string().optional(),
    ray: z.string().optional(),
    event: z.string().optional(),
    entry: z.string().optional(),
    at: z.string().optional(),
    search: z.string().optional(),
    minutes: z.string().optional(),
    project: z.string().optional(),
  })
  .transform((raw) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') params.set(key, value);
    }
    return { ...readLogLink(params.toString()), ...(raw.project ? { project: raw.project } : {}) };
  });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ location }) => {
    // Old PhotoIntel / Telegram links use ?tab=...; keep them working.
    const legacyParams = new URLSearchParams(location.searchStr);
    const tab = legacyParams.get('tab');
    const project = legacyParams.get('project') || undefined;
    switch (tab) {
      case 'logs':
        throw redirect({
          to: '/logs',
          search: { ...toLogSearch(readLogLink(location.searchStr)), ...(project ? { project } : {}) },
          replace: true,
        });
      case 'deploy':
        throw redirect({ to: '/deploys', search: project ? { project } : {}, replace: true });
      case 'triggers':
        throw redirect({ to: '/triggers', search: project ? { project } : {}, replace: true });
      case 'infrastructure':
        throw redirect({ to: '/infrastructure', search: project ? { project } : {}, replace: true });
      case 'costs':
        throw redirect({ to: '/costs', search: project ? { project } : {}, replace: true });
      case 'config':
        throw redirect({ to: '/environment', search: project ? { project } : {}, replace: true });
      case 'secrets':
        throw redirect({ to: '/secrets', search: project ? { project } : {}, replace: true });
      case 'icloud':
        throw redirect({ to: '/icloud', search: project ? { project } : {}, replace: true });
      case 'settings':
        throw redirect({ to: '/system', search: project ? { project } : {}, replace: true });
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

const infrastructureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/infrastructure',
  component: Infrastructure,
});

const triggersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/triggers',
  component: DeployTriggers,
});

const workflowStudioRoute = createRoute({ getParentRoute: () => rootRoute, path: '/workflows', component: WorkflowStudio });

const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects', component: ProjectsPage });

const operationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/operations', component: OperationsPage });

const cloudRunJobsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/jobs', component: CloudRunJobsPage });

const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/terminal', component: TerminalPage });

const costsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/costs',
  component: CostsPage,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  validateSearch: logSearchSchema,
  component: LogViewer,
});

const environmentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/environment',
  component: ConfigEditor,
});

const notificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notifications', component: NotificationsPage });

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
  infrastructureRoute,
  triggersRoute,
  workflowStudioRoute,
  projectsRoute,
  costsRoute,
  terminalRoute,
  operationsRoute,
  cloudRunJobsRoute,
  runRoute,
  logsRoute,
  environmentRoute,
  secretsRoute,
  notificationsRoute,
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
