// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ICloudLoginForm } from './icloud-login-form';
import { api, send } from '../lib/client';

vi.mock('../lib/client', () => ({
  api: vi.fn(),
  send: vi.fn(),
  ApiError: class ApiError extends Error {
    code = 'TEST_ERROR';
    correlationId?: string;
  },
}));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ICloudLoginForm />
    </QueryClientProvider>,
  );
  return {
    ...view,
    cleanup: () => client.clear(),
  };
}

describe('iCloud browser login screens', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    vi.mocked(send).mockReset();
    vi.mocked(api).mockResolvedValue({
      ready: true,
      code: 'READY',
      message: 'Pronto',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('accepts a short Apple password, then renders six-digit 2FA and success screens', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({
        state: 'verification_required',
        mode: '2fa',
        challenge: 'A'.repeat(100),
        expires_in: 600,
        message: 'Código enviado',
      })
      .mockResolvedValueOnce({
        state: 'connected',
        valid: true,
        session_published: true,
        library: 'PrimarySync',
        checked_at: '2026-11-03T00:00:00Z',
        message: 'Sessão publicada',
      });
    const view = mount();
    const input = await screen.findByLabelText('Senha da Conta Apple');
    fireEvent.change(input, { target: { value: 'shortpass' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuar para a verificação/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('/icloud/auth/start', { password: 'shortpass' }));
    expect(await screen.findByText('Autenticação de dois fatores')).toBeTruthy();
    const code = screen.getByLabelText('Código de verificação');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar código e conectar/ }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('/icloud/auth/verify', {
        challenge: 'A'.repeat(100),
        code: '123456',
      }),
    );
    expect(await screen.findByText('Sessão Apple renovada e verificada')).toBeTruthy();
    view.cleanup();
  });

  it('does not request Apple credentials when the technical AES session key is missing', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      ready: false,
      code: 'ICLOUD_SESSION_KEY_UNAVAILABLE',
      message: 'Chave técnica não disponível',
    });
    const view = mount();
    expect(await screen.findByText('Chave técnica não disponível')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continuar para a verificação/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('link', { name: /Abrir Secret Manager/ })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    view.cleanup();
  });
});
