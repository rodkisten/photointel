import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { captureManageBrowserError, initManageSentry } from './lib/sentry';

initManageSentry();

window.addEventListener('error', (event) => {
  if (event.error) captureManageBrowserError(event.error, 'window.error');
  else if (event.target === window)
    captureManageBrowserError(new Error('Erro de script sem exception acessível'), 'window.error');
}, true);
window.addEventListener('unhandledrejection', (event) => {
  captureManageBrowserError(event.reason, 'promise');
});

class ManageBoundary extends Component<
  React.PropsWithChildren,
  { error: Error | null; id?: string }
> {
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
        <p>{this.state.error.name}: {this.state.error.message}</p>
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
        <App />
      </QueryClientProvider>
    </ManageBoundary>
  </React.StrictMode>,
);
