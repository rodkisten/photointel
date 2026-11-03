import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Check, ChevronRight, RotateCcw, Workflow } from 'lucide-react';

import { Badge, Button, Card, Section } from '../components/ui';
import { api, send } from '../lib/client';
import { cn, date, human, state } from '../lib/utils';
import type { Run, Job } from '../types';

import { External, Spinner, IssueBanner } from './shared';
import { ConfirmDialog } from './confirm-dialog';
import { JsonView } from './json-view';

// ==========================================
// Tipos
// ==========================================

interface RunRowProps {
  run: Run;
  onSelect: (id: number) => void;
}

interface RunDetailProps {
  id: number;
  onBack: () => void;
}

interface JobItemProps {
  runId: number;
  item: Job;
  isActive: boolean;
  onToggleLog: () => void;
}

// ==========================================
// Subcomponentes
// ==========================================

function RunIcon({ status }: { status: string }) {
  const current = state(status);
  if (current === 'success') return <Check size={17} />;
  if (current === 'danger') return <AlertCircle size={17} />;
  return <Workflow size={17} />;
}

function JobSteps({ steps }: { steps: Job['steps'] }) {
  if (!steps?.length) return null;

  return (
    <div className="mt-3 space-y-1.5 border-l-2 border-carbon-800 pl-3">
      {steps.map((step) => {
        const currentTone = state(step.conclusion);
        return (
          <div key={step.number} className="flex items-center justify-between gap-2 text-xs text-carbon-400">
            <span className="truncate">{step.name}</span>
            <span className={currentTone === 'danger' ? 'font-medium text-red-400' : 'text-carbon-500'}>
              {human(step.conclusion || step.status)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function JobItem({ runId, item, isActive, onToggleLog }: JobItemProps) {
  const status = item.conclusion || item.status;

  // A query de logs agora fica encapsulada no próprio Item
  const logsQuery = useQuery({
    queryKey: ['run-job-logs', runId, item.id],
    queryFn: () => api<{ text: string; truncated: boolean }>(`/runs/${runId}/jobs/${item.id}/logs`),
    enabled: isActive,
    retry: false,
  });

  return (
    <div className="border-b border-carbon-800 p-4 transition-colors last:border-0 hover:bg-carbon-900/20">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-carbon-200">{item.name}</span>
        <Badge tone={state(status)}>{human(status)}</Badge>
      </div>

      <div className="mt-2 flex items-center gap-4">
        <External href={item.html_url}>GitHub</External>
        <button
          className="text-xs font-medium text-carbon-400 underline underline-offset-4 transition-colors hover:text-carbon-200"
          onClick={onToggleLog}
        >
          {isActive ? 'Fechar logs' : 'Ver logs'}
        </button>
      </div>

      <JobSteps steps={item.steps} />

      {isActive && (
        <div className="mt-4">
          {logsQuery.isPending ? (
            <Spinner />
          ) : logsQuery.error ? (
            <IssueBanner error={logsQuery.error} />
          ) : (
            <JsonView
              data={logsQuery.data?.text || 'Nenhum log disponível'}
              title="Logs do job"
              defaultExpandDepth={1}
              maxHeight={430}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ==========================================
// Componentes Principais
// ==========================================

export function RunRow({ run, onSelect }: RunRowProps) {
  const status = run.conclusion || run.status;
  const currentTone = state(status);

  return (
    <button
      onClick={() => onSelect(run.id)}
      className="flex w-full items-center gap-3 border-b border-carbon-800 px-4 py-3.5 text-left transition-colors last:border-0 hover:bg-carbon-800/50"
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          currentTone === 'success' && 'bg-emerald-500/10 text-emerald-400',
          currentTone === 'danger' && 'bg-red-500/10 text-red-400',
          currentTone !== 'success' && currentTone !== 'danger' && 'bg-carbon-800 text-carbon-400',
        )}
      >
        <RunIcon status={status} />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-carbon-200">{run.name}</p>
        <p className="mt-0.5 truncate text-xs text-carbon-500">
          #{run.run_number} · {date(run.created_at)} · {run.event || 'manual'}
        </p>
      </div>

      <Badge tone={currentTone}>{human(status)}</Badge>
      <ChevronRight size={15} className="shrink-0 text-carbon-600" />
    </button>
  );
}

export function RunDetail({ id, onBack }: RunDetailProps) {
  const client = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['run-jobs', id],
    queryFn: () => api<{ items: Job[] }>(`/runs/${id}/jobs`),
  });

  const retryMutation = useMutation({
    mutationFn: () => send(`/runs/${id}/rerun-failed`, { confirm: `RETRY ${id}` }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['runs'] });
      void refetch();
      setShowConfirm(false);
    },
  });

  return (
    <div className="space-y-4">
      {/* Header de Ações */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-carbon-400 hover:text-carbon-200">
          <ArrowLeft size={15} className="mr-1.5" />
          Voltar
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowConfirm(true)}
          disabled={retryMutation.isPending}
          className="border-carbon-700 bg-carbon-800 text-carbon-200 hover:bg-carbon-700"
        >
          <RotateCcw size={14} className="mr-1.5" />
          Reexecutar falhas
        </Button>
      </div>

      {/* Conteúdo Principal */}
      <Section title={`Execução #${id}`} detail="Etapas, resultados e logs individuais">
        {isPending ? (
          <Spinner />
        ) : error ? (
          <IssueBanner error={error} />
        ) : (
          <Card className="overflow-hidden border-carbon-800 bg-carbon-950">
            {data?.items.map((item) => (
              <JobItem
                key={item.id}
                runId={id}
                item={item}
                isActive={activeJobId === item.id}
                onToggleLog={() => setActiveJobId((prev) => (prev === item.id ? null : item.id))}
              />
            ))}
          </Card>
        )}
      </Section>

      {/* Modais & Alertas Isolados */}
      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Reexecutar jobs com falha?"
        description="Isso inicia novamente as etapas com falha da execução selecionada."
        label="Reexecutar falhas"
        busy={retryMutation.isPending}
        onConfirm={() => retryMutation.mutate()}
      />

      {retryMutation.error && <IssueBanner error={retryMutation.error} className="mt-4" />}
    </div>
  );
}
