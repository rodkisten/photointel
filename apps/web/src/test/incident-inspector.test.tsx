import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/error';
import { DiagnosticActions } from '../components/error-boundary';
import { IncidentInspector } from '../components/incident-inspector';
import { diagnosticFor } from '../lib/diagnostics';
import { useUi } from '../lib/store';

const correlationId = '0b465c4e-050d-4647-b939-90c85451d092';

beforeEach(() => {
  useUi.setState({ inspector: null, toast: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useUi.setState({ inspector: null, toast: null });
});

describe('incident inspector', () => {
  it('opens a readable mobile dialog with the exact API error and sanitized Cloud Run events', async () => {
    const user = userEvent.setup();
    const error = new ApiError(
      'Nenhuma foto disponível para este lote',
      409,
      'INVALID_REQUEST',
      correlationId,
      {
        source: 'gcp',
        path: '/v1/jobs/reindex?token=PRIVATE',
        method: 'POST',
        details: { reason: 'NO_ELIGIBLE_ASSETS', requested_limit: 10 },
      },
    );
    const incident = diagnosticFor(error, 'api');
    const fetcher = vi.fn(async (path: RequestInfo | URL) => {
      expect(path).toBe('/v1/observability/incidents/' + correlationId);
      return Response.json({
        correlation_id: correlationId,
        count: 1,
        entries: [
          {
            timestamp: '2026-11-01T13:52:26Z',
            severity: 'WARNING',
            service: 'photointel-api',
            event: 'api_http_error',
            status_code: 409,
            error_code: 'INVALID_REQUEST',
            reason: 'NO_ELIGIBLE_ASSETS',
            method: 'POST',
            route_group: '/v1/jobs/reindex',
            exception_type: null,
            job_type: null,
            job_id: null,
          },
        ],
        note: 'Campos técnicos',
      });
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <>
        <DiagnosticActions incident={incident} error={error} />
        <IncidentInspector />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Inspecionar erro' }));
    const dialog = screen.getByRole('dialog', { name: 'Diagnóstico da ocorrência' });
    expect(within(dialog).getByText('Nenhuma foto disponível para este lote')).toBeVisible();
    expect(within(dialog).getAllByText('NO_ELIGIBLE_ASSETS').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('POST').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('/v1/jobs/reindex').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(correlationId).length).toBeGreaterThan(0);
    expect(await within(dialog).findByText('api_http_error')).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Copiar relatório' })).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'Ver logs no Manage' })).toBeVisible();
    expect(dialog).not.toHaveTextContent('PRIVATE');
    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('handles primitive and null API error details without breaking React', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          correlation_id: correlationId,
          entries: [],
          count: 0,
          note: '',
        }),
      ),
    );
    for (const details of [42, 'legacy error', false, null]) {
      const error = new ApiError(
        'Validação necessária antes deste lote',
        409,
        'INVALID_REQUEST',
        correlationId,
        { source: 'gcp', details },
      );
      const view = render(
        <>
          <DiagnosticActions incident={diagnosticFor(error, 'api')} error={error} />
          <IncidentInspector />
        </>,
      );
      await user.click(screen.getByRole('button', { name: 'Inspecionar erro' }));
      expect(screen.getByRole('dialog', { name: 'Diagnóstico da ocorrência' })).toBeVisible();
      expect(screen.getByText('Validação necessária antes deste lote')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Voltar' }));
      view.unmount();
      useUi.setState({ inspector: null });
    }
  });

  it('keeps server-provided diagnostics even when the Cloud Logging API is unavailable', async () => {
    const user = userEvent.setup();
    const error = new ApiError('Lote já está ocupado', 409, 'INVALID_REQUEST', correlationId, {
      source: 'gcp',
      details: { reason: 'NO_ELIGIBLE_ASSETS' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: { code: 'STORAGE_UNAVAILABLE', message: 'Acesso aos logs indisponível' },
          },
          { status: 503 },
        ),
      ),
    );
    render(
      <>
        <DiagnosticActions incident={diagnosticFor(error, 'api')} error={error} />
        <IncidentInspector />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Inspecionar erro' }));
    const dialog = screen.getByRole('dialog', { name: 'Diagnóstico da ocorrência' });
    expect(await within(dialog).findByText(/Não foi possível recuperar os eventos/)).toBeVisible();
    expect(dialog).toHaveTextContent('NO_ELIGIBLE_ASSETS');
    expect(dialog).toHaveTextContent('Lote já está ocupado');
  });
});
