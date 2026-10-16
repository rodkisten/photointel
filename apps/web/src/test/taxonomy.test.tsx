import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagsPage } from '../pages/tags';

afterEach(() => vi.unstubAllGlobals());

describe('taxonomy category policy', () => {
  it('persists confidence and enablement while preserving hidden category preferences', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/v1/tags/categories') return Response.json({ items: [
        { key: 'person', name: 'Pessoas', count: 2, is_sensitive: false,
          enabled: true, minimum_confidence: 0.4 },
      ], next_cursor: null });
      if (path === '/v1/settings') return Response.json({ taxonomy_categories: {
        sexual_action: { enabled: false, minimum_confidence: 0.9 },
      } });
      return Response.json({ items: [], next_cursor: null });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new QueryClient({ defaultOptions: {
      queries: { retry: false, gcTime: 0 }, mutations: { retry: false },
    } });
    render(<QueryClientProvider client={client}><TagsPage /></QueryClientProvider>);
    const configure = screen.getByRole('button', { name: 'Configurar categorias' });
    await waitFor(() => expect(configure).toBeEnabled());
    await user.click(configure);
    expect(screen.getByRole('dialog', { name: 'Configurar categorias' })).toBeVisible();
    expect(screen.queryByText('sexual_action')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /^Pessoas/ }));
    fireEvent.change(screen.getByRole('slider', { name: /Confiança mínima de Pessoas/ }), {
      target: { value: '75' },
    });
    await user.click(screen.getByRole('button', { name: 'Salvar categorias' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/v1/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({
        taxonomy_categories: {
          sexual_action: { enabled: false, minimum_confidence: 0.9 },
          person: { enabled: false, minimum_confidence: 0.75 },
        },
      }) }),
    ));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
