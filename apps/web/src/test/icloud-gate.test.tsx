import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICloudPage } from '../pages/icloud';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount() {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false },
  } });
  return render(<QueryClientProvider client={client}>
    <MemoryRouter><ICloudPage /></MemoryRouter>
  </QueryClientProvider>);
}

describe('iCloud release verification UX', () => {
  it('shows gate A and blocks new 10-photo requests until real verification', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/v1/verification/gates') return Response.json({
        full_backfill_unlocked: false,
        items: [{
          id: 'A', name: 'Fixtures locais', status: 'not_verified',
          reason: 'Evidência pertence a outro release ou release não identificado',
          requirements: ['Compose, migrações, API, worker e PWA'],
          evidence: [], verified_at: null,
        }],
      });
      if (path === '/v1/ingestion/status') return Response.json({
        enabled: true, default_import_limit: 100, import_limit: 100,
        hard_import_limit: 10000, maximum_authorized_import_limit: 1000,
        catalog_asset_limit: 1000, database_profile: 'limited',
        authentication: { state: 'valid' },
      });
      if (path === '/v1/settings') return Response.json({ app_env: 'production' });
      return Response.json({ items: [], next_cursor: null });
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    mount();
    const limit = await screen.findByRole('spinbutton', { name: 'Limite desta execução' });
    await user.clear(limit);
    await user.type(limit, '10');
    expect(await screen.findByText('Importação bloqueada por validação desta versão')).toBeVisible();
    expect(screen.getByText(/Gate A: Fixtures locais/)).toBeVisible();
    expect(screen.getByText(/Compose, migrações, API, worker e PWA/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Abrir Preparação e validação' }))
      .toHaveAttribute('href', '/setup');
    expect(screen.getByRole('button', { name: 'Importar até 10 fotografias' })).toBeDisabled();
    await waitFor(() => expect(fetcher).not.toHaveBeenCalledWith(
      '/v1/ingestion/start', expect.anything(),
    ));
  });
});
