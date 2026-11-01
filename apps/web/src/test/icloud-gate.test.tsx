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

function mockApi({ profile = 'limited', catalog = 1000 } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path === '/v1/verification/gates') return Response.json({
      full_backfill_unlocked: false,
      items: [{
        id: 'F', name: 'Importações acima de 1.000 fotos', status: 'not_verified',
        reason: 'Autorize escala após verificar capacidade e custos.',
        requirements: ['Teste lote pequeno'], evidence: [], verified_at: null,
      }],
    });
    if (path === '/v1/ingestion/status') return Response.json({
      enabled: true, default_import_limit: 100, import_limit: 100,
      hard_import_limit: 10000, maximum_authorized_import_limit: 2000,
      verification_gates_enforced: true,
      catalog_asset_limit: catalog, database_profile: profile,
      authentication: { state: 'valid' },
    });
    if (path === '/v1/settings') return Response.json({ app_env: 'production' });
    if (path === '/v1/ingestion/start') return Response.json({ job_id: 'ok' });
    return Response.json({ items: [], next_cursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('simplified iCloud scale approval UX', () => {
  it('allows 10-photo requests without any manual gate', async () => {
    const fetcher = mockApi();
    mount();
    const user = userEvent.setup();
    const limit = await screen.findByRole('spinbutton', { name: 'Limite desta execução' });
    await user.clear(limit);
    await user.type(limit, '10');
    const start = screen.getByRole('button', { name: 'Importar até 10 fotografias' });
    expect(start).toBeEnabled();
    expect(screen.queryByText('Autorização necessária acima de 1.000 fotos')).toBeNull();
    await user.click(start);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/v1/ingestion/start',
      expect.objectContaining({ method: 'POST' })));
  });

  it('requires scale evidence only when a continuous target exceeds 1000', async () => {
    mockApi({ profile: 'full', catalog: 3000 });
    mount();
    const user = userEvent.setup();
    await screen.findByRole('checkbox', { name: 'Autorizar backfill contínuo' });
    const continuous = screen.getByRole('checkbox', { name: 'Autorizar backfill contínuo' });
    expect(continuous).toBeEnabled();
    await user.click(continuous);
    const target = screen.getByRole('spinbutton', { name: 'Meta total autorizada' });
    await user.clear(target);
    await user.type(target, '1001');
    expect(await screen.findByText('Autorização necessária acima de 1.000 fotos')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Autorizar importações grandes' }))
      .toHaveAttribute('href', '/setup');
    expect(screen.getByRole('button', { name: 'Importar até 100 fotografias' })).toBeDisabled();
  });
});
