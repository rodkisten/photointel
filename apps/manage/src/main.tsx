import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { captureManageBrowserError, initManageSentry } from './lib/sentry';

initManageSentry();

window.addEventListener(
  'error',
  (event) => {
    if (event.error) captureManageBrowserError(event.error, 'window.error');
    else if (event.target === window)
      captureManageBrowserError(new Error('Erro de script sem exception acessível'), 'window.error');
  },
  true,
);
window.addEventListener('unhandledrejection', (event) => {
  captureManageBrowserError(event.reason, 'promise');
});

class ManageBoundary extends Component<React.PropsWithChildren, { error: Error | null; id?: string }> {
  state: { error: Error | null; id?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    const id = captureManageBrowserError(error, 'render');
    this.setState({ id });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: '100vh', padding: 24, background: '#0d0e10', color: 'white' }}>
        <h1>PhotoIntel Manage encontrou um erro</h1>
        <p>
          {this.state.error.name}: {this.state.error.message}
        </p>
        {this.state.id && <p>Correlation ID: {this.state.id}</p>}
        <button onClick={() => window.location.reload()}>Recarregar painel</button>
      </main>
    );
  }
}

const reportQueryError = (error: Error) => {
  captureManageBrowserError(error, 'api');
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportQueryError }),
  mutationCache: new MutationCache({ onError: reportQueryError }),
  defaultOptions: {
    queries: {
      staleTime: 12000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
const element = document.getElementById('root');
if (!element) throw new Error('Missing manage root');
createRoot(element).render(
  <React.StrictMode>
    <ManageBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ManageBoundary>
  </React.StrictMode>,
);

function updateOfflineNotice(): void {
  let notice = document.getElementById('photointel-manage-offline');
  if (navigator.onLine) {
    notice?.remove();
    return;
  }
  if (notice) return;
  notice = document.createElement('div');
  notice.id = 'photointel-manage-offline';
  notice.setAttribute('role', 'status');
  notice.textContent = 'Sem conexão · a interface está disponível offline, mas dados e ações exigem internet.';
  Object.assign(notice.style, {
    position: 'fixed',
    bottom: 'max(12px, env(safe-area-inset-bottom))',
    left: '12px',
    right: '12px',
    marginInline: 'auto',
    maxWidth: '560px',
    zIndex: '2147483646',
    background: '#1d2523',
    color: '#e7fcf3',
    border: '1px solid #537566',
    borderRadius: '12px',
    padding: '12px 16px',
    font: '13px/1.4 system-ui, sans-serif',
    boxShadow: '0 4px 20px #0005',
  });
  document.body.appendChild(notice);
}

window.addEventListener('online', updateOfflineNotice);
window.addEventListener('offline', updateOfflineNotice);
updateOfflineNotice();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .catch((error) => captureManageBrowserError(error, 'service-worker'));
  });
}
