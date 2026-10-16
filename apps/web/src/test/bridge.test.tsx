import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { BridgePage } from '../pages/bridge';

const assetId = '84ea52ba-c776-4a87-be53-cd3917464c77';
const deviceId = '951aa647-f537-4b19-819c-687537cde615';

afterEach(() => vi.unstubAllGlobals());

it('labels a populated device selector and previews a read-only keyword delta', async () => {
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockImplementation(async (input) => {
    const path = String(input);
    if (path === '/v1/apple-sync/status') return Response.json({ devices: [{
      id: deviceId, name: 'iPhone de teste', revoked_at: null,
      capabilities: { level: 'read_only', keywords_write: false },
    }] });
    if (path === '/v1/apple-sync/preview') return Response.json({
      before: ['palavra existente'], add: ['viagem'], remove: [],
      managed_keywords: [], mapping_status: 'verified',
      capability: 'read_only', write_available: false,
    });
    return Response.json({ items: [], next_cursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false },
  } });
  render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[`/bridge?asset=${assetId}`]}><BridgePage /></MemoryRouter>
  </QueryClientProvider>);
  const user = userEvent.setup();
  const selector = await screen.findByRole('combobox', { name: 'Dispositivo' });
  await screen.findByRole('option', { name: 'iPhone de teste' });
  // Options must not become part of the label's text as devices are loaded.
  expect(screen.getByLabelText('Dispositivo', { exact: true })).toBe(selector);
  await user.selectOptions(selector, deviceId);
  await user.type(screen.getByLabelText('Adicionar keywords, separadas por vírgula'), 'viagem');
  await user.click(screen.getByRole('button', { name: 'Ver prévia segura' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/v1/apple-sync/preview',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({
      asset_id: assetId, target_device_id: deviceId, add: ['viagem'], remove: [],
      approve_removals: false, single_asset_test: false, source: 'user',
    }) }),
  ));
  expect(await screen.findByText('Indisponível; operação ficará pendente')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Criar operação para aprovação' })).toBeEnabled();
  expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/apple-sync/operations')))
    .toBe(false);
});
