import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

const client = new QueryClient({ defaultOptions: {
  queries: { staleTime: 15_000, gcTime: 5 * 60_000, refetchOnWindowFocus: true },
  mutations: { retry: false },
} });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={client}>
    <BrowserRouter><App /></BrowserRouter>
  </QueryClientProvider></React.StrictMode>,
);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); });
}
