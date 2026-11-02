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
import { Badge, Button, Card, Input, Section, Select, Textarea } from './components/ui';
import { api, send } from './lib/client';
import { planConfigChange } from './config-reconcile';
import type { ConfigPlan } from './config-reconcile';
import { cn, date, human, state } from './lib/utils';
import './style.css';

type Tab = 'overview' | 'deploy' | 'logs' | 'config' | 'settings';
type Meta = {
  email: string;
  repo: string;
  project: string;
  gcp: boolean;
  cloudflare: boolean;
  sentry: boolean;
};
type Run = {
  id: number;
  name: string;
  display_title?: string;
  status: string;
  conclusion?: string;
  created_at: string;
  updated_at?: string;
  html_url: string;
  run_number: number;
  event?: string;
  actor?: string;
  head_sha?: string;
};
type WF = {
  id: number;
  name: string;
  file: string;
  state: string;
  html_url: string;
  inputs: Record<string, string[]>;
};
type Job = {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  html_url: string;
  started_at?: string;
  steps: { name: string; number: number; conclusion: string; status: string }[];
};
type CloudLog = {
  timestamp: string;
  severity: string;
  service: string;
  resource?: string;
  message: string;
  insertId?: string;
};
type CfLog = {
  id: string;
  timestamp: number;
  service: string;
  severity: string;
  message: string;
  outcome: string;
};
type Issue = {
  id: string;
  title: string;
  level: string;
  count: string;
  lastSeen: string;
  permalink: string;
  culprit: string;
  project: string;
};
const NAV: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Visão geral', icon: Activity },
  { id: 'deploy', label: 'Deploys', icon: Workflow },
  { id: 'logs', label: 'Logs', icon: Logs },
  { id: 'config', label: 'Ambiente', icon: Code2 },
  { id: 'settings', label: 'Sistema', icon: Settings2 },
];
const External = ({ href, children }: { href?: string; children: React.ReactNode }) =>
  href && href.startsWith('https://') ? (
    <a
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      className="inline-flex items-center gap-1.5 text-sm text-slate-300 underline-offset-4 hover:text-white hover:underline"
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : null;
function Spinner() {
  return <LoaderCircle size={17} className="animate-spin text-slate-500" />;
}
function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="p-7 text-center">
      <CircleAlert className="mx-auto text-slate-600" size={25} />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {detail && <p className="mt-1.5 text-xs text-slate-500">{detail}</p>}
    </Card>
  );
}
function IssueBanner({ error }: { error: unknown }) {
  const e = error as { message?: string; code?: string };
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-900/50 bg-red-950/25 p-3 text-sm text-red-200"
    >
      <AlertCircle size={17} className="mt-0.5 shrink-0" />
      <div>
        {e.message || 'Serviço temporariamente indisponível'}
        {e.code && <p className="mt-1 text-xs opacity-65">{e.code}</p>}
      </div>
    </div>
  );
}
function RunRow({ run, onSelect }: { run: Run; onSelect: (id: number) => void }) {
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
function RunDetail({ id, onBack }: { id: number; onBack: () => void }) {
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
                      <pre className="logbox max-h-[430px] overflow-auto">
                        {logs.data?.text || 'Nenhum log disponível'}
                      </pre>
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
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  label: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed inset-x-3 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-2xl border border-[#34363b] bg-[#191b1e] p-5 shadow-2xl">
          <div className="flex justify-between gap-2">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-slate-400">
              <X size={20} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm leading-6 text-slate-400">
            {description}
          </Dialog.Description>
          <p className="mt-4 text-xs text-slate-400">
            Digite <strong className="text-white">CONFIRMAR</strong> para continuar.
          </p>
          <Input
            className="mt-2"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            placeholder="CONFIRMAR"
            aria-label="Confirmar operação"
          />
          <div className="mt-5 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              className="flex-1"
              disabled={typed !== 'CONFIRMAR' || busy}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {busy ? <Spinner /> : <Check size={15} />} {label}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function Overview({ openRun }: { openRun: (n: number) => void }) {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () =>
      api<{
        runs: Run[];
        workers: { name: string; modified_on: string }[];
        services: {
          name: string;
          uri: string;
          latestReadyRevision: string;
          condition?: string;
          reconciling?: boolean;
        }[];
        providers: string[];
        checked_at: string;
      }>('/overview'),
    refetchInterval: 30_000,
  });
  if (q.isPending) return <Spinner />;
  if (q.error) return <IssueBanner error={q.error} />;
  const data = q.data!;
  const cards = [
    {
      name: 'GitHub Actions',
      icon: GitBranch,
      ok: data.providers[0] === 'ok',
      sub: data.runs.length + ' execuções recentes',
    },
    {
      name: 'Cloudflare',
      icon: Cloud,
      ok: data.providers[1] === 'ok',
      sub: data.workers.length + ' Workers encontrados',
    },
    {
      name: 'Google Cloud',
      icon: Server,
      ok: data.providers[2] === 'ok',
      sub: data.services.length + ' serviços Cloud Run',
    },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {cards.map(({ name, icon: Icon, ok, sub }, i) => (
          <Card key={name} className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-white/5 p-2.5">
              <Icon size={19} className="text-slate-300" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{name}</p>
                <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-amber-400')} />
              </div>
              <p className="mt-0.5 text-xs text-slate-500">{ok ? sub : data.providers[i]}</p>
            </div>
          </Card>
        ))}
      </div>
      <Section
        title="Execuções recentes"
        detail="Atualização automática a cada 30 segundos"
        action={
          <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
            <RefreshCcw size={15} />
          </Button>
        }
      >
        <Card className="overflow-hidden">
          {data.runs.length ? (
            data.runs.slice(0, 10).map((r) => <RunRow key={r.id} run={r} onSelect={openRun} />)
          ) : (
            <div className="p-5">
              <Empty title="Sem execuções recentes" />
            </div>
          )}
        </Card>
      </Section>
      <div className="grid gap-5 md:grid-cols-2">
        <Section title="Workers Cloudflare">
          <Card className="divide-y divide-[#282a2e]">
            {data.workers.length ? (
              data.workers.slice(0, 12).map((w) => (
                <div key={w.name} className="flex items-center gap-3 px-4 py-3">
                  <Cloud size={15} className="text-slate-500" />
                  <span className="min-w-0 flex-1 truncate text-sm">{w.name}</span>
                  <span className="text-xs text-slate-600">{date(w.modified_on)}</span>
                </div>
              ))
            ) : (
              <div className="p-4 text-sm text-slate-500">Sem dados do Cloudflare</div>
            )}
          </Card>
        </Section>
        <Section title="Serviços Cloud Run">
          <Card className="divide-y divide-[#282a2e]">
            {data.services.length ? (
              data.services.map((s) => (
                <div key={s.name} className="flex items-center gap-3 px-4 py-3">
                  <Server size={15} className="text-slate-500" />
                  <span className="min-w-0 flex-1 truncate text-sm">{s.name.split('/').pop()}</span>
                  <Badge
                    tone={
                      s.latestReadyRevision && s.condition === 'CONDITION_SUCCEEDED' && !s.reconciling
                        ? 'success'
                        : 'warning'
                    }
                  >
                    {s.reconciling
                      ? 'Atualizando'
                      : s.condition === 'CONDITION_SUCCEEDED'
                        ? 'Pronto'
                        : 'Verificar'}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="p-4 text-sm text-slate-500">Federação GCP não configurada ou sem serviços</div>
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}
function Deploys({ openRun }: { openRun: (n: number) => void }) {
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
function LogViewer() {
  const [source, setSource] = useState<'gcp' | 'cloudflare' | 'github' | 'sentry'>('gcp');
  const [minutes, setMinutes] = useState('30');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const q = useQuery({
    queryKey: ['logs', source, minutes, filter],
    queryFn: async () => {
      if (source === 'gcp')
        return api<{ items: CloudLog[]; console_url: string }>(
          '/gcp/logs?minutes=' + minutes + (filter ? '&correlation=' + encodeURIComponent(filter) : ''),
        );
      if (source === 'cloudflare')
        return api<{ items: CfLog[] }>(
          '/cloudflare/logs?minutes=' + minutes + '&search=' + encodeURIComponent(filter),
        );
      if (source === 'github') return api<{ items: Run[] }>('/runs');
      return api<{ items: Issue[] }>('/sentry/issues');
    },
    refetchInterval: source === 'sentry' ? 60000 : 20000,
    retry: false,
  });
  const data = q.data as any;
  const tabs = [
    ['gcp', 'GCP'],
    ['cloudflare', 'Cloudflare'],
    ['github', 'Actions'],
    ['sentry', 'Sentry'],
  ] as const;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-[#292b2f] bg-[#151618] p-1">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setSource(id);
              setFilter('');
              setSearch('');
            }}
            className={cn(
              'flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              source === id ? 'bg-[#35373b] text-white' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {source !== 'sentry' && source !== 'github' && (
          <Select
            aria-label="Janela de tempo"
            className="w-28"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          >
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="60">1 hora</option>
            <option value="240">4 horas</option>
          </Select>
        )}
        {source === 'gcp' || source === 'cloudflare' ? (
          <div className="flex min-w-0 flex-1 gap-2">
            <Input
              value={search}
              placeholder={source === 'gcp' ? 'Correlation ID UUID' : 'Buscar logs'}
              aria-label="Buscar nos logs"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setFilter(search.trim());
              }}
            />
            <Button variant="outline" size="icon" onClick={() => setFilter(search.trim())}>
              <Search size={17} />
            </Button>
          </div>
        ) : null}
        <Button variant="outline" size="icon" onClick={() => void q.refetch()}>
          <RefreshCcw size={16} />
        </Button>
      </div>
      {q.isPending ? (
        <Card className="p-6">
          <Spinner />
        </Card>
      ) : q.error ? (
        <IssueBanner error={q.error} />
      ) : (
        <Card className="overflow-hidden">
          {source === 'gcp' && (
            <div className="divide-y divide-[#282a2e]">
              {(data.items as CloudLog[]).length ? (
                (data.items as CloudLog[]).map((item, i) => (
                  <div key={item.insertId || i} className="space-y-1 px-4 py-3.5">
                    <div className="flex justify-between gap-3">
                      <span className="truncate text-xs text-slate-400">{item.service || item.resource}</span>
                      <Badge tone={state(item.severity === 'ERROR' ? 'error' : 'neutral')}>
                        {item.severity || 'LOG'}
                      </Badge>
                    </div>
                    <pre className="logline">{item.message}</pre>
                    <p className="text-[11px] text-slate-600">{date(item.timestamp)}</p>
                  </div>
                ))
              ) : (
                <div className="p-6">
                  <Empty
                    title="Nenhum erro encontrado"
                    detail="Aumente a janela de tempo ou use um correlation ID."
                  />
                </div>
              )}
              {data.console_url && (
                <div className="p-4">
                  <External href={data.console_url}>Abrir Logs Explorer</External>
                </div>
              )}
            </div>
          )}
          {source === 'cloudflare' && (
            <div className="divide-y divide-[#282a2e]">
              {(data.items as CfLog[]).length ? (
                (data.items as CfLog[]).map((item, i) => (
                  <div key={item.id || i} className="space-y-1 px-4 py-3.5">
                    <p className="text-xs text-slate-500">
                      {item.service} · {item.outcome}
                    </p>
                    <pre className="logline">{item.message}</pre>
                    <p className="text-[11px] text-slate-600">
                      {new Date(item.timestamp).toLocaleString('pt-BR')}
                    </p>
                  </div>
                ))
              ) : (
                <div className="p-6">
                  <Empty title="Sem logs no período" />
                </div>
              )}
            </div>
          )}
          {source === 'github' &&
            (data.items as Run[])
              .slice(0, 25)
              .map((item) => (
                <RunRow
                  key={item.id}
                  run={item}
                  onSelect={() => window.open(item.html_url, '_blank', 'noopener,noreferrer')}
                />
              ))}
          {source === 'sentry' && (
            <div className="divide-y divide-[#282a2e]">
              {(data.items as Issue[]).length ? (
                (data.items as Issue[]).map((item) => (
                  <div key={item.id} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone="danger">{item.level}</Badge>
                      <span className="truncate text-xs text-slate-500">{item.project}</span>
                    </div>
                    <p className="mt-2 break-words text-sm font-medium">{item.title}</p>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        {item.count} eventos · {date(item.lastSeen)}
                      </span>
                      <External href={item.permalink}>Ver erro</External>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-6">
                  <Empty title="Nenhum issue aberto" />
                </div>
              )}
            </div>
          )}
        </Card>
      )}
      <p className="text-xs leading-5 text-slate-600">
        Logs são sanitizados no servidor. A origem exata e os eventos completos permanecem nos provedores.
      </p>
    </div>
  );
}
function ConfigEditor() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['config'],
    queryFn: () => api<{ value: string; version: string; updated_at: string }>('/config'),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const [editor, setEditor] = useState('');
  const [version, setVersion] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [autoApply, setAutoApply] = useState(true);
  const [lastSave, setLastSave] = useState<{
    plan: ConfigPlan;
    dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }>;
    blocked?: boolean;
    auto_apply?: boolean;
  } | null>(null);
  useEffect(() => {
    if (q.data) {
      setEditor(q.data.value);
      setVersion(q.data.version);
    }
  }, [q.data]);
  const update = useMutation({
    mutationFn: () =>
      send<{
        version: string;
        plan: ConfigPlan;
        dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }>;
        blocked?: boolean;
        auto_apply?: boolean;
      }>('/config', { value: editor, version, auto_apply: autoApply }, 'PUT'),
    onSuccess: (r) => {
      setVersion(r.version);
      setLastSave(r);
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const dirty = Boolean(q.data && editor !== q.data.value);
  const preview = useMemo(() => {
    if (!q.data || !dirty) return null;
    try {
      return { plan: planConfigChange(q.data.value, editor), error: '' };
    } catch {
      return { plan: null, error: 'Não foi possível calcular o plano: confira o formato do .env.' };
    }
  }, [q.data, dirty, editor]);
  const validation = useMemo(() => {
    if (!editor.trim()) return 'Configuração vazia';
    if (editor.trim().startsWith('{'))
      try {
        JSON.parse(editor);
        return null;
      } catch {
        return 'JSON inválido';
      }
    return null;
  }, [editor]);
  return (
    <div className="space-y-4">
      <Section title="GCP_CONFIG_ENV" detail="GitHub · Environment production · Variável versionada por hash">
        {q.isPending ? (
          <Spinner />
        ) : q.error ? (
          <IssueBanner error={q.error} />
        ) : (
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <Badge tone={dirty ? 'warning' : 'success'}>{dirty ? 'Não salvo' : 'Sincronizado'}</Badge>
              <span className="text-xs text-slate-500">Editado {date(q.data?.updated_at)}</span>
            </div>
            <Textarea
              value={editor}
              onChange={(e) => setEditor(e.target.value)}
              rows={19}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-label="Editar GCP_CONFIG_ENV"
              className="min-h-[360px] resize-y text-[13px]"
            />
            {validation && <p className="text-xs text-red-300">{validation}</p>}
            {preview?.error && <p className="text-xs text-red-300">{preview.error}</p>}
            {preview?.plan && (
              <div className="rounded-lg border border-[#34363b] bg-white/[.025] p-3 text-xs">
                <p className="font-semibold text-slate-200">
                  {preview.plan.changed.length} variáveis alteradas
                </p>
                <p className="mt-1 text-slate-400">
                  {preview.plan.workflows.length
                    ? 'Ao salvar: ' + preview.plan.workflows.map((item) => item.label).join(' · ')
                    : 'Nenhuma publicação automática necessária.'}
                </p>
                {preview.plan.manual.map((reason) => (
                  <p key={reason} className="mt-2 text-amber-300">
                    Atenção: {reason}
                  </p>
                ))}
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={autoApply}
                onChange={(event) => setAutoApply(event.target.checked)}
                className="h-4 w-4 accent-white"
              />
              Aplicar automaticamente as alterações ao salvar
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (q.data) setEditor(q.data.value);
                  }}
                  disabled={!dirty}
                >
                  <RotateCcw size={14} />
                  Reverter
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    try {
                      setEditor(JSON.stringify(JSON.parse(editor), null, 2));
                    } catch {}
                  }}
                >
                  <Code2 size={14} />
                  Formatar JSON
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(editor)}>
                  <Copy size={14} />
                </Button>
              </div>
              <Button
                size="sm"
                onClick={() => setConfirm(true)}
                disabled={!dirty || !!validation || !!preview?.error || update.isPending}
              >
                <Save size={15} />
                Salvar variável
              </Button>
            </div>
            <p className="text-xs leading-5 text-slate-500">
              O painel edita uma variável do GitHub, não um secret. O Telegram aceita token diretamente
              no .env, mas o valor poderá ser visto por quem tem acesso às variáveis do repositório e à configuração
              do Cloud Run. Prefira um GitHub Environment Secret ou Secret Manager se precisar de sigilo forte.
              Alterações de runtime sincronizam sem reconstruir Docker.
            </p>
            {update.error && <IssueBanner error={update.error} />}
            {lastSave && (
              <div className="space-y-2 rounded-lg border border-[#32353b] p-3 text-xs">
                <Badge tone="success">Configuração salva no GitHub</Badge>
                {lastSave.blocked && (
                  <p className="text-amber-300">
                    Publicação suspensa: é necessário revisar IAM ou infraestrutura antes de executar.
                  </p>
                )}
                {!lastSave.auto_apply && (
                  <p className="text-slate-400">Aplicação automática desativada neste salvamento.</p>
                )}
                {lastSave.dispatches.map((item) => (
                  <p key={item.file} className={item.status === 'failed' ? 'text-red-300' : 'text-slate-300'}>
                    {item.status === 'queued' ? '✓ Solicitado' : '✕ Falha ao solicitar'}: {item.label}
                    {item.error ? ' · ' + item.error : ''}
                    {' '}
                    <a
                      href={'https://github.com/rodkisten/photointel/actions/workflows/' + item.file}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      Abrir Actions
                    </a>
                  </p>
                ))}
                {lastSave.plan.manual.map((reason) => (
                  <p key={reason} className="text-amber-300">Revisão manual: {reason}</p>
                ))}
                {lastSave.plan.changed.length === 0 && (
                  <p className="text-slate-400">Somente formatação alterada; nenhum workflow necessário.</p>
                )}
              </div>
            )}
          </Card>
        )}
      </Section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Salvar configuração de produção?"
        description={
          autoApply
            ? 'O GitHub Environment será salvo e os workflows necessários serão solicitados automaticamente. Alterações que exigem IAM ou migração permanecerão pendentes de revisão.'
            : 'Isso salva GCP_CONFIG_ENV sem disparar workflows. Será necessário aplicar as alterações manualmente.'
        }
        label="Salvar"
        onConfirm={() => update.mutate()}
        busy={update.isPending}
      />
    </div>
  );
}
function SystemInfo({ meta }: { meta: Meta }) {
  const [selectedJob, setSelectedJob] = useState('');
  const health = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<{ providers: string[] }>('/overview'),
    refetchInterval: 30_000,
    retry: false,
  });
  const check = (index: number): [string, boolean] => {
    if (health.isPending) return ['Verificando acesso…', false];
    if (health.error) return ['Falha ao consultar as integrações', false];
    const outcome = health.data?.providers[index] || 'Indisponível';
    return outcome === 'ok' ? ['API verificada', true] : [outcome, false];
  };
  const gcp = useQuery({
    queryKey: ['gcp-jobs'],
    queryFn: () => api<{ items: { name: string; updateTime: string }[] }>('/gcp/jobs'),
    retry: false,
  });
  const executions = useQuery({
    queryKey: ['gcp-executions', selectedJob],
    queryFn: () =>
      api<{
        items: {
          name: string;
          createTime: string;
          completionTime: string;
          runningCount: number;
          succeededCount: number;
          failedCount: number;
          taskCount: number;
          condition: string;
          logUri?: string;
        }[];
      }>('/gcp/executions?job=' + encodeURIComponent(selectedJob)),
    enabled: Boolean(selectedJob),
    retry: false,
    refetchInterval: 30_000,
  });
  const scheduler = useQuery({
    queryKey: ['gcp-scheduler'],
    queryFn: () =>
      api<{
        items: {
          name: string;
          state: string;
          schedule: string;
          lastAttemptTime: string;
          status: number | null;
        }[];
      }>('/gcp/scheduler'),
    retry: false,
  });
  const telegram = useQuery({
    queryKey: ['gcp-telegram'],
    queryFn: () =>
      api<{
        enabled: boolean;
        endpointConfigured: boolean;
        destinationConfigured: boolean;
        tokenBound: boolean;
        ready: boolean;
        explanation: string;
      }>('/gcp/telegram'),
    retry: false,
  });
  const workers = useQuery({
    queryKey: ['workers'],
    queryFn: () =>
      api<{
        items: { name: string; modified_on: string }[];
        domains: { hostname: string; service: string }[];
      }>('/cloudflare/workers'),
    retry: false,
  });
  return (
    <div className="space-y-5">
      <Section title="Acesso e integrações" detail="Identidade verificada pelo Cloudflare Access">
        <Card className="divide-y divide-[#282a2e]">
          {(
            [
              ['Usuário autenticado', meta.email, true, true],
              ['GitHub', ...check(0), true],
              ['Cloudflare', ...check(1), true],
              ['Google Cloud', ...check(2), true],
              ['Sentry', meta.sentry ? 'Configurado (não verificado)' : 'Token ausente', false, false],
            ] as Array<[string, string, boolean, boolean]>
          ).map(([name, detail, ok, verified]) => (
            <div key={name} className="flex items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{name}</p>
                <p className="break-words text-xs text-slate-500">{detail}</p>
              </div>
              <Badge tone={ok ? 'success' : 'warning'}>{ok ? 'OK' : verified ? 'Erro' : 'Pendente'}</Badge>
            </div>
          ))}
        </Card>
      </Section>
      <Section
        title="Notificações Telegram · Jobs"
        detail="Verificação da configuração efetiva na revisão da API Cloud Run, sem expor segredos"
      >
        {telegram.isPending ? (
          <Spinner />
        ) : telegram.error ? (
          <IssueBanner error={telegram.error} />
        ) : (
          <Card className="space-y-3 p-4">
            <Badge tone={telegram.data?.ready ? 'success' : 'warning'}>
              {telegram.data?.ready ? 'Configurado' : 'Configuração incompleta'}
            </Badge>
            <p className="text-sm text-slate-400">{telegram.data?.explanation}</p>
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
              {(
                [
                  ['Ativação', telegram.data?.enabled],
                  ['Endpoint', telegram.data?.endpointConfigured],
                  ['Destino', telegram.data?.destinationConfigured],
                  ['Token configurado', telegram.data?.tokenBound],
                ] as Array<[string, boolean | undefined]>
              ).map(([label, ready]) => (
                <div key={label} className="rounded-lg bg-white/[.035] px-3 py-2">
                  {ready ? '✓' : '✕'} {label}
                </div>
              ))}
            </div>
          </Card>
        )}
      </Section>
      <Section title="Jobs Cloud Run">
        {gcp.isPending ? (
          <Spinner />
        ) : gcp.error ? (
          <IssueBanner error={gcp.error} />
        ) : (
          <Card className="divide-y divide-[#282a2e]">
            {gcp.data?.items.map((j) => (
              <button
                key={j.name}
                onClick={() => setSelectedJob(j.name.split('/').pop() || '')}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[.035]',
                  selectedJob === j.name.split('/').pop() && 'bg-white/[.04]',
                )}
              >
                <Server size={16} className="text-slate-500" />
                <span className="min-w-0 flex-1 truncate text-sm">{j.name.split('/').pop()}</span>
                <span className="text-xs text-slate-600">{date(j.updateTime)}</span>
                <ChevronRight size={14} className="text-slate-600" />
              </button>
            ))}
          </Card>
        )}
        {selectedJob && (
          <Card className="mt-3 p-4">
            <div className="mb-3 flex justify-between gap-2">
              <span className="truncate text-sm font-semibold">{selectedJob} · Execuções</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedJob('')}>
                <X size={14} />
              </Button>
            </div>
            {executions.isPending ? (
              <Spinner />
            ) : executions.error ? (
              <IssueBanner error={executions.error} />
            ) : executions.data?.items.length ? (
              executions.data.items.map((e) => (
                <div key={e.name} className="border-b border-[#292b2f] py-3 last:border-0">
                  <div className="flex justify-between gap-2">
                    <span className="truncate text-xs text-slate-300">{e.name.split('/').pop()}</span>
                    <Badge tone={e.failedCount > 0 ? 'danger' : e.completionTime ? 'success' : 'info'}>
                      {e.failedCount > 0 ? 'Falhou' : e.completionTime ? 'Finalizado' : 'Executando'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {e.succeededCount || 0} concluídos · {e.runningCount || 0} executando ·{' '}
                    {e.failedCount || 0} falhas · {e.taskCount || 0} tarefas
                  </p>
                  <div className="mt-1 flex justify-between text-xs text-slate-600">
                    <span>{date(e.createTime)}</span>
                    <External href={e.logUri}>Logs</External>
                  </div>
                </div>
              ))
            ) : (
              <Empty title="Nenhuma execução registrada" />
            )}
          </Card>
        )}
      </Section>
      <Section title="Cloud Scheduler" detail="Agendamentos e última tentativa">
        {scheduler.isPending ? (
          <Spinner />
        ) : scheduler.error ? (
          <IssueBanner error={scheduler.error} />
        ) : (
          <Card className="divide-y divide-[#282a2e]">
            {scheduler.data?.items.map((j) => (
              <div key={j.name} className="flex items-center gap-3 px-4 py-3">
                <History size={15} className="shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{j.name.split('/').pop()}</p>
                  <p className="text-xs text-slate-500">
                    {j.schedule} · Último {date(j.lastAttemptTime)}
                  </p>
                </div>
                <Badge tone={j.state === 'ENABLED' ? 'success' : 'warning'}>{j.state}</Badge>
              </div>
            ))}
          </Card>
        )}
      </Section>
      <Section title="Domínios Cloudflare">
        {workers.isPending ? (
          <Spinner />
        ) : workers.error ? (
          <IssueBanner error={workers.error} />
        ) : (
          <Card className="divide-y divide-[#282a2e]">
            {workers.data?.domains.map((d) => (
              <div key={d.hostname} className="flex items-center gap-3 px-4 py-3">
                <Cloud size={16} className="text-slate-500" />
                <span className="min-w-0 flex-1 truncate text-sm">{d.hostname}</span>
                <span className="truncate text-xs text-slate-600">{d.service}</span>
              </div>
            ))}
          </Card>
        )}
      </Section>
      <div className="flex flex-wrap gap-4 text-xs">
        <External href="https://github.com/rodkisten/photointel/actions">GitHub Actions</External>
        <External href="https://console.cloud.google.com/run?project=photointel">Cloud Run</External>
        <External href="https://dash.cloudflare.com/?to=/:account/workers-and-pages">Cloudflare</External>
      </div>
    </div>
  );
}
export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [opened, setOpened] = useState<number | null>(null);
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/meta'), retry: false });
  function navigate(next: Tab) {
    setOpened(null);
    setTab(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[#25272b] bg-[#0d0e10]/95 backdrop-blur-xl">
        <div className="mx-auto flex h-[66px] max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white text-black">
              <CloudCog size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight">PhotoIntel</p>
              <p className="text-[11px] tracking-wide text-slate-500">CONTROL CENTER</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="hidden max-w-44 truncate sm:inline">{meta.data?.email}</span>
            <Shield size={17} className={meta.data ? 'text-emerald-400' : 'text-slate-500'} />
            <Badge tone="neutral">Production</Badge>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
        <aside className="hidden w-48 shrink-0 md:block">
          <nav className="sticky top-24 space-y-1">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                  tab === n.id
                    ? 'bg-[#292b2f] text-white'
                    : 'text-slate-500 hover:bg-[#191b1e] hover:text-slate-200',
                )}
              >
                <n.icon size={17} />
                {n.label}
              </button>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 space-y-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-slate-600">PRODUCTION / {meta.data?.project || 'photointel'}</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
                {opened !== null ? 'Detalhes da execução' : NAV.find((n) => n.id === tab)?.label}
              </h1>
              <p className="mt-1.5 text-sm text-slate-500">
                {opened !== null
                  ? 'Etapas e logs técnicos'
                  : tab === 'overview'
                    ? 'Saúde, atividade e infraestrutura em um só lugar'
                    : tab === 'deploy'
                      ? 'Dispare e acompanhe pipelines com segurança'
                      : tab === 'logs'
                        ? 'Eventos investigáveis em cada provedor'
                        : tab === 'config'
                          ? 'Edição segura das configurações de produção'
                          : 'Integrações, jobs e acesso'}
              </p>
            </div>
            <Activity size={20} className="mt-3 text-slate-600" />
          </div>
          {meta.isPending ? (
            <Card className="p-8">
              <Spinner />
            </Card>
          ) : meta.error ? (
            <IssueBanner error={meta.error} />
          ) : opened !== null ? (
            <RunDetail id={opened} onBack={() => setOpened(null)} />
          ) : tab === 'overview' ? (
            <Overview openRun={(id) => setOpened(id)} />
          ) : tab === 'deploy' ? (
            <Deploys openRun={(id) => setOpened(id)} />
          ) : tab === 'logs' ? (
            <LogViewer />
          ) : tab === 'config' ? (
            <ConfigEditor />
          ) : (
            <SystemInfo meta={meta.data!} />
          )}
          <footer className="border-t border-[#282a2e] pt-5 text-xs text-slate-600">
            PhotoIntel Manage · Operações auditáveis · Cloudflare Access
          </footer>
        </main>
      </div>
      <nav
        aria-label="Navegação principal"
        className="fixed bottom-0 inset-x-0 z-30 flex border-t border-[#313338] bg-[#121315]/95 px-1 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl md:hidden"
      >
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => navigate(n.id)}
            aria-current={tab === n.id ? 'page' : undefined}
            className={cn(
              'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 text-[10px]',
              tab === n.id ? 'text-white' : 'text-slate-500',
            )}
          >
            <n.icon size={21} />
            <span className="truncate">{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
