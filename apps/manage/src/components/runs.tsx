import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, AlertCircle, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, Cloud, CloudCog, Code2, Copy, ExternalLink, GitBranch, History, LoaderCircle, Logs, Menu, Play, RefreshCcw, RotateCcw, Save, Search, Server, Settings2, Shield, Terminal, Workflow, X } from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select, Textarea } from '../components/ui';
import { api, send } from '../lib/client';
import { sentryIssueSearch } from '../lib/sentry';
import { findDuplicateConfigKeys, planConfigChange } from '../config-reconcile';
import type { ConfigPlan } from '../config-reconcile';
import { cn, date, human, state } from '../lib/utils';
import type { Meta, Run, WF, Job, CloudLog, CfLog, Issue } from '../types';
import { External, Spinner, Empty, IssueBanner } from './shared';
import { ConfirmDialog } from './confirm-dialog';
import { JsonView } from './json-view';
export function RunRow({ run, onSelect }: { run: Run; onSelect: (id: number) => void }) {
  const status = run.conclusion || run.status;
  return (
    <button
      onClick={() => onSelect(run.id)}
      className="flex w-full items-center gap-3 border-b border-[#282a2e] px-4 py-3.5 text-left transition-colors last:border-0 hover:bg-white/[.035]"
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          state(status) === 'success'
            ? 'bg-emerald-500/10 text-emerald-300'
            : state(status) === 'danger'
              ? 'bg-red-500/10 text-red-300'
              : 'bg-white/5 text-slate-300',
        )}
      >
        {state(status) === 'success' ? (
          <Check size={17} />
        ) : state(status) === 'danger' ? (
          <AlertCircle size={17} />
        ) : (
          <Workflow size={17} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{run.name}</p>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          #{run.run_number} · {date(run.created_at)} · {run.event || 'manual'}
        </p>
      </div>
      <Badge tone={state(status)}>{human(status)}</Badge>
      <ChevronRight size={15} className="shrink-0 text-slate-600" />
    </button>
  );
}
export function RunDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ['run-jobs', id],
    queryFn: () => api<{ items: Job[] }>('/runs/' + id + '/jobs'),
  });
  const [job, setJob] = useState<number | null>(null);
  const logs = useQuery({
    queryKey: ['run-job-logs', id, job],
    queryFn: () => api<{ text: string; truncated: boolean }>('/runs/' + id + '/jobs/' + job + '/logs'),
    enabled: Boolean(job),
    retry: false,
  });
  const retry = useMutation({
    mutationFn: () => send('/runs/' + id + '/rerun-failed', { confirm: 'RETRY ' + id }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['runs'] });
      void q.refetch();
    },
  });
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={15} />
          Voltar
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirm(true)} disabled={retry.isPending}>
          <RotateCcw size={14} />
          Reexecutar falhas
        </Button>
      </div>
      <Section title={'Execução #' + id} detail="Etapas, resultados e logs individuais">
        {q.isPending ? (
          <Spinner />
        ) : q.error ? (
          <IssueBanner error={q.error} />
        ) : (
          <Card className="overflow-hidden">
            {q.data?.items.map((item) => (
              <div key={item.id} className="border-b border-[#292b2f] p-3.5 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <Badge tone={state(item.conclusion || item.status)}>
                    {human(item.conclusion || item.status)}
                  </Badge>
                </div>
                <div className="mt-2 flex gap-4">
                  <External href={item.html_url}>GitHub</External>
                  <button
                    className="text-xs text-slate-300 underline underline-offset-2"
                    onClick={() => setJob(job === item.id ? null : item.id)}
                  >
                    {job === item.id ? 'Fechar logs' : 'Ver logs'}
                  </button>
                </div>
                {item.steps?.length > 0 && (
                  <div className="mt-3 space-y-1 border-l border-[#333] pl-3">
                    {item.steps.map((step) => (
                      <div
                        key={step.number}
                        className="flex items-center justify-between gap-2 text-xs text-slate-500"
                      >
                        <span className="truncate">{step.name}</span>
                        <span
                          className={state(step.conclusion) === 'danger' ? 'text-red-400' : 'text-slate-600'}
                        >
                          {human(step.conclusion || step.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {job === item.id && (
                  <div className="mt-3">
                    {logs.isPending ? (
                      <Spinner />
                    ) : logs.error ? (
                      <IssueBanner error={logs.error} />
                    ) : (
                      <JsonView data={logs.data?.text || 'Nenhum log disponível'} title="Logs do job"
                        defaultExpandDepth={1} maxHeight={430} />
                    )}
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}
      </Section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Reexecutar jobs com falha?"
        description="Isso inicia novamente as etapas com falha da execução selecionada."
        label="Reexecutar falhas"
        busy={retry.isPending}
        onConfirm={() => retry.mutate()}
      />
      {retry.error && <IssueBanner error={retry.error} />}
    </div>
  );
}
