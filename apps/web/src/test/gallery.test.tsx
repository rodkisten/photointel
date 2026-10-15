import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../components/gallery';
import type { Asset } from '../api/types';
import { useUi } from '../lib/store';

const asset = (index: number): Asset => ({
  id: `asset-${index}`, library_id: 'library', source_asset_key: String(index),
  filename: `fixture-${index}.jpg`, media_type: 'image',
  captured_at: '2024-04-03T12:00:00Z', added_at: null,
  width: 960, height: 720, duration: null, filesize: 12000,
  content_revision: 'r1', representation_revision: 'r1', ingestion_status: 'completed',
  classification_status: 'pending', visibility_status: 'active', quality: {},
  last_error: null, created_at: '2024-04-03T12:00:00Z',
  thumbnail_url: `/v1/assets/asset-${index}/media/thumbnail_small`,
});

const pathname = (input: RequestInfo | URL) => new URL(
  input instanceof Request ? input.url : String(input), window.location.origin,
).pathname;

function show() {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false },
  } });
  return render(<QueryClientProvider client={client}><MemoryRouter>
    <Gallery search={{ limit: 90, sort: 'captured_desc' }} />
  </MemoryRouter></QueryClientProvider>);
}

describe('private virtualized gallery', () => {
  const fetcher = vi.fn<typeof fetch>();
  beforeEach(() => {
    useUi.setState({ selected: new Set(), selecting: false, density: 1, toast: null });
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockImplementation(async (input) => Response.json(
      pathname(input) === '/v1/search'
        ? { items: Array.from({ length: 1000 }, (_, index) => asset(index)),
          next_cursor: null, explanation: {} }
        : { items: [], next_cursor: null },
    ));
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true, value: vi.fn(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); fetcher.mockReset(); });

  it('keeps the DOM bounded when a page contains a thousand assets', async () => {
    const { container } = show();
    await screen.findByText('1.000 fotografias carregadas');
    await screen.findByRole('button', { name: 'fixture-0.jpg' });
    const tiles = container.querySelectorAll('.photo-tile');
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(150);
    expect(screen.queryByRole('button', { name: 'fixture-999.jpg' })).toBeNull();
    expect(screen.getByRole('img', { name: 'fixture-0.jpg' })).toHaveAttribute(
      'src', '/v1/assets/asset-0/media/thumbnail_small',
    );
  });

  it('selects an asset and sends a bounded manual-tag mutation', async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole('button', { name: 'fixture-0.jpg' });
    await user.click(screen.getByRole('button', { name: 'Selecionar' }));
    await user.click(screen.getByRole('button', { name: 'fixture-0.jpg' }));
    expect(screen.getByRole('button', { name: 'fixture-0.jpg' })).toHaveAttribute(
      'aria-pressed', 'true',
    );
    await user.click(screen.getByRole('button', { name: 'Keyword' }));
    expect(screen.getByRole('dialog', { name: 'Adicionar palavras-chave' })).toBeVisible();
    await user.type(screen.getByLabelText('Palavras-chave separadas por vírgula'), 'viagem, praia');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/v1/assets/tags', expect.objectContaining({
        method: 'PATCH', body: JSON.stringify({ asset_ids: ['asset-0'], add: ['viagem', 'praia'] }),
      }),
    ));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useUi.getState().selected.size).toBe(0);
  });

  it('shows a recoverable API error and never exposes a provider response body', async () => {
    fetcher.mockImplementation(async (input) => pathname(input) === '/v1/search'
      ? new Response('<html>private gateway internals</html>', { status: 503 })
      : Response.json({ items: [], next_cursor: null }));
    show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Serviço indisponível');
    expect(alert).not.toHaveTextContent('private gateway internals');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(
      ([input]) => pathname(input) === '/v1/search',
    ).length).toBeGreaterThan(1));
  });

  it('offers an actionable empty state instead of a fabricated gallery', async () => {
    fetcher.mockImplementation(async () => Response.json({
      items: [], next_cursor: null, explanation: {},
    }));
    show();
    expect(await screen.findByRole('heading', { name: 'Seu próximo olhar começa aqui' })).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
