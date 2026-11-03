import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from '../api/client';
import { ErrorState, PrivateImage } from '../components/common';
import { Dialog } from '../components/ui/dialog';

afterEach(() => vi.unstubAllGlobals());

describe('private API and media', () => {
  it('sends credentials with no persistent cache and JSON headers', async () => {
    const fetcher = vi.fn(async () => Response.json({ saved: true }));
    vi.stubGlobal('fetch', fetcher);
    expect(
      await request('/v1/assets/id/tags', {
        method: 'PATCH',
        body: JSON.stringify({ add: ['viagem'] }),
      }),
    ).toEqual({ saved: true });
    expect(fetcher).toHaveBeenCalledWith(
      '/v1/assets/id/tags',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it.each([401, 403])('turns HTTP %s into an Access recovery action', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('private provider error', {
            status,
            headers: { 'X-Correlation-ID': 'correlation-test' },
          }),
      ),
    );
    let error: unknown;
    try {
      await request('/v1/assets');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).correlationId).toBe('correlation-test');
    render(<ErrorState error={error as ApiError} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Entre novamente pelo Cloudflare Access');
    expect(screen.getByRole('button', { name: 'Entrar novamente' })).toBeVisible();
    expect(screen.getByRole('alert')).not.toHaveTextContent('private provider error');
  });

  it('preserves server auth diagnostics instead of replacing them with generic text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'Autenticação inválida ou expirada',
              code: 'UNAUTHORIZED',
              correlation_id: 'body-id',
              details: { reason: 'audience_mismatch' },
            },
          },
          { status: 401, headers: { 'X-PhotoIntel-Auth': 'upstream-rejected' } },
        ),
      ),
    );
    let error: unknown;
    try {
      await request('/v1/assets?token=PRIVATE');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.message).toBe('Autenticação inválida ou expirada');
    expect(apiError.toString()).toContain('HTTP 401 · UNAUTHORIZED · GET /v1/assets');
    expect(apiError.toString()).toContain('auth=upstream-rejected');
    expect(apiError.correlationId).toBe('body-id');
    expect(apiError.details).toEqual({ reason: 'audience_mismatch' });
    expect(JSON.stringify(apiError)).not.toContain('PRIVATE');
    render(<ErrorState error={apiError} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Autenticação inválida ou expirada');
    expect(screen.getByText('Detalhes do erro')).toBeVisible();
  });

  it('keeps validation field errors while excluding echoed form inputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            detail: [
              {
                loc: ['body', 'limit'],
                msg: 'Input should be greater than 0',
                type: 'greater_than',
                input: 'PRIVATE_FORM_VALUE',
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    let error: unknown;
    try {
      await request('/v1/search', { method: 'POST' });
    } catch (caught) {
      error = caught;
    }
    expect((error as ApiError).message).toContain('body.limit: Input should be greater than 0');
    expect((error as ApiError).method).toBe('POST');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_FORM_VALUE');
  });

  it('serializes API metadata and preserves the original Error cause', () => {
    const cause = new TypeError('Failed to fetch');
    const error = new ApiError('Falha de rede', 0, 'NETWORK_ERROR', undefined, {
      method: 'GET',
      path: '/v1/info?secret=PRIVATE',
      cause,
      details: { retry: true, token: 'PRIVATE_TOKEN' },
    });
    expect(error.cause).toBe(cause);
    const serialized = JSON.parse(JSON.stringify(error));
    expect(serialized.name).toBe('ApiError');
    expect(serialized.path).toBe('/v1/info');
    expect(serialized.cause.message).toBe('Failed to fetch');
    expect(serialized.details.token).toBe('[redigido]');
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it('refreshes expired media authorization with a new authenticated URL', async () => {
    const user = userEvent.setup();
    render(<PrivateImage src="/v1/assets/test/media/thumbnail_small" alt="Acervo privado" />);
    const image = screen.getByRole('img', { name: 'Acervo privado' });
    expect(image).toHaveAttribute('crossorigin', 'use-credentials');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(image);
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Ações da prévia' }));
    await user.click(screen.getByRole('button', { name: 'Recarregar imagem' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/v1/assets/test/media/thumbnail_small?retry=1');
  });

  it('tries a smaller private thumbnail before showing a failure', () => {
    render(
      <PrivateImage
        src="/v1/assets/00000000-0000-0000-0000-000000000001/media/thumbnail_medium"
        alt="Prévia de teste"
      />,
    );
    const image = screen.getByRole('img', { name: 'Prévia de teste' });
    fireEvent.error(image);
    expect(screen.getByRole('img', { name: 'Prévia de teste' })).toHaveAttribute(
      'src',
      '/v1/assets/00000000-0000-0000-0000-000000000001/media/thumbnail_small',
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('button', { name: 'Ações da prévia' })).toBeVisible();
  });

  it('wakes an already queued preview worker instead of endlessly retrying reindex', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const url = `/v1/jobs/assets/${id}/preview`;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === url && init?.method !== 'POST')
        return Response.json({
          status: 'queued',
          ingestion_status: 'pending',
          available_variants: [],
          message: 'O processamento aguarda um worker.',
          job: {
            id: 'existing-job-id',
            type: 'media_download',
            status: 'queued',
            attempts: 0,
            max_attempts: 3,
            error_code: null,
            scheduled_at: null,
            created_at: '2026-11-01T19:00:00Z',
          },
          worker_dispatch: { status: 'retrying', error_code: 'CLOUD_RUN_DISPATCH_FAILED' },
        });
      if (String(input) === url + '/repair' && init?.method === 'POST')
        return Response.json({
          created: false,
          status: 'queued',
          message: 'O processamento já está na fila; o worker foi acionado.',
        });
      throw new Error('Unknown test request');
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<PrivateImage src={null} assetId={id} alt="Prévia pendente" />);
    await user.click(screen.getByRole('button', { name: 'Ações da prévia' }));
    expect(await screen.findByText(/O processamento aguarda um worker/)).toBeVisible();
    expect(screen.getByText(/CLOUD_RUN_DISPATCH_FAILED/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Solicitar reparo da prévia' }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(url + '/repair', expect.objectContaining({ method: 'POST' })),
    );
    expect(await screen.findByText(/O processamento já está na fila; o worker foi acionado/)).toBeVisible();
    expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/jobs/reindex'))).toHaveLength(0);
  });

  it('reveals a GCP log action when an unavailable preview is diagnosed', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: { code: 'NOT_FOUND', message: 'Prévia pendente' },
          },
          {
            status: 404,
            headers: {
              'X-PhotoIntel-Source': 'gcp',
              'X-Correlation-ID': 'b663f9ee-1699-4b2c-b157-ff5573f0316f',
            },
          },
        ),
      ),
    );
    render(
      <PrivateImage
        src="/v1/assets/00000000-0000-0000-0000-000000000001/media/thumbnail_small"
        alt="Sem prévia"
      />,
    );
    fireEvent.error(screen.getByRole('img'));
    await user.click(screen.getByRole('button', { name: 'Ações da prévia' }));
    await user.click(screen.getByRole('button', { name: 'Inspecionar erro de mídia' }));
    expect(await screen.findByRole('link', { name: 'Ver logs no Manage' })).toBeVisible();
    expect(screen.getByText('NOT_FOUND')).toBeVisible();
  });

  it('gives dialogs an accessible name, close action and Escape behavior', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={close}
        title="Revisar alteração"
        description="Nenhuma alteração será aplicada automaticamente."
      >
        <button>Confirmar individualmente</button>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Revisar alteração' })).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Nenhuma alteração será aplicada automaticamente.',
    );
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(close).toHaveBeenCalledTimes(2);
  });
});
