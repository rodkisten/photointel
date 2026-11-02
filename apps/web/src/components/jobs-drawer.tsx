import { Activity, ArrowUpRight, ChevronDown, ChevronUp, Maximize2, Minimize2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { apiUrl, useApi } from '../api/client';
import type { Info, Job, Page } from '../api/types';
import { Status } from './common';
import { jobLogsUrl } from '../lib/diagnostics';
import { sentryEventUrl } from '../lib/sentry';

type Size = 'closed' | 'mini' | 'half' | 'full';
const STORAGE_KEY = 'photointel:jobs-drawer:v2';
const ACTIVE = new Set(['queued', 'preparing', 'running', 'retrying']);
const terminal = new Set(['completed', 'failed', 'cancelled']);

function savedSize(): Size {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'mini' || saved === 'half' || saved === 'full' ? saved : 'closed';
  } catch {
    return 'closed';
  }
}

function batchSummary(batch: Info) {
  const total = Math.max(0, Number(batch.total_assets ?? 0));
  const done = Math.max(0, Number(batch.completed ?? 0));
  const failed = Math.max(0, Number(batch.failed ?? 0));
  const skipped = Math.max(0, Number(batch.skipped ?? 0));
  const percent = total ? Math.min(100, Math.round(((done + failed + skipped) / total) * 100)) : 0;
  return { total, done, failed, skipped, percent };
}

/** A persistent, non-modal mobile sheet. Its drag handle has three snap heights. */
export function JobsDrawer({ hidden = false }: { hidden?: boolean }) {
  const client = useQueryClient();
  const location = useLocation();
  // SSE keeps the badge live; a longer safety poll avoids duplicate reads.
  const jobs = useApi<Page<Job>>('/v1/jobs/activity?limit=24', 30_000);
  const batches = useApi<Page<Info>>('/v1/job-batches?limit=8', 30_000);
  const [size, setSize] = useState<Size>(savedSize);
  const touch = useRef<number | null>(null);
  const activeJobs = (jobs.data?.items ?? []).filter((job) => ACTIVE.has(job.status));
  const activeBatches = (batches.data?.items ?? []).filter((batch) => ACTIVE.has(String(batch.status)));
  const recent = (jobs.data?.items ?? []).slice(0, 8);
  const visibleBatch =
    activeBatches[0] ?? batches.data?.items.find((batch) => !terminal.has(String(batch.status)));
  const progress = visibleBatch ? batchSummary(visibleBatch) : null;
  const title = activeJobs.some((job) => job.status === 'running')
    ? 'Processamento em andamento'
    : activeJobs.length || activeBatches.length
      ? 'Jobs aguardando execução'
      : 'Atividade de processamento';

  function resize(next: Size) {
    setSize(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Safari private mode */
    }
  }

  useEffect(() => {
    // The processing page already owns one SSE listener for the same events.
    if (location.pathname === '/jobs' || !('EventSource' in window)) return;
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let cursor = '';
    const invalidate = () => {
      if (refresh) return;
      refresh = setTimeout(() => {
        refresh = undefined;
        void client.invalidateQueries({
          predicate: (query) => {
            const path = String(query.queryKey[0]);
            return (
              path.startsWith('/v1/jobs') ||
              path.startsWith('/v1/job-batches') ||
              path === '/v1/system/statistics'
            );
          },
          refetchType: 'active',
        });
      }, 400);
    };
    const connect = () => {
      if (stopped) return;
      source = new EventSource(apiUrl('/v1/jobs/events' + (cursor ? '?after=' + cursor : '')), {
        withCredentials: true,
      });
      source.addEventListener('job', (event) => {
        cursor = (event as MessageEvent).lastEventId || cursor;
        invalidate();
      });
      source.addEventListener('reconnect', () => {
        source?.close();
        if (!stopped) reconnect = setTimeout(connect, 1200);
      });
      source.onerror = () => {
        source?.close();
        if (!stopped) reconnect = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(reconnect);
      clearTimeout(refresh);
    };
  }, [client, location.pathname]);

  const onTouchStart = (event: TouchEvent) => {
    touch.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (touch.current == null) return;
    const delta = event.changedTouches[0]?.clientY - touch.current;
    touch.current = null;
    if (delta == null || Math.abs(delta) < 45) return;
    if (delta < 0) resize(size === 'mini' ? 'half' : 'full');
    else resize(size === 'full' ? 'half' : size === 'half' ? 'mini' : 'closed');
  };

  if (hidden) return null;
  if (size === 'closed')
    return (
      <button
        type="button"
        className="jobs-drawer-toggle"
        onClick={() => resize('mini')}
        aria-label={`Abrir monitor de jobs: ${activeJobs.length} ativos`}
      >
        <Activity
          size={17}
          className={activeJobs.some((job) => job.status === 'running') ? 'job-running-icon' : ''}
        />
        <span>{activeJobs.length ? `${activeJobs.length} jobs` : 'Jobs'}</span>
        {progress && (
          <span className="jobs-toggle-progress" aria-label={`Progresso: ${progress.percent}%`}>
            <span style={{ width: `${progress.percent}%` }} />
          </span>
        )}
        <ChevronUp size={15} />
      </button>
    );
  return (
    <section
      className={'jobs-drawer jobs-drawer-' + size}
      aria-label="Monitor de jobs"
      aria-live="off"
      data-testid="jobs-drawer"
    >
      <button
        type="button"
        className="jobs-drawer-grip"
        aria-label="Arraste para ajustar o painel de jobs"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={() => resize(size === 'mini' ? 'half' : size === 'half' ? 'full' : 'mini')}
      >
        <span />
      </button>
      <div className="jobs-drawer-header">
        <button
          type="button"
          className="jobs-drawer-heading"
          onClick={() => resize(size === 'mini' ? 'half' : 'mini')}
        >
          <Activity
            size={17}
            className={activeJobs.some((job) => job.status === 'running') ? 'job-running-icon' : ''}
          />
          <span>
            <strong>{title}</strong>
            <small>
              {activeJobs.length} ativos · {activeBatches.length} lotes
            </small>
          </span>
        </button>
        <div className="jobs-drawer-actions">
          <NavLink to="/jobs" aria-label="Abrir centro de processamento">
            <ArrowUpRight size={17} />
          </NavLink>
          <button
            type="button"
            aria-label={size === 'full' ? 'Minimizar painel' : 'Expandir painel'}
            onClick={() => resize(size === 'full' ? 'mini' : 'full')}
          >
            {size === 'full' ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            type="button"
            aria-label={size === 'mini' ? 'Expandir jobs' : 'Minimizar jobs'}
            onClick={() => resize(size === 'mini' ? 'half' : 'mini')}
          >
            {size === 'mini' ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
          <button type="button" aria-label="Fechar painel de jobs" onClick={() => resize('closed')}>
            <X size={17} />
          </button>
        </div>
      </div>
      {progress && (
        <div className="jobs-drawer-overall">
          <div className="jobs-drawer-stats">
            <strong>{String(visibleBatch?.name ?? 'Lote')}</strong>
            <span>{progress.total ? progress.percent + '%' : 'Calculando…'}</span>
          </div>
          <div
            className={'progress-track ' + (activeBatches.length ? 'progress-active' : '')}
            role="progressbar"
            aria-label="Progresso do lote"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <div className="progress-fill" style={{ width: progress.percent + '%' }} />
          </div>
        </div>
      )}
      {size !== 'mini' && (
        <div className="jobs-drawer-content">
          {recent.length === 0 ? (
            <p className="muted">Nenhum job recente.</p>
          ) : (
            recent.map((job) => (
              <div className="jobs-drawer-job" key={job.id}>
                <div>
                  <strong>{job.job_type.replaceAll('_', ' ')}</strong>
                  <small>
                    ID {job.id.slice(0, 8)} · tentativa {job.attempts}/{job.maximum_attempts}
                  </small>
                </div>
                <Status value={job.status} />
                {job.status === 'failed' &&
                  typeof job.error_details?.sentry_event_id === 'string' &&
                  sentryEventUrl(job.error_details.sentry_event_id) && (
                    <a
                      href={sentryEventUrl(job.error_details.sentry_event_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Ver erro no Sentry"
                    >
                      <ArrowUpRight size={16} />
                    </a>
                  )}
                {job.status === 'failed' && (
                  <a
                    href={jobLogsUrl(
                      job.job_type,
                      job.id,
                      typeof job.error_details?.correlation_id === 'string'
                        ? job.error_details.correlation_id
                        : undefined,
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={'Ver logs do job ' + job.id}
                  >
                    <ArrowUpRight size={16} />
                  </a>
                )}
              </div>
            ))
          )}
          <NavLink className="jobs-drawer-view-all" to="/jobs" onClick={() => resize('mini')}>
            Abrir centro de processamento <ArrowUpRight size={15} />
          </NavLink>
        </div>
      )}
    </section>
  );
}
