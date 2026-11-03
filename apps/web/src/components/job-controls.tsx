import { Pause, Play, RotateCcw, X } from 'lucide-react';
import { useAction } from '../api/client';
import type { Job } from '../api/types';
import { Button } from './ui/button';

export function JobControls({ job, compact = false }: { job: Job; compact?: boolean }) {
  const action = useAction();
  const paused = job.status === 'paused';
  const pausable = ['queued', 'retrying', 'preparing', 'running'].includes(job.status);
  const cancellable = pausable || paused;
  const retry = ['failed', 'cancelled'].includes(job.status);
  if (!pausable && !paused && !retry) return null;
  return (
    <div className={'job-inline-actions ' + (compact ? 'job-inline-actions-compact' : '')}>
      {(pausable || paused) && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={paused ? 'Retomar job ' + job.id : 'Pausar job ' + job.id}
          title={paused ? 'Retomar job' : 'Pausar job'}
          disabled={action.isPending}
          onClick={() => action.mutate({ url: '/v1/jobs/' + job.id + (paused ? '/resume' : '/pause') })}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </Button>
      )}
      {cancellable && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={'Cancelar job ' + job.id}
          title="Cancelar job"
          disabled={action.isPending}
          onClick={() => action.mutate({ url: '/v1/jobs/' + job.id + '/cancel' })}
        >
          <X size={15} />
        </Button>
      )}
      {retry && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={'Repetir job ' + job.id}
          title="Repetir job"
          disabled={action.isPending}
          onClick={() => action.mutate({ url: '/v1/jobs/' + job.id + '/retry' })}
        >
          <RotateCcw size={15} />
        </Button>
      )}
    </div>
  );
}

export function JobProgress({ job, compact = false }: { job: Job; compact?: boolean }) {
  const detail = job.progress;
  const explicit =
    typeof detail?.percent === 'number' && Number.isFinite(detail.percent)
      ? detail.percent
      : typeof detail?.completed === 'number' && typeof detail?.total === 'number' && detail.total > 0
        ? (detail.completed * 100) / detail.total
        : null;
  const percent = explicit === null ? null : Math.min(100, Math.max(0, Math.round(explicit)));
  const active = job.status === 'running' || job.status === 'preparing';
  const label =
    job.status === 'completed'
      ? 'Concluído'
      : job.status === 'failed'
        ? 'Falhou'
        : job.status === 'cancelled'
          ? 'Cancelado'
          : job.status === 'paused'
            ? 'Pausado'
            : job.status === 'retrying'
              ? 'Nova tentativa agendada'
              : job.status === 'queued'
                ? 'Aguardando worker'
                : 'Processando ' + job.job_type.replaceAll('_', ' ');
  return (
    <div className={'job-progress ' + (compact ? 'job-progress-compact' : '')}>
      <div className="job-progress-label">
        <span>{typeof detail?.stage === 'string' && detail.stage ? detail.stage : label}</span>
        {percent !== null && <span>{percent}%</span>}
      </div>
      {(active || percent !== null) && (
        <div
          className={'progress-track ' + (active && percent === null ? 'job-progress-indeterminate' : '')}
          role="progressbar"
          aria-label={'Progresso do job ' + job.id}
          aria-valuemin={percent !== null ? 0 : undefined}
          aria-valuemax={percent !== null ? 100 : undefined}
          aria-valuenow={percent !== null ? percent : undefined}
          aria-valuetext={percent === null ? label + ', percentual indisponível' : undefined}
        >
          <div className="progress-fill" style={percent !== null ? { width: percent + '%' } : undefined} />
        </div>
      )}
    </div>
  );
}
