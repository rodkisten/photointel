import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/error';
import { AppErrorBoundary, DiagnosticActions } from '../components/error-boundary';
import { Toast } from '../components/common';
import { useUi } from '../lib/store';
import {
  diagnosticFor,
  diagnosticLogsQuery,
  diagnosticLogsUrl,
  jobLogsUrl,
  reportDiagnostic,
} from '../lib/diagnostics';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole-app diagnostics', () => {
  it('links a job and correlation ID directly to Manage', () => {
    const jobId = '510e985c-fb17-4294-ac63-42b7ac1c1b3c';
    const correlation = 'dd487042-1190-4441-afb3-0bfd328c2c3c';
    const at = new Date(Date.now() - 60_000).toISOString();
    const url = new URL(jobLogsUrl('thumbnail_generate', jobId, correlation, at));
    expect(url.hostname).toBe('photos-manage.migos.club');
    expect(url.searchParams.get('tab')).toBe('logs');
    expect(url.searchParams.get('source')).toBe('gcp');
    expect(url.searchParams.get('job')).toBe(jobId);
    expect(url.searchParams.get('correlation')).toBe(correlation);
    expect(url.searchParams.get('job_type')).toBe('thumbnail_generate');
    expect(url.searchParams.get('at')).toBe(at);
    expect(new URL(jobLogsUrl('icloud_discovery')).searchParams.get('job_type')).toBe('icloud_discovery');
  });
  it('preserves Cloud Run correlation IDs in a Manage deep link', () => {
    const id = 'b663f9ee-1699-4b2c-b157-ff5573f0316f';
    const error = new ApiError('Falha na API', 503, 'DATABASE_UNAVAILABLE', id, {
      source: 'gcp',
      method: 'GET',
      path: '/v1/assets',
    });
    const incident = diagnosticFor(error, 'api');
    expect(incident.id).toBe(id);
    expect(incident.source).toBe('gcp');
    const url = new URL(diagnosticLogsUrl(incident));
    expect(url.hostname).toBe('photos-manage.migos.club');
    expect(url.searchParams.get('source')).toBe('gcp');
    expect(url.searchParams.get('correlation')).toBe(id);
    expect(diagnosticLogsQuery(incident)).toContain('SEARCH("' + id + '")');
    render(<DiagnosticActions incident={incident} />);
    expect(screen.getByText(id)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver logs no Manage' })).toHaveAttribute(
      'href',
      expect.stringContaining('photos-manage.migos.club'),
    );
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

  it('adds a Manage link to even a generic error toast', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useUi.getState().notify('Falha inesperada', 'error');
    render(<Toast />);
    expect(screen.getByRole('link', { name: 'Ver logs no Manage' })).toBeVisible();
    useUi.getState().dismiss();
  });

  it('shows recovery actions rather than a blank screen after a React render exception', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Crash(): never {
      throw new Error('Simulated rendering failure');
    }
    render(
      <AppErrorBoundary>
        <Crash />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível exibir esta página');
    expect(screen.getByRole('button', { name: /Recarregar o aplicativo/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver logs no Manage' })).toBeVisible();
    expect(screen.getByText(/Correlation ID/)).toBeVisible();
  });
});
