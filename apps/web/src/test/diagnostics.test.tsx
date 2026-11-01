import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/error';
import { AppErrorBoundary, DiagnosticActions } from '../components/error-boundary';
import { diagnosticFor, diagnosticLogsUrl, reportDiagnostic } from '../lib/diagnostics';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole-app diagnostics', () => {
  it('preserves Cloud Run correlation IDs in a filterable GCP logs link', () => {
    const id = 'b663f9ee-1699-4b2c-b157-ff5573f0316f';
    const error = new ApiError('Falha na API', 503, 'DATABASE_UNAVAILABLE', id,
      { source: 'gcp', method: 'GET', path: '/v1/assets' });
    const incident = diagnosticFor(error, 'api');
    expect(incident.id).toBe(id);
    expect(incident.source).toBe('gcp');
    expect(decodeURIComponent(diagnosticLogsUrl(incident))).toContain(id);
    render(<DiagnosticActions incident={incident} />);
    expect(screen.getByText(id)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver logs no GCP' }))
      .toHaveAttribute('href', expect.stringContaining('project=photointel'));
  });

  it('sends only whitelisted metadata to Cloudflare, never stack or error message', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const incident = reportDiagnostic(new Error('PRIVATE_SECRET_IN_MESSAGE'), 'runtime');
    expect(incident.id).toMatch(/^[0-9a-f-]{36}$/);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/__diagnostics/client-errors');
    const body = JSON.stringify(JSON.parse(options.body));
    expect(body).toContain(incident.id);
    expect(body).not.toContain('PRIVATE_SECRET_IN_MESSAGE');
    expect(Object.keys(JSON.parse(options.body)).sort()).toEqual(['code', 'id', 'phase']);
  });

  it('shows recovery actions rather than a blank screen after a React render exception', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Crash(): never { throw new Error('Simulated rendering failure'); }
    render(<AppErrorBoundary><Crash /></AppErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível exibir esta página');
    expect(screen.getByRole('button', { name: /Recarregar o aplicativo/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver logs no Cloudflare' })).toBeVisible();
    expect(screen.getByText(/Correlation ID/)).toBeVisible();
  });
});
