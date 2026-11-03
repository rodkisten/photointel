import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../api/types';
import { JobsPage } from '../pages/jobs';
import { useUi } from '../lib/store';

const activeJob: Job = {
  id: '924154ed-846f-4fb0-b400-cc4ce148a309',
  job_type: 'thumbnail_generate',
  asset_id: null,
  batch_id: null,
  status: 'running',
  attempts: 1,
  maximum_attempts: 3,
  worker_id: 'test-worker',
  progress: {},
  error_code: null,
  error_details: null,
  scheduled_at: '2026-11-03T12:00:00Z',
  started_at: '2026-11-03T12:00:00Z',
  finished_at: null,
  heartbeat_at: '2026-11-03T12:00:30Z',
  created_at: '2026-11-03T12:00:00Z',
};

const snapshot = {
  open: 43,
  waiting: 26,
  running: 4,
  paused_jobs: 13,
  paused: false,
  terminal: 83,
  by_status: { queued: 24, retrying: 2, running: 4, paused: 13 },
  batch_progress: {
    total: 100, finished: 40, completed: 35, failed: 3, skipped: 2, percent: 40,
  },
  count_scope: 'all_jobs',
};

const fetcher = vi.fn<typeof fetch>();
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/jobs']}>
        <JobsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('whole queue and per-job controls', () => {
  beforeEach(() => {
    useUi.setState({ toast: null, selected: new Set(), selecting: false });
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/v1/jobs/control') return Response.json(snapshot);
      if (path === '/v1/jobs/control/pause') return Response.json({ ...snapshot, changed: 30, paused: true });
      if (path === '/v1/jobs/control/cancel') return Response.json({ ...snapshot, changed: 43, paused: true, open: 0 });
      if (path.includes('/v1/jobs/') && path.endsWith('/pause')) return Response.json({ ...activeJob, status: 'paused' });
      if (path.startsWith('/v1/jobs?')) return Response.json({ items: [activeJob], next_cursor: null });
      if (path === '/v1/system/statistics') return Response.json({ job_counts: { running: 4 } });
      if (path === '/v1/system/capabilities') return Response.json({ gpu_inference: { state: 'not_configured' } });
      if (path === '/v1/system/status') return Response.json({ workers: [] });
      if (init?.method === 'POST') return Response.json({});
      return Response.json({ items: [], next_cursor: null });
    });
  });
  afterEach(() => {
    fetcher.mockReset();
    vi.unstubAllGlobals();
  });

  it('displays the true global count rather than the 24 items in the activity window', async () => {
    setup();
    expect(await screen.findByText('43 jobs no total da fila')).toBeVisible();
    expect(screen.getByText('26 aguardando')).toBeVisible();
    expect(screen.getByText('4 executando')).toBeVisible();
    expect(screen.getByText('40/100 · 40%')).toBeVisible();
  });

  it('sends pause-all to the server and shows per-job pause controls', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('43 jobs no total da fila');
    await user.click(screen.getByRole('button', { name: 'Pausar tudo' }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/v1/jobs/control/pause',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Pausar job' }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/v1/jobs/' + activeJob.id + '/pause',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('requires explicit confirmation for cancelling the whole queue', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('43 jobs no total da fila');
    await user.click(screen.getByRole('button', { name: 'Cancelar todos' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancelar todos os jobs pendentes?' });
    expect(within(dialog).getByText(/43 jobs serão cancelados/)).toBeVisible();
    expect(fetcher).not.toHaveBeenCalledWith(
      '/v1/jobs/control/cancel', expect.anything(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar cancelamento' }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/v1/jobs/control/cancel',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
