import { AlertTriangle, Pause, Play, Square, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useAction, useApi } from '../api/client';
import { useUi } from '../lib/store';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export interface QueueState {
  paused: boolean;
  open: number;
  waiting: number;
  running: number;
  paused_jobs: number;
  terminal: number;
  by_status: Record<string, number>;
  batch_progress: {
    total: number;
    finished: number;
    completed: number;
    failed: number;
    skipped: number;
    percent: number | null;
  };
  count_scope: 'all_jobs';
}

function count(value: number): string {
  return new Intl.NumberFormat('pt-BR').format(value);
}

/** The backend counts the whole durable queue, not the 24 shown in the drawer. */
export function QueueControls({ compact = false }: { compact?: boolean }) {
  const queue = useApi<QueueState>('/v1/jobs/control', 6_000);
  const action = useAction<QueueState & { changed: number }>();
  const notify = useUi((state) => state.notify);
  const [confirm, setConfirm] = useState(false);
  const data = queue.data;
  const progress = data?.batch_progress;
  const hasMeasuredProgress = !!progress && progress.total > 0 && progress.percent !== null;

  async function command(operation: 'pause' | 'resume' | 'cancel') {
    try {
      const result = await action.mutateAsync({ url: '/v1/jobs/control/' + operation });
      setConfirm(false);
      notify(
        operation === 'cancel'
          ? count(result.changed) + ' jobs cancelados; a fila permanece pausada.'
          : operation === 'pause'
            ? count(result.changed) + ' jobs pausados.'
            : count(result.changed) + ' jobs retomados.',
      );
      void queue.refetch();
    } catch {
      // The mutation displays the API error in the standard diagnostic toast.
    }
  }

  return (
    <div className={'queue-controls ' + (compact ? 'queue-controls-compact' : '')}>
      <div className="queue-controls-summary">
        <div className="queue-controls-title">
          <strong>
            {data?.paused ? 'Fila pausada' : data?.running ? 'Fila em processamento' : 'Controle da fila'}
          </strong>
          <span className="muted">
            {data
              ? count(data.open) + ' jobs no total da fila'
              : queue.isPending
                ? 'Consultando fila…'
                : 'Contagem indisponível'}
          </span>
        </div>
        {data && (
          <div className="queue-controls-counts" aria-live="polite">
            <span>{count(data.running)} executando</span>
            <span>{count(data.waiting)} aguardando</span>
            <span>{count(data.paused_jobs)} pausados</span>
          </div>
        )}
        {data && (
          <div className="queue-controls-progress">
            {hasMeasuredProgress ? (
              <>
                <div className="queue-controls-progress-label">
                  <span>Progresso persistido dos lotes ativos</span>
                  <strong>
                    {count(progress.finished)}/{count(progress.total)} · {progress.percent}%
                  </strong>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Progresso dos lotes"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.finished}
                >
                  <div className="progress-fill" style={{ width: progress.percent + '%' }} />
                </div>
              </>
            ) : (
              <div className="queue-controls-progress-label">
                <span>Progresso global</span>
                <span>
                  {data.running
                    ? 'Executando, sem total de etapas informado'
                    : data.waiting
                      ? 'Aguardando workers'
                      : data.paused_jobs
                        ? 'Interrompido'
                        : 'Sem jobs pendentes'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="queue-controls-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!data || action.isPending}
          onClick={() => void command(data?.paused ? 'resume' : 'pause')}
          title={data?.paused ? 'Retomar os jobs pausados' : 'Pausar os jobs e impedir novos claims'}
        >
          {data?.paused ? <Play size={15} /> : <Pause size={15} />}
          {data?.paused ? 'Retomar tudo' : 'Pausar tudo'}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={!data || action.isPending || data.open === 0}
          onClick={() => setConfirm(true)}
        >
          <Square size={14} />
          Cancelar todos
        </Button>
        {!compact && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Atualizar estado da fila"
            onClick={() => void queue.refetch()}
            disabled={queue.isFetching}
          >
            <RefreshCw size={15} className={queue.isFetching ? 'animate-spin' : ''} />
          </Button>
        )}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancelar todos os jobs pendentes?"
        description="Cancela jobs aguardando, pausados e em execução. Os workers perdem autorização para gravar e a fila permanece pausada. Fotos e resultados já concluídos são preservados."
      >
        <div className="stack">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle size={18} className="shrink-0" />
            {count(data?.open ?? 0)} jobs serão cancelados. Isso afeta toda a fila persistida, não apenas os
            24 itens exibidos no drawer.
          </p>
          <div className="form-actions">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Voltar
            </Button>
            <Button variant="destructive" disabled={action.isPending} onClick={() => void command('cancel')}>
              <Square size={15} /> {action.isPending ? 'Cancelando…' : 'Confirmar cancelamento'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
