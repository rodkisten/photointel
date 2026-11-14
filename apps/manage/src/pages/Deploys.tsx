import { WorkflowMessageEditor } from '../components/workflow-message-editor';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  CloudCog,
  Code2,
  Copy,
  ExternalLink,
  GitBranch,
  History,
  LoaderCircle,
  Logs,
  Menu,
  Play,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  Shield,
  Terminal,
  Workflow,
  X,
} from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select, Textarea } from '../components/ui';
import { api, send } from '../lib/client';
import { sentryIssueSearch } from '../lib/sentry';
import { findDuplicateConfigKeys, planConfigChange } from '../config-reconcile';
import type { ConfigPlan } from '../config-reconcile';
import { cn, date, human, state } from '../lib/utils';
import type { Meta, Run, WF, Job, CloudLog, CfLog, Issue } from '../types';
import { External, Spinner, Empty, IssueBanner } from '../components/shared';
import { RunRow, RunDetail } from '../components/runs';
import type { RunCostsResponse } from '../components/run-cost';
import type { CostSource } from './Costs';
import { money } from './Costs';
import { ConfirmDialog } from '../components/confirm-dialog';
import { CloudflareDeployPanel } from '../CloudflareDeployPanel';
export function Deploys() {
  const qc = useQueryClient();
  const lastFailure = useQuery({
    queryKey: ['workflow-last-failure'],
    queryFn: () => api<{ item: { id: number; name: string; run_number: number; created_at: string; html_url: string; jobs: { id: number; name: string; steps: { name: string; number: number }[] }[] } | null }>('/workflows/last-failure'),
    refetchInterval: 60_000,
    retry: false,
  });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<{ items: WF[] }>('/workflows') });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => api<{ items: Run[] }>('/runs'),
    refetchInterval: 20_000,
  });
  const ids = runs.data?.items.slice(0, 40).map((run) => run.id) || [];
  const estimates = useQuery({
    queryKey: ['run-costs', ids.join(',')],
    queryFn: () => api<RunCostsResponse>('/costs/runs?ids=' + ids.join(',')),
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const quota = useQuery({
    queryKey: ['github-billing-quota'],
    queryFn: () => api<{ source: CostSource }>('/costs/github'),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [selected, setSelected] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [workflowDialog, setWorkflowDialog] = useState(false);
  const [workflowSearch, setWorkflowSearch] = useState('');
  const [manualInputs, setManualInputs] = useState('{}');
  const [manualInputError, setManualInputError] = useState('');
  const mutation = useMutation({
    mutationFn: () => {
      const parsed: unknown = active && !Object.keys(active.inputs).length ? JSON.parse(manualInputs) : inputs;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string'))
        throw new Error('Os parâmetros devem ser um objeto JSON com valores de texto.');
      return send('/dispatch', { workflow: selected, inputs: parsed, confirm: 'DEPLOY ' + selected });
    },
    onSuccess: () => {
      setConfirm(false);
      setWorkflowDialog(false);
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const active = workflows.data?.items.find((w) => w.file === selected);
  const filteredWorkflows = (workflows.data?.items || []).filter(w => (w.name + ' ' + w.file).toLowerCase().includes(workflowSearch.toLowerCase()));
  useEffect(() => {
    if (!selected && workflows.data?.items.length) setSelected(workflows.data.items[0].file);
  }, [selected, workflows.data]);
  function changeFile(value: string) {
    setSelected(value);
    setManualInputs('{}');
    setManualInputError('');
    const fields = workflows.data?.items.find((x) => x.file === value)?.inputs || {};
    setInputs(
      Object.fromEntries(
        Object.entries(fields)
          .filter(([, v]) => v.length)
          .map(([k, v]) => [k, v[0]]),
      ),
    );
  }
  return (
    <div className="space-y-6">
      <CloudflareDeployPanel />
      <WorkflowMessageEditor />
      <Section title="Última falha do GitHub Actions" detail="Diagnóstico baseado nos jobs e etapas com falha">
        <Card className="space-y-3 p-4">
          {lastFailure.isPending ? <Spinner /> : lastFailure.error ? <IssueBanner error={lastFailure.error} /> : !lastFailure.data?.item ? (
            <p className="text-sm text-carbon-400">Nenhuma execução com falha encontrada.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-red-300">{lastFailure.data.item.name} #{lastFailure.data.item.run_number}</p>
                  <p className="text-xs text-carbon-400">{date(lastFailure.data.item.created_at)}</p>
                </div>
                <Link to="/deploys/$runId" params={{ runId: String(lastFailure.data.item.id) }} className="text-sm text-carbon-200 underline">Ver logs e reexecutar</Link>
              </div>
              {lastFailure.data.item.jobs.map(job => (
                <div key={job.id} className="rounded-lg border border-carbon-800 p-3 text-sm">
                  <p className="font-medium text-red-300">{job.name}</p>
                  {job.steps.map(step => <p key={step.number} className="mt-1 text-xs text-carbon-300">Etapa com falha: {step.name}</p>)}
                </div>
              ))}
            </>
          )}
        </Card>
      </Section>
      <Section title="Workflows · execução manual" detail="Todos os workflows ativos. Selecione um para configurar e executar.">
        <Card className="space-y-3 p-3 sm:p-4">
          <Input aria-label="Buscar workflow" placeholder="Buscar por nome ou arquivo…" value={workflowSearch}
            onChange={event => setWorkflowSearch(event.target.value)} />
          {workflows.isPending && <Spinner />}
          {workflows.error && <IssueBanner error={workflows.error} />}
          <div className="max-h-[60dvh] space-y-1 overflow-y-auto">
            {filteredWorkflows.map(w => <button type="button" key={w.file}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-carbon-800 px-3 py-3 text-left hover:bg-carbon-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-carbon-400"
              onClick={() => { changeFile(w.file); setWorkflowDialog(true); }}>
              <span className="min-w-0"><span className="block truncate text-sm font-medium text-carbon-100">{w.name}</span>
                <span className="block truncate text-[11px] text-carbon-500">{w.file}</span></span>
              <Play size={16} className="shrink-0 text-carbon-300" />
            </button>)}
            {!workflows.isPending && !filteredWorkflows.length && <p className="p-3 text-xs text-carbon-400">Nenhum workflow encontrado.</p>}
          </div>
          {mutation.isSuccess && <p className="text-xs text-emerald-300">Workflow solicitado. Acompanhe no histórico.</p>}
        </Card>
      </Section>
      <Dialog.Root open={workflowDialog} onOpenChange={open => { if (!mutation.isPending) setWorkflowDialog(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm" />
          <Dialog.Content className="fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-[81] max-h-[85dvh] overflow-y-auto rounded-2xl border border-carbon-700 bg-carbon-950 p-4 shadow-2xl sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <Dialog.Title className="text-base font-semibold text-carbon-100">{active?.name || 'Executar workflow'}</Dialog.Title>
                <Dialog.Description className="break-all text-xs text-carbon-400">{selected} · branch main</Dialog.Description>
              </div>
              <Dialog.Close asChild><Button size="icon" variant="ghost" aria-label="Fechar"><X size={18} /></Button></Dialog.Close>
            </div>
            <div className="space-y-3">
              {active && !Object.keys(active.inputs).length && <label className="block space-y-2 text-xs text-carbon-300">
                <span>Parâmetros workflow_dispatch · JSON (opcional)</span>
                <Textarea rows={4} value={manualInputs} onChange={event => {
                  setManualInputs(event.target.value);
                  try { const parsed: unknown = JSON.parse(event.target.value);
                    setManualInputError(!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string') ? 'Use um objeto JSON com valores de texto.' : '');
                  } catch { setManualInputError('JSON inválido'); }
                }} />
                <span className="text-carbon-500">Use as chaves definidas em workflow_dispatch.inputs. Deixe {} se não houver parâmetros.</span>
                {manualInputError && <span role="alert" className="text-red-300">{manualInputError}</span>}
              </label>}
              {active && Object.entries(active.inputs).map(([key, values]) => <label key={key} className="block space-y-1 text-xs text-carbon-300">
                <span>{key.replaceAll('_', ' ')}</span>
                {values.length ? <Select value={inputs[key] ?? values[0]} onChange={event => setInputs(current => ({ ...current, [key]: event.target.value }))}>
                  {values.map(value => <option key={value} value={value}>{value}</option>)}
                </Select> : <Input placeholder="Opcional" value={inputs[key] || ''} onChange={event => setInputs(current => ({ ...current, [key]: event.target.value }))} />}
              </label>)}
              <p className="text-xs text-amber-300">⚠️ A execução pode modificar infraestrutura e gerar custos. Confirme antes de iniciar.</p>
              {mutation.error && <IssueBanner error={mutation.error} />}
              <div className="flex justify-end gap-2 border-t border-carbon-800 pt-3">
                <Button size="sm" variant="ghost" onClick={() => setWorkflowDialog(false)}>Cancelar</Button>
                <Button size="sm" disabled={!selected || mutation.isPending || !!manualInputError} onClick={() => setConfirm(true)}>
                  <Play size={15} />{mutation.isPending ? 'Enviando…' : 'Executar'}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-carbon-200">Cota do GitHub Actions</p>
          <p className="mt-1 text-xs text-carbon-400">
            {quota.data?.source?.quota
              ? money(quota.data.source.quota.used_usd) + ' consumidos (brutos) · ' +
                (quota.data.source.quota.included_usd === null
                  ? 'cota não configurada' : money(quota.data.source.quota.included_usd) + ' de crédito')
              : quota.isPending ? 'Consultando faturamento...' : 'Faturamento indisponível: verifique a permissão Billing.'}
          </p>
        </div>
        <Link to="/costs" className="text-xs text-carbon-200 underline underline-offset-4">Ver painel de custos</Link>
      </Card>
      <Section
        title="Histórico"
        detail="Abra uma execução para inspecionar steps e logs"
        action={
          <Button variant="ghost" size="sm" onClick={() => void runs.refetch()}>
            <RefreshCcw size={15} />
          </Button>
        }
      >
        {runs.isPending ? (
          <Spinner />
        ) : runs.error ? (
          <IssueBanner error={runs.error} />
        ) : (
          <Card className="overflow-hidden">
            {runs.data?.items.slice(0, 40).map((r) => (
              <RunRow key={r.id} run={r} estimate={estimates.data?.items[String(r.id)]} />
            ))}
          </Card>
        )}
      </Section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={'Executar ' + (active?.name || selected) + '?'}
        description={
          'Isso inicia uma ação real no repositório ' +
          (active?.file || '') +
          '. Verifique os inputs e possíveis custos de nuvem.'
        }
        label="Disparar"
        busy={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      />
    </div>
  );
}
