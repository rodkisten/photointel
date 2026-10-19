import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupPage } from '../pages/setup';
import { IngestionFailures } from '../components/ingestion-failures';
import { localPath } from '../lib/safe-path';

const sha = 'a'.repeat(40);
afterEach(() => vi.unstubAllGlobals());
function mount(content: React.ReactNode) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false}}});
  return render(<QueryClientProvider client={client}><MemoryRouter>{content}</MemoryRouter></QueryClientProvider>);
}

describe('release-bound operational readiness', () => {
  it('shows real diagnostics and requires explicit attestation and evidence for a gate', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/v1/setup/status') return Response.json({checks: [
        {id: 'database', label: 'PostgreSQL', state: 'operational', reason: 'Consulta de saúde executada'},
        {id: 'modal', label: 'Modal', state: 'not_configured', reason: 'Sem credenciais configuradas'},
      ], spending: {enabled: false, gpu_enabled: false}, next_action: {label: 'Configurar Modal', href: '/settings'}});
      if (path === '/v1/verification/gates') return Response.json({items: [
        {id: 'A', name: 'Fixtures locais', status: 'not_verified', reason: 'Sem evidência para esta release'},
        {id: 'F', name: 'Backfill de produção', status: 'blocked', reason: 'Gates anteriores pendentes'},
      ], full_backfill_unlocked: false});
      return Response.json({git_sha: sha, api_version: '1.1.0', models: {}, test_results: [], ci_run_ids: []});
    });
    vi.stubGlobal('fetch', fetcher);
    mount(<SetupPage />);
    expect(await screen.findByText('Consulta de saúde executada')).toBeVisible();
    expect(screen.getByText(/GPU desativada.*outros custos/)).toBeVisible();
    await screen.findByText('Fixtures locais');
    const buttons = screen.getAllByRole('button', {name: 'Registrar verificação'});
    expect(buttons[1]).toBeDisabled();
    const user = userEvent.setup();
    await user.click(buttons[0]);
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', {name: 'Registrar resultado'});
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Referências de evidência, uma por linha'), 'reports/current.json');
    expect(save).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(save);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/v1/verification/gates', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({gate_id: 'A', status: 'passed', evidence: ['reports/current.json'],
        notes: '', release_sha: sha, operator_attestation: true}),
    })));
  });

  it('retries one failed asset and preserves quarantine as a reversible explicit action', async () => {
    const asset = '423caecb-58cf-4407-9efe-19ec210709de';
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({items: [{asset_id: asset,
      filename: 'fixture-137.jpg', status: 'failed', failure_category: 'remote_asset_unavailable',
      error_code: 'ICLOUD_ASSET_UNAVAILABLE', attempts: 3, maximum_attempts: 3}], next_cursor: null}));
    vi.stubGlobal('fetch', fetcher);
    mount(<IngestionFailures />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', {name: 'Repetir download de fixture-137.jpg'}));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(`/v1/ingestion/assets/${asset}/retry`, expect.objectContaining({method: 'POST'})));
    await user.click(screen.getByRole('button', {name: 'Colocar fixture-137.jpg em quarentena'}));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', {name: 'Confirmar quarentena'})).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Motivo'), 'Aguardar nova representação');
    await user.click(within(dialog).getByRole('button', {name: 'Confirmar quarentena'}));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(`/v1/ingestion/assets/${asset}/quarantine`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({reason: 'Aguardar nova representação'}),
    })));
  });

  it('never follows a diagnostic destination to an external origin', () => {
    expect(localPath('/settings')).toBe('/settings');
    expect(localPath('//external.example')).toBeNull();
    expect(localPath('https://external.example')).toBeNull();
    expect(localPath('/\\external.example')).toBeNull();
  });
});
