import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AppErrorBoundary } from './components/error-boundary';
import { IncidentInspector } from './components/incident-inspector';
import { reportDiagnostic } from './lib/diagnostics';
import { initSentry } from './lib/sentry';

initSentry();
import { useUi } from './lib/store';
import './styles.css';

const client = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => { reportDiagnostic(error, 'api'); },
  }),
  mutationCache: new MutationCache({
    onError: (error) => { reportDiagnostic(error, 'api'); },
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

window.addEventListener('error', (event) => {
  const target = event.target;
  if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
    reportNonFatal(new Error('Falha ao carregar recurso de aplicativo'), 'resource');
  } else if (target === window) {
    reportNonFatal(event.error ?? new Error('Erro JavaScript não identificado'), 'runtime');
  }
}, true);

window.addEventListener('unhandledrejection', (event) => {
  reportNonFatal(event.reason, 'promise');
});

const root = document.getElementById('root');
if (!root) {
  reportNonFatal(new Error('Elemento #root não encontrado'), 'runtime');
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={client}>
          <BrowserRouter><App /><IncidentInspector /></BrowserRouter>
        </QueryClientProvider>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .catch((error) => reportNonFatal(error, 'worker'));
  });
}
