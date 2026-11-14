import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, Input } from '../components/ui';
import { JsonView } from '../components/json-view';
import { IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';

type Job = { name: string; updateTime?: string; latestCreatedExecution?: string };
type Entry = { timestamp?: string; severity?: string; textPayload?: string; jsonPayload?: unknown; insertId?: string };
const short = (name: string) => name.split('/').pop() || name;
const fieldClass = 'w-full rounded-lg border border-carbon-700 bg-carbon-950 p-2 text-sm text-carbon-100';
export function CloudRunJobsPage() {
  const jobs = useQuery({ queryKey: ['cloud-run-jobs'], queryFn: () => api<{ items: Job[] }>('/cloud-run-jobs'), retry: false });
  const [selected, setSelected] = useState('');
  const [envRows, setEnvRows] = useState([{ name: '', value: '' }]);
  const [args, setArgs] = useState('');
  const [taskCount, setTaskCount] = useState(1);
  const [timeout, setTimeoutValue] = useState(300);
  const [confirm, setConfirm] = useState('');
  const [execution, setExecution] = useState('');
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const name = short(selected);
  const run = useMutation({
    mutationFn: () => send<{ operation: { name?: string } }>('/cloud-run-jobs/' + encodeURIComponent(name) + '/run', {
      confirm, overrides: { env: envRows.filter(row => row.name.trim()), args: args.split('\n').filter(Boolean), taskCount, timeout: timeout + 's' },
    }),
    onSuccess: data => { setExecution(data.operation?.name || ''); setConfirm(''); },
  });
  const executions = useQuery({
    queryKey: ['cloud-run-executions', name],
    queryFn: () => api<{ executions?: Array<{ name: string; completionTime?: string; runningCount?: number }> }>('/cloud-run-jobs/' + name + '/executions'),
    enabled: Boolean(name), refetchInterval: autoRefresh ? 6000 : false,
  });
  const [logExecution, setLogExecution] = useState('');
  const activeExecution = logExecution || executions.data?.executions?.[0]?.name?.split('/').pop() || '';
  const logs = useQuery({
    queryKey: ['cloud-run-job-logs', name, activeExecution],
    queryFn: () => api<{ entries: Entry[] }>('/cloud-run-jobs/' + name + '/executions/' + activeExecution + '/logs'),
    enabled: Boolean(name && activeExecution), refetchInterval: autoRefresh ? 3000 : false,
  });
  const visible = (logs.data?.entries || []).filter(entry => JSON.stringify(entry).toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-5">
    <Card className="space-y-4 p-4">
      <h2 className="text-base font-semibold text-carbon-100">Disparar Cloud Run Job</h2>
      <p className="text-xs text-carbon-400">Overrides valem apenas para esta execução. Não alteram o job implantado. Uma execução pode gerar custos no GCP.</p>
      {jobs.isPending && <Spinner />}{jobs.error && <IssueBanner error={jobs.error} />}
      <label className="block space-y-1 text-xs text-carbon-300">Job
        <select className={fieldClass} value={selected} onChange={event => { setSelected(event.target.value); setLogExecution(''); setExecution(''); }}>
          <option value="">Selecione um job</option>
          {jobs.data?.items.map(job => <option key={job.name} value={job.name}>{short(job.name)}</option>)}
        </select>
      </label>
      {selected && <>
        <div className="space-y-2"><p className="text-xs font-medium text-carbon-300">Variáveis de ambiente</p>
          {envRows.map((row, index) => <div className="flex gap-2" key={index}>
            <Input aria-label={'Nome da variável ' + (index + 1)} placeholder="NOME" value={row.name} onChange={event => setEnvRows(rows => rows.map((r, i) => i === index ? { ...r, name: event.target.value } : r))} />
            <Input aria-label={'Valor da variável ' + (index + 1)} placeholder="Valor" value={row.value} onChange={event => setEnvRows(rows => rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r))} />
            <Button variant="outline" size="sm" onClick={() => setEnvRows(rows => rows.filter((_, i) => i !== index))}>×</Button>
          </div>)}
          <Button size="sm" variant="outline" onClick={() => setEnvRows(rows => [...rows, { name: '', value: '' }])}>+ Variável</Button>
        </div>
        <label className="block space-y-1 text-xs text-carbon-300">Argumentos (um por linha)
          <textarea className={fieldClass} rows={3} value={args} onChange={event => setArgs(event.target.value)} placeholder="--mode=validate" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-carbon-300">Tasks (1 a 10)<Input type="number" min={1} max={10} value={taskCount} onChange={event => setTaskCount(Number(event.target.value))} /></label>
          <label className="space-y-1 text-xs text-carbon-300">Timeout (segundos)<Input type="number" min={1} max={3600} value={timeout} onChange={event => setTimeoutValue(Number(event.target.value))} /></label>
        </div>
        <label className="block space-y-1 text-xs text-amber-300">Confirme digitando {name}
          <Input value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="off" />
        </label>
        <Button disabled={run.isPending || confirm !== name} onClick={() => run.mutate()}>{run.isPending ? 'Disparando…' : 'Executar job'}</Button>
        {run.error && <IssueBanner error={run.error} />}
        {execution && <p role="status" className="break-all text-xs text-emerald-300">Solicitação enviada: {execution}</p>}
      </>}
    </Card>
    {selected && <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-carbon-100">Execuções e logs</h2>
        <label className="flex items-center gap-2 text-xs text-carbon-400"><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} /> Atualizar automaticamente</label></div>
      {executions.error && <IssueBanner error={executions.error} />}
      <select className={fieldClass} value={logExecution} onChange={event => setLogExecution(event.target.value)} aria-label="Execução para visualizar logs">
        <option value="">Mais recente</option>
        {executions.data?.executions?.map(item => <option key={item.name} value={short(item.name)}>{short(item.name)} {item.completionTime ? '✓' : '●'}</option>)}
      </select>
      <Input placeholder="Buscar nos logs" aria-label="Buscar nos logs" value={search} onChange={event => setSearch(event.target.value)} />
      {logs.isFetching && <p className="text-xs text-carbon-500">Sincronizando logs…</p>}
      {logs.error && <IssueBanner error={logs.error} />}
      <div aria-live="polite" className="max-h-[65dvh] space-y-2 overflow-auto rounded-lg bg-carbon-950 p-2 font-mono text-xs">
        {visible.map((entry, index) => <div key={entry.insertId || index} className="border-b border-carbon-800 pb-2">
          <p className="text-carbon-500">{entry.timestamp || ''} <span className={entry.severity === 'ERROR' ? 'text-red-400' : 'text-sky-300'}>{entry.severity || 'INFO'}</span></p>
          <JsonView data={entry.jsonPayload ?? entry.textPayload ?? ''} search={search} showSearch={false} maxHeight={360} title="Log da execução" />
        </div>)}
        {!logs.isFetching && !visible.length && <p className="text-carbon-500">Nenhum log disponível para esta execução.</p>}
      </div>
    </Card>}
  </div>;
}
