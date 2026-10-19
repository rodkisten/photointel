import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICloudPage } from '../pages/icloud';

afterEach(() => vi.unstubAllGlobals());

function mount(environment: 'test' | 'production') {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path === '/v1/settings') return Response.json({ app_env: environment });
    if (path === '/v1/ingestion/status') return Response.json({
      enabled: false, paused: false, import_limit: 100, authentication: { state: 'not_configured' },
    });
    return Response.json({ items: [], next_cursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false },
  } });
  render(<QueryClientProvider client={client}><ICloudPage /></QueryClientProvider>);
  return fetcher;
}

describe('controlled ingestion administration', () => {
  it('selects a fixture source through its accessible label and submits a bounded run', async () => {
    const user = userEvent.setup();
    const fetcher = mount('test');
    const source = screen.getByRole('combobox', { name: 'Fonte' });
    await waitFor(() => expect(source).toBeEnabled());
    expect(screen.getByLabelText('Fonte', { exact: true })).toBe(source);
    await user.selectOptions(source, 'fixture');
    const limit = screen.getByRole('spinbutton', { name: 'Limite desta execução' });
    expect(limit).toHaveAccessibleDescription(/Comece com até 100/);
    await user.clear(limit);
    await user.type(limit, '4');
    await user.click(screen.getByRole('button', { name: 'Importar fixtures locais' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/v1/ingestion/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({
        source: 'fixture', limit: 4, mode: 'backfill', full_scan: false, confirm_expansion: false,
      }) }),
    ));
  });

  it('keeps synthetic sources unavailable in production and disables unconfigured iCloud', async () => {
    mount('production');
    const source = screen.getByRole('combobox', { name: 'Fonte' });
    await waitFor(() => expect(source).toBeEnabled());
    expect(within(source).queryByRole('option', { name: /sintéticas/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Importar até 100 fotografias' })).toBeDisabled();
  });
});
