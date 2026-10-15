import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { Job } from '../api/types';
import { JobsPage } from '../pages/jobs';
import { useUi } from '../lib/store';

const failed: Job = {
  id: 'e59086a6-4e24-4c96-bcc4-b982448ba241', job_type: 'thumbnail_generate',
  asset_id: null, batch_id: null, status: 'failed', attempts: 3, maximum_attempts: 3,
  worker_id: 'worker-fixture', progress: { bytes_transferred: 2048, processed: 1 },
  error_code: 'MEDIA_DECODE_FAILED', error_details: { recovery: 'Reimporte a representação' },
  scheduled_at: '2024-04-03T12:00:00Z', started_at: '2024-04-03T12:00:00Z',
  finished_at: '2024-04-03T12:00:02Z', heartbeat_at: null,
  created_at: '2024-04-03T12:00:00Z',
};

function mount(content = <JobsPage />, path = '/jobs') {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false },
  } });
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[path]}>{content}</MemoryRouter>
  </QueryClientProvider>);
}

describe('persisted operations and navigation', () => {
  const fetcher = vi.fn<typeof fetch>();
  beforeEach(() => {
    useUi.setState({ toast: null, selected: new Set(), selecting: false });
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockImplementation(async (input) => {
      const path = String(input);
      if (path.startsWith('/v1/jobs?')) return Response.json({ items: [failed], next_cursor: null });
      if (path === '/v1/system/statistics') return Response.json({
        job_counts: { failed: 1, running: 0, completed: 7 }, pending_processing: 2,
      });
      if (path === '/v1/system/status') return Response.json({ environment: 'test', workers: [] });
      if (path === '/v1/system/capabilities') return Response.json({
        gpu_inference: { state: 'not_configured', reason: 'GPU desligada' },
      });
      return Response.json({ items: [], next_cursor: null });
    });
  });
  afterEach(() => { fetcher.mockReset(); vi.unstubAllGlobals(); });

  it('loads saved job state, shows actual errors and retries through the API', async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('Geração de prévias')).toBeVisible();
    expect(screen.getByText('tentativa 3/3', { exact: false })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Inspecionar job' }));
    const dialog = screen.getByRole('dialog', { name: 'Inspeção do job' });
    expect(dialog).toHaveTextContent('MEDIA_DECODE_FAILED');
    expect(dialog).toHaveTextContent('Reimporte a representação');
    expect(dialog).toHaveTextContent('2048');
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await user.click(screen.getByRole('button', { name: 'Repetir job' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/v1/jobs/${failed.id}/retry`, expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('blocks unconfigured inference and requires consent for a large reindex', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Processar lote' }));
    const dialog = screen.getByRole('dialog', { name: 'Processar um lote' });
    expect(within(dialog).getByRole('checkbox', { name: /Classificação JoyTag/ })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: /Embeddings SigLIP 2/ })).toBeDisabled();
    await user.clear(screen.getByLabelText('Limite de fotografias'));
    await user.type(screen.getByLabelText('Limite de fotografias'), '101');
    expect(within(dialog).getByRole('button', { name: 'Criar lote' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Confirmo reprocessar mais de 100 fotos' }));
    await user.click(within(dialog).getByRole('button', { name: 'Criar lote' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/v1/jobs/reindex',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({
        limit: 101, job_types: ['duplicate_analysis', 'quality_analysis'], confirm_large_batch: true,
      }) }),
    ));
  });

  it('opens the accessible mobile navigation and reaches a real page', async () => {
    const user = userEvent.setup();
    mount(<App />, '/albums');
    expect(await screen.findByRole('heading', { name: 'Álbuns', exact: true })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Mais páginas' }));
    const menu = screen.getByRole('dialog', { name: 'Seu workspace' });
    await user.click(within(menu).getByRole('link', { name: 'Biblioteca' }));
    expect(await screen.findByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
