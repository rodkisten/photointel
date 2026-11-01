import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  const rendered = render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[path]}>{content}</MemoryRouter>
  </QueryClientProvider>);
  return { ...rendered, client };
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
  afterEach(() => { fetcher.mockReset(); vi.useRealTimers(); vi.unstubAllGlobals(); });


  it('coalesces a replayed job event burst and cancels queued refresh on navigation', async () => {
    const sources: EventTarget[] = [];
    const close = vi.fn();
    vi.stubGlobal('EventSource', class extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = close;
      constructor() { super(); sources.push(this); }
    });
    const { client, unmount } = mount();
    expect(await screen.findByText('Geração de prévias')).toBeVisible();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.useFakeTimers();
    act(() => {
      for (let index = 0; index < 500; index++) {
        sources[0].dispatchEvent(new MessageEvent('job', { lastEventId: String(index) }));
      }
    });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith(
      expect.objectContaining({ predicate: expect.any(Function) }), { cancelRefetch: false },
    );
    act(() => { sources[0].dispatchEvent(new MessageEvent('job', { lastEventId: '501' })); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });

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

  it('keeps a failed batch creation dialog open and shows the actual 409 cause', async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetcher.mockImplementation(async (input) => {
      const path = String(input);
      if (path === '/v1/jobs/reindex') return Response.json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Nenhuma foto disponível para este lote',
          details: { reason: 'NO_ELIGIBLE_ASSETS', requested_limit: 10 },
          correlation_id: '0b465c4e-050d-4647-b939-90c85451d092',
        },
      }, { status: 409, headers: {
        'X-Correlation-ID': '0b465c4e-050d-4647-b939-90c85451d092',
        'X-PhotoIntel-Source': 'gcp',
      } });
      if (path.startsWith('/v1/jobs?')) return Response.json({ items: [], next_cursor: null });
      if (path === '/v1/system/capabilities') return Response.json({
        gpu_inference: { state: 'not_configured', reason: 'GPU desligada' },
      });
      return Response.json({ items: [], next_cursor: null });
    });
    mount();
    await user.click(screen.getByRole('button', { name: 'Processar lote' }));
    const dialog = screen.getByRole('dialog', { name: 'Processar um lote' });
    await user.click(within(dialog).getByRole('button', { name: 'Criar lote' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Nenhuma foto disponível para este lote',
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent('NO_ELIGIBLE_ASSETS');
    expect(within(dialog).getByText('0b465c4e-050d-4647-b939-90c85451d092')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Copiar filtro do GCP' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Criar lote' })).toBeEnabled();
    expect(useUi.getState().toast?.text).toContain('Nenhuma foto disponível');
    errorSpy.mockRestore();
  });

  it('opens the accessible mobile navigation and reaches a real page', async () => {
    const user = userEvent.setup();
    mount(<App />, '/albums');
    expect(await screen.findByRole('heading', { name: 'Álbuns' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Mais páginas' }));
    const menu = screen.getByRole('dialog', { name: 'Seu workspace' });
    await user.click(within(menu).getByRole('link', { name: 'Biblioteca' }));
    expect(await screen.findByRole('heading', { name: 'Biblioteca' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
