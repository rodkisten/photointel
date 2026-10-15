import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(await request('/v1/assets/id/tags', {
      method: 'PATCH', body: JSON.stringify({ add: ['viagem'] }),
    })).toEqual({ saved: true });
    expect(fetcher).toHaveBeenCalledWith('/v1/assets/id/tags', expect.objectContaining({
      credentials: 'include', cache: 'no-store', method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it.each([401, 403])('turns HTTP %s into an Access recovery action', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private provider error', {
      status, headers: { 'X-Correlation-ID': 'correlation-test' },
    })));
    let error: unknown;
    try { await request('/v1/assets'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).correlationId).toBe('correlation-test');
    render(<ErrorState error={error as ApiError} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Entre novamente pelo Cloudflare Access');
    expect(screen.getByRole('button', { name: 'Entrar novamente' })).toBeVisible();
    expect(screen.getByRole('alert')).not.toHaveTextContent('private provider error');
  });

  it('refreshes expired media authorization with a new authenticated URL', async () => {
    const user = userEvent.setup();
    render(<PrivateImage src="/v1/assets/test/media/thumbnail_small" alt="Acervo privado" />);
    const image = screen.getByRole('img', { name: 'Acervo privado' });
    expect(image).toHaveAttribute('crossorigin', 'use-credentials');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(image);
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(screen.getByRole('img')).toHaveAttribute(
      'src', '/v1/assets/test/media/thumbnail_small?retry=1',
    );
  });

  it('gives dialogs an accessible name, close action and Escape behavior', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<Dialog open onOpenChange={close} title="Revisar alteração"
      description="Nenhuma alteração será aplicada automaticamente.">
      <button>Confirmar individualmente</button>
    </Dialog>);
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
