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

// Only static, allowlisted categories enter Sentry. Never attach the script URL,
// error message, photo metadata, cross-origin stack, or arbitrary resource paths.
export function classifyBrowserError(event: Event): Error | null {
  const target = event.target;
  if (target instanceof HTMLLinkElement) {
    // Optional remote typography may be blocked offline or by Safari privacy
    // settings. It already has a system-font fallback and is not an app crash.
    if (target.rel === 'stylesheet' && target.href.startsWith(
      'https://fonts.googleapis.com/'
    )) return null;
    const error = new Error('Falha no CSS essencial do aplicativo');
    error.name = 'ApplicationStylesheetLoadError';
    return error;
  }
  if (target instanceof HTMLScriptElement) {
    const error = new Error('Falha ao carregar script do aplicativo');
    error.name = 'ApplicationScriptLoadError';
    return error;
  }
  if (target !== window) return null;
  if (event instanceof ErrorEvent && event.error instanceof Error) {
    return event.error;
  }
  const error = new Error('Erro opaco do navegador sem exceção acessível');
  error.name = 'OpaqueBrowserRuntimeError';
  return error;
}

window.addEventListener('error', (event) => {
  const error = classifyBrowserError(event);
  if (!error) return;
  reportNonFatal(error,
    event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement
      ? 'resource' : 'runtime');
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
          <BrowserRouter><App /></BrowserRouter>
        </QueryClientProvider>
      </AppErrorBoundary>
      <IncidentInspector />
    </React.StrictMode>,
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .catch((error) => reportNonFatal(error, 'worker'));
  });
}
