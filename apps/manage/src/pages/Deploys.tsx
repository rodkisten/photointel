import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { ConfirmDialog } from '../components/confirm-dialog';
export function Deploys({ openRun }: { openRun: (n: number) => void }) {
  const qc = useQueryClient();
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api<{ items: WF[] }>('/workflows') });
  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => api<{ items: Run[] }>('/runs'),
    refetchInterval: 20_000,
  });
  const [selected, setSelected] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation({
    mutationFn: () => send('/dispatch', { workflow: selected, inputs, confirm: 'DEPLOY ' + selected }),
    onSuccess: () => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const active = workflows.data?.items.find((w) => w.file === selected);
  useEffect(() => {
    if (!selected && workflows.data?.items.length) setSelected(workflows.data.items[0].file);
  }, [selected, workflows.data]);
  function changeFile(value: string) {
    setSelected(value);
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
      <Section title="Disparar workflow" detail="Todas as execuções são criadas na branch main">
        <Card className="space-y-4 p-4 sm:p-5">
          {workflows.error && <IssueBanner error={workflows.error} />}
          <div>
            <label className="field-label" htmlFor="workflow">
              Workflow
            </label>
            <Select id="workflow" value={selected} onChange={(e) => changeFile(e.target.value)}>
              {workflows.data?.items.map((w) => (
                <option key={w.file} value={w.file}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
          {active &&
            Object.entries(active.inputs).map(([key, values]) => (
              <div key={key}>
                <label className="field-label" htmlFor={'input-' + key}>
                  {key.replaceAll('_', ' ')}
                </label>
                {values.length ? (
                  <Select
                    id={'input-' + key}
                    value={inputs[key] ?? values[0]}
                    onChange={(e) => setInputs((s) => ({ ...s, [key]: e.target.value }))}
                  >
                    {values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={'input-' + key}
                    placeholder="Opcional"
                    value={inputs[key] || ''}
                    onChange={(e) => setInputs((s) => ({ ...s, [key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          <div className="flex items-center justify-between gap-3 border-t border-[#2d2f33] pt-4">
            <span className="text-xs text-slate-500">Uma confirmação é necessária antes de executar.</span>
            <Button disabled={!selected || mutation.isPending} onClick={() => setConfirm(true)}>
              <Play size={15} />
              Executar
            </Button>
          </div>
          {mutation.isSuccess && (
            <div className="rounded-lg bg-emerald-950/40 p-3 text-sm text-emerald-300">
              Workflow solicitado com sucesso. Consulte a lista de execuções.
            </div>
          )}
          {mutation.error && <IssueBanner error={mutation.error} />}
        </Card>
      </Section>
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
              <RunRow key={r.id} run={r} onSelect={openRun} />
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
