import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/error';
import { AppErrorBoundary, DiagnosticActions } from '../components/error-boundary';
import { Toast } from '../components/common';
import { useUi } from '../lib/store';
import { diagnosticFor, diagnosticLogsUrl, jobLogsUrl, reportDiagnostic } from '../lib/diagnostics';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole-app diagnostics', () => {
  it('links to the Cloud Run job and exact persisted identifiers', () => {
    const jobId = '510e985c-fb17-4294-ac63-42b7ac1c1b3c';
    const correlation = 'dd487042-1190-4441-afb3-0bfd328c2c3c';
    const url = new URL(jobLogsUrl('thumbnail_generate', jobId, correlation));
    expect(url.hostname).toBe('console.cloud.google.com');
    expect(url.searchParams.get('project')).toBe('photointel');
    const query = decodeURIComponent(url.pathname);
    expect(query).toContain('resource.labels.job_name="photointel-worker"');
    expect(query).toContain('jsonPayload.job_id="' + jobId + '"');
    expect(query).toContain('jsonPayload.correlation_id="' + correlation + '"');
    expect(decodeURIComponent(jobLogsUrl('icloud_discovery'))).toContain('photointel-discover');
  });
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
    const fetcher = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      if (!url || !options) throw new Error('Missing diagnostic request');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const incident = reportDiagnostic(new Error('PRIVATE_SECRET_IN_MESSAGE'), 'runtime');
    expect(incident.id).toMatch(/^[0-9a-f-]{36}$/);
    const [url, options] = fetcher.mock.calls[0];
    if (!options) throw new Error('Missing request options');
    expect(url).toBe('/__diagnostics/client-errors');
    const body = JSON.stringify(JSON.parse(String(options.body)));
    expect(body).toContain(incident.id);
    expect(body).not.toContain('PRIVATE_SECRET_IN_MESSAGE');
    expect(Object.keys(JSON.parse(String(options.body))).sort()).toEqual(['code', 'id', 'phase']);
  });

  it('adds a Cloudflare console link to even a generic error toast', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useUi.getState().notify('Falha inesperada', 'error');
    render(<Toast />);
    expect(screen.getByRole('link', { name: 'Ver logs no Cloudflare' })).toBeVisible();
    useUi.getState().dismiss();
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
