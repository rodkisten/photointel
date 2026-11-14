import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input } from '../components/ui';
import { IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';

type Schedule = { name: string; state: string; schedule: string; lastAttemptTime: string; status: number | null };
type Job = { name: string; updateTime: string; latestCreatedExecution?: string };
const shortName = (name: string) => name.split('/').pop() || name;

export function OperationsPage() {
  const client = useQueryClient();
  const schedules = useQuery({ queryKey: ['gcp-scheduler'], queryFn: () => api<{ items: Schedule[] }>('/gcp/scheduler'), retry: false });
  const workers = useQuery({
    queryKey: ['operations-cloudflare-workers'],
    queryFn: () => api<{ workers: Array<{ name: string; modified_on?: string }> }>('/overview'),
    retry: false,
  });
  const jobs = useQuery({ queryKey: ['gcp-jobs'], queryFn: () => api<{ items: Job[] }>('/gcp/jobs'), retry: false });
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const executions = useQuery({
    queryKey: ['gcp-executions', selectedJob],
    queryFn: () => api<{ items: Array<{ name: string; completionTime?: string; runningCount?: number; succeededCount?: number; failedCount?: number }> }>('/gcp/executions?job=' + encodeURIComponent(selectedJob || '')),
    enabled: Boolean(selectedJob), retry: false,
  });
  const cancel = useMutation({
    mutationFn: (execution: string) => send('/gcp/executions/cancel', { job: selectedJob, execution, confirm: execution }),
    onSuccess: async () => { setCancelTarget(null); await client.invalidateQueries({ queryKey: ['gcp-executions', selectedJob] }); },
  });
  const [edit, setEdit] = useState<{ name: string; schedule: string } | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; action: 'pause' | 'resume' } | null>(null);
  const control = useMutation({
    mutationFn: (item: { name: string; action: 'pause' | 'resume' }) => send('/gcp/scheduler/control', { ...item, confirm: item.name }),
    onSuccess: async () => { setConfirm(null); await client.invalidateQueries({ queryKey: ['gcp-scheduler'] }); },
  });
  const save = useMutation({
    mutationFn: (item: { name: string; schedule: string }) => send('/gcp/scheduler/schedule', { ...item, confirm: item.name }),
    onSuccess: async () => { setEdit(null); await client.invalidateQueries({ queryKey: ['gcp-scheduler'] }); },
  });
  return <div className="space-y-5">
    <Card className="space-y-2 p-4">
      <h2 className="font-semibold text-carbon-100">Agendamentos</h2>
      <p className="text-xs text-carbon-400">Pause a origem das execuções para economizar. Um cron pausado continua pausado após a edição. Horários em UTC.</p>
      {schedules.isPending && <Spinner />}
      {schedules.error && <IssueBanner error={schedules.error} />}
      {schedules.data?.items.length === 0 && <p className="text-sm text-carbon-400">Nenhum agendamento encontrado.</p>}
      {schedules.data?.items.map(item => {
        const name = shortName(item.name);
        return <div key={item.name} className="space-y-2 border-t border-carbon-800 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0"><p className="break-all text-sm font-medium text-carbon-100">{name}</p>
              <p className="text-xs text-carbon-400">{item.state} · {item.schedule || 'Sem cron'}</p></div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEdit({ name, schedule: item.schedule })}>Cron</Button>
              {(item.state === 'ENABLED' || item.state === 'PAUSED') && <Button size="sm" variant="outline"
                onClick={() => setConfirm({ name, action: item.state === 'ENABLED' ? 'pause' : 'resume' })}>
                {item.state === 'ENABLED' ? 'Pausar' : 'Retomar'}
              </Button>}
            </div>
          </div>
          {edit?.name === name && <div className="space-y-2 rounded-lg bg-carbon-900 p-3">
            <label className="block text-xs text-carbon-300" htmlFor="operations-cron">Cron (5 campos, UTC)</label>
            <Input id="operations-cron" value={edit.schedule} onChange={event => setEdit({ ...edit, schedule: event.target.value })} />
            <div className="flex gap-2"><Button size="sm" disabled={save.isPending} onClick={() => save.mutate(edit)}>Salvar</Button>
              <Button size="sm" variant="outline" onClick={() => setEdit(null)}>Cancelar</Button></div>
          </div>}
          {confirm?.name === name && <div className="space-y-2 rounded-lg border border-carbon-700 p-3">
            <p className="text-xs">Confirmar {confirm.action === 'pause' ? 'pausa' : 'retomada'} de {name}? Isso não cancela execuções já iniciadas.</p>
            <div className="flex gap-2"><Button size="sm" disabled={control.isPending} onClick={() => control.mutate(confirm)}>Confirmar</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirm(null)}>Cancelar</Button></div>
          </div>}
        </div>;
      })}
      {control.error && <IssueBanner error={control.error} />}
      {save.error && <IssueBanner error={save.error} />}
    </Card>
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-carbon-100">Cloudflare Workers</h2>
      <p className="text-xs text-carbon-400">Inventário dos Workers implantados. Deploy não significa execução contínua. Interromper requisições exige uma política de bloqueio, não simplesmente excluir o Worker.</p>
      {workers.isPending && <Spinner />}
      {workers.error && <IssueBanner error={workers.error} />}
      {workers.data?.workers.length === 0 && <p className="text-xs text-carbon-400">Nenhum Worker encontrado.</p>}
      {workers.data?.workers.map(worker => <div key={worker.name} className="flex items-center justify-between gap-2 border-t border-carbon-800 py-2">
        <p className="min-w-0 break-all text-sm text-carbon-200">{worker.name}</p>
        <span className="shrink-0 text-xs text-carbon-500">Implantado</span>
      </div>)}
    </Card>
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-carbon-100">Cloud Run Jobs</h2>
      <p className="text-xs text-carbon-400">Jobs são executados sob demanda; pausar o Scheduler impede novas chamadas agendadas, mas não interrompe tarefas em andamento.</p>
      {jobs.isPending && <Spinner />}
      {jobs.error && <IssueBanner error={jobs.error} />}
      {jobs.data?.items.map(job => <div key={job.name} className="border-t border-carbon-800 py-2">
        <p className="break-all text-sm text-carbon-200">{shortName(job.name)}</p>
        <p className="text-xs text-carbon-500">Última atualização: {job.updateTime ? new Date(job.updateTime).toLocaleString('pt-BR') : 'Indisponível'}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => setSelectedJob(selectedJob === shortName(job.name) ? null : shortName(job.name))}>
          {selectedJob === shortName(job.name) ? 'Ocultar execuções' : 'Ver execuções'}
        </Button>
        {selectedJob === shortName(job.name) && <div className="mt-2 space-y-2 rounded-lg bg-carbon-900 p-2">
          {executions.isPending && <Spinner />}
          {executions.error && <IssueBanner error={executions.error} />}
          {executions.data?.items.length === 0 && <p className="text-xs text-carbon-400">Sem execuções recentes.</p>}
          {executions.data?.items.map(execution => {
            const name = shortName(execution.name);
            const running = !execution.completionTime && (execution.runningCount || 0) > 0;
            return <div key={execution.name} className="space-y-2 border-b border-carbon-800 p-2">
              <p className="break-all text-xs text-carbon-200">{name}</p>
              <p className="text-xs text-carbon-400">{running ? 'Em execução' : execution.completionTime ? 'Concluída' : 'Estado pendente'}</p>
              {running && <Button size="sm" variant="destructive" onClick={() => setCancelTarget(name)}>Interromper</Button>}
              {cancelTarget === name && <div className="space-y-2">
                <p className="text-xs text-carbon-300">Interromper {name}? A operação não pode ser desfeita.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate(name)}>Confirmar interrupção</Button>
                  <Button size="sm" variant="outline" onClick={() => setCancelTarget(null)}>Voltar</Button>
                </div>
              </div>}
            </div>;
          })}
          {cancel.error && <IssueBanner error={cancel.error} />}
        </div>}
      </div>)}
    </Card>
  </div>;
}
