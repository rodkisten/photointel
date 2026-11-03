import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AppErrorBoundary } from './components/error-boundary';
import { IncidentInspector } from './components/incident-inspector';
import { reportDiagnostic } from './lib/diagnostics';
import { initSentry } from './lib/sentry';
import { classifyBrowserError } from './lib/browser-errors';

initSentry();
import { useUi } from './lib/store';
import './styles.css';

const client = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      reportDiagnostic(error, 'api');
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      reportDiagnostic(error, 'api');
    },
  }),
  defaultOptions: {
    queries: { staleTime: 15_000, gcTime: 5 * 60_000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

function reportNonFatal(error: unknown, phase: 'runtime' | 'promise' | 'resource' | 'worker') {
  const incident = reportDiagnostic(error, phase);
  if (document.querySelector('.app-shell')) {
    useUi.getState().notify('Falha detectada · ID ' + incident.id, 'error', incident);
  }
}

// Only static, allowlisted categories enter Sentry. Never attach the script URL,
// error message, photo metadata, cross-origin stack, or arbitrary resource paths.
window.addEventListener(
  'error',
  (event) => {
    const error = classifyBrowserError(event);
    if (!error) return;
    reportNonFatal(
      error,
      event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement
        ? 'resource'
        : 'runtime',
    );
  },
  true,
);

window.addEventListener('unhandledrejection', (event) => {
  reportNonFatal(event.reason, 'promise');
});

// Foreground FCM messages update all job views without waiting for polling.
window.addEventListener('photointel:fcm-message', (event) => {
  const payload = (event as CustomEvent<{
    data?: Record<string, string>;
    notification?: { title?: string; body?: string };
  }>).detail;
  if (payload?.data?.kind !== 'job_status') return;
  void client.invalidateQueries({
    predicate: (query) =>
      String(query.queryKey[0]).startsWith('/v1/jobs') ||
      String(query.queryKey[0]).startsWith('/v1/job-batches') ||
      query.queryKey[0] === '/v1/system/statistics',
  });
  if (['completed', 'failed', 'retrying'].includes(payload.data.status)) {
    const description = payload.notification?.body ?? 'O estado dos jobs foi atualizado.';
    useUi.getState().notify(description, payload.data.status === 'completed' ? 'success' : 'info');
  }
});

const root = document.getElementById('root');
if (!root) {
  reportNonFatal(new Error('Elemento #root não encontrado'), 'runtime');
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={client}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AppErrorBoundary>
      <IncidentInspector />
    </React.StrictMode>,
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .catch((error) => reportNonFatal(error, 'worker'));
  });
}
