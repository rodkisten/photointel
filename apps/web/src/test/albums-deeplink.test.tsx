import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlbumsPage } from '../pages/albums';

afterEach(() => vi.unstubAllGlobals());

describe('album identity independent of list pagination', () => {
  it('loads the selected album by UUID even when absent from the first list page', async () => {
    const id = 'a82f2bed-2b31-4e0c-a3b4-a550338dfd01';
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const raw = input instanceof Request ? input.url : String(input);
      const path = new URL(raw, window.location.origin).pathname;
      if (path === `/v1/albums/${id}`)
        return Response.json({
          id,
          name: 'Álbum fora da primeira página',
          description: 'Detalhe carregado por identidade',
          sort_order: 'captured_desc',
          asset_count: 0,
        });
      return Response.json({ items: [], next_cursor: null, explanation: {} });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/albums?album=${id}`]}>
          <AlbumsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Álbum fora da primeira página' })).toBeVisible();
    expect(screen.getByText('Detalhe carregado por identidade')).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(`/v1/albums/${id}`, expect.any(Object));
  });
});
