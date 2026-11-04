import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CloudCog, ExternalLink, Play, Power, PowerOff, RefreshCcw, Terminal, Timer, ScrollText } from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select } from '../components/ui';
import { ConfirmDialog } from '../components/confirm-dialog';
import { JsonView } from '../components/json-view';
import { Empty, IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';

type DataItem = Record<string, unknown>;
type Source = { status: 'ok' | 'error'; items: DataItem[]; message?: string };
type Vm = {
  name: string; zone: string; status: string; started_at: string | null;
  expiration_at: string | null; duration_minutes: number | null;
  max_duration_enforced: boolean; console_url: string; machine: string;
};
type Trigger = { id: string; location: string; name: string; description: string; disabled: boolean; authorized: boolean; filename: string };
type Build = { id: string; status: string; create_time?: string; start_time?: string; finish_time?: string; log_url?: string; steps?: Array<{ id: string; name: string; status: string }> };
type Snapshot = {
  checked_at: string; project: string; region: string; trigger_configured: boolean;
  vm: Source; services: Source; jobs: Source; scheduler: Source;
  builds: Source; global_builds: Source; triggers: Source; global_triggers: Source;
};
type Log = { timestamp: string; severity: string; message: string; id?: string };
type Logs = { items: Log[]; serial?: Log[]; errors?: string[]; checked_at: string };

const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString('pt-BR') : 'Indisponível';
const statusTone = (value: string): 'success' | 'danger' | 'warning' | 'neutral' =>
  /^(RUNNING|SUCCESS|SUCCEEDED|ACTIVE|READY|NOTICE|OK)$/i.test(value) ? 'success' :
    /^(FAILURE|FAILED|ERROR|CANCELLED|INTERNAL_ERROR)$/i.test(value) ? 'danger' :
      /^(QUEUED|PENDING|WORKING|PROVISIONING|STAGING|STOPPING)$/i.test(value) ? 'warning' : 'neutral';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitForVmOperation(name: string) {
  if (!name || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error('Operação GCP inválida');
  for (let attempt = 0; attempt < 28; attempt++) {
    const result = await api<{ status: string; error?: string | null }>('/infrastructure/vm/operations/' + name);
    if (result.status === 'DONE') {
      if (result.error) throw new Error(result.error);
      return;
    }
    await sleep(1300);
  }
  throw new Error('Operação ainda em andamento. Atualize o status antes de tentar novamente.');
}

function CountDown({ deadline }: { deadline: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!deadline) return <span className="text-carbon-500">Expiração não informada pelo GCP</span>;
  const seconds = Math.max(0, Math.floor((Date.parse(deadline) - now) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return <span className="font-mono text-lg font-semibold tabular-nums text-white">{[h, m, s].map((v) => String(v).padStart(2, '0')).join(':')}</span>;
}

function ProviderList({ source, empty }: { source: Source; empty: string }) {
  if (source.status === 'error') return <p className="text-xs text-amber-400">{source.message}</p>;
  if (!source.items.length) return <p className="text-xs text-carbon-500">{empty}</p>;
  return <div className="max-h-48 space-y-2 overflow-y-auto">
    {source.items.slice(0, 30).map((item, i) => (
      <div key={String(item.name || i)} className="flex items-center justify-between gap-3 border-b border-carbon-800 pb-2 text-xs">
        <span className="min-w-0 break-all text-carbon-300">{String(item.name || 'Recurso').split('/').pop()}</span>
        <Badge tone={statusTone(String(item.state || item.condition || (item.reconciling ? 'WORKING' : 'READY')))}>
          {String(item.state || item.condition || (item.reconciling ? 'Reconciling' : 'Encontrado'))}
        </Badge>
      </div>
    ))}
  </div>;
}
function LogLine({ item, search }: { item: Log; search: string }) {
  const [expanded, setExpanded] = useState(false);
  const fragments = useMemo(() => {
    const value = (item.message || '').slice(0, 6000);
    if (!search.trim()) return [value];
    const needle = search.trim().slice(0, 100).toLowerCase();
    const pieces: Array<{ value: string; match: boolean }> = [];
    let offset = 0, index = value.toLowerCase().indexOf(needle);
    while (index >= 0 && pieces.length < 100) {
      if (index > offset) pieces.push({ value: value.slice(offset, index), match: false });
      pieces.push({ value: value.slice(index, index + needle.length), match: true });
      offset = index + needle.length;
      index = value.toLowerCase().indexOf(needle, offset);
    }
    if (offset < value.length) pieces.push({ value: value.slice(offset), match: false });
    return pieces;
  }, [item.message, search]);
  const json = item.message && /^[\s]*[{[]/.test(item.message);
  return (
    <div className="border-b border-carbon-800/70 px-3 py-2 text-xs leading-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-carbon-500">{date(item.timestamp)}</span>
        <Badge tone={statusTone(item.severity)}>{item.severity || 'INFO'}</Badge>
        {json && <button className="text-carbon-400 underline" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Ocultar JSON' : 'Ver JSON'}
        </button>}
      </div>
      <div className="mt-1 min-w-0 whitespace-pre-wrap break-words font-mono text-[12px] text-carbon-200">
        {fragments.map((frag, i) => typeof frag === 'string' ? <span key={i}>{frag}</span> :
          frag.match ? <mark key={i} className="bg-amber-400/30 text-amber-100">{frag.value}</mark> : <span key={i}>{frag.value}</span>)}
      </div>
      {expanded && json && <div className="mt-2 min-w-0"><JsonView data={item.message} search={search} maxHeight={320} /></div>}
    </div>
  );
}

export function Infrastructure() {
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: ['infrastructure'], queryFn: () => api<Snapshot>('/infrastructure'),
    refetchInterval: 10_000, retry: false,
  });
  const [minutes, setMinutes] = useState('120');
  const [selectedTrigger, setSelectedTrigger] = useState('');
  const [buildId, setBuildId] = useState('');
  const [logTab, setLogTab] = useState<'vm' | 'build'>('vm');
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);
  const [confirm, setConfirm] = useState<'start' | 'stop' | 'build' | null>(null);
  const vm = overview.data?.vm.status === 'ok' ? overview.data.vm.items[0] as Vm | undefined : undefined;
  const builds = [...(overview.data?.builds.items || []), ...(overview.data?.global_builds.items || [])] as Build[];
  const triggers = [...(overview.data?.triggers.items || []), ...(overview.data?.global_triggers.items || [])] as Trigger[];
  const authorized = triggers.filter((x) => x.authorized && !x.disabled);
  useEffect(() => {
    if (authorized.length && !authorized.some((x) => x.location + ':' + x.id === selectedTrigger))
      setSelectedTrigger(authorized[0].location + ':' + authorized[0].id);
  }, [authorized.map((x) => x.location + x.id).join(','), selectedTrigger]);
  useEffect(() => {
    if (builds.length && !builds.some((x) => x.id === buildId)) setBuildId(builds[0].id);
  }, [builds.map((x) => x.id).join(','), buildId]);

  const mutation = useMutation({
    mutationFn: async (action: 'start' | 'stop' | 'build') => {
      if (action === 'build') {
        const [location, id] = selectedTrigger.split(':');
        return send('/infrastructure/builds/run', { id, location, confirm: 'RUN ' + location + ':' + id });
      }
      if (action === 'stop') return send('/infrastructure/vm/stop', {});
      const value = Number(minutes);
      const prep = await send<{ operation: string }>('/infrastructure/vm/prepare', { minutes: value });
      await waitForVmOperation(prep.operation);
      return send('/infrastructure/vm/start', { minutes: value });
    },
    onSuccess: async () => {
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: ['infrastructure'] });
    },
  });
  const logs = useQuery({
    queryKey: ['infra-logs', logTab, buildId],
    queryFn: () => api<Logs>(logTab === 'vm' ? '/infrastructure/vm/logs' :
      '/infrastructure/builds/logs?id=' + encodeURIComponent(buildId)),
    enabled: logTab === 'vm' ? Boolean(vm) : Boolean(buildId),
    refetchInterval: live ? 5000 : false, retry: false,
  });
  const lines = [...(logs.data?.items || []), ...(logTab === 'vm' ? logs.data?.serial || [] : [])]
    .filter((x) => !search.trim() || (x.message || '').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const selected = authorized.find((x) => x.location + ':' + x.id === selectedTrigger);
  const titles = { start: 'Iniciar terminal GCP', stop: 'Desligar terminal GCP', build: 'Executar Cloud Build' };
  const descriptions = {
    start: 'Aplicar limite de ' + minutes + ' minutos e ligar a VM. O próprio Compute Engine a desligará no vencimento.',
    stop: 'Desligar a VM agora. Processos em execução e sessões SSH serão interrompidos.',
    build: 'Executar o trigger ' + (selected?.name || '') + ' na branch main. Pode provisionar recursos e gerar custos.',
  };

  return (
    <div className="space-y-6">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <Activity size={20} className="text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-carbon-100">photointel · us-central1</p>
            <p className="text-xs text-carbon-500">Última leitura: {date(overview.data?.checked_at)}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void overview.refetch()}>
          <RefreshCcw size={14} /> Atualizar
        </Button>
      </Card>
      {overview.isPending && <Spinner />}
      {overview.error && <IssueBanner error={overview.error} />}
      <Section title="VM SSH" detail="photointel-terminal · us-central1-a · duração limitada pelo próprio Compute Engine">
        <Card className="space-y-4 p-4 sm:p-5">
          {overview.data?.vm.status === 'error' && <p className="text-sm text-amber-400">{overview.data.vm.message}</p>}
          {vm && <>
            <div className="flex flex-wrap items-center gap-3">
              <Terminal size={22} />
              <strong className="text-base text-white">{vm.name}</strong>
              <Badge tone={statusTone(vm.status)}>{vm.status}</Badge>
              <span className="text-xs text-carbon-500">{vm.machine}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-carbon-900 p-3">
                <p className="text-xs text-carbon-500">Tempo até desligamento automático</p>
                <CountDown deadline={vm.status === 'RUNNING' ? vm.expiration_at : null} />
                <p className="mt-1 text-xs text-carbon-500">Expira: {vm.status === 'RUNNING' ? date(vm.expiration_at) : 'quando iniciar'}</p>
              </div>
              <div className="rounded-lg bg-carbon-900 p-3 text-xs">
                <p className="text-carbon-500">Última inicialização</p>
                <p className="mt-1 text-carbon-200">{date(vm.started_at)}</p>
                <p className="mt-2 text-carbon-500">Acesso por Tailscale</p>
                <code className="text-carbon-100">ssh rod@photointel-terminal</code>
              </div>
            </div>
            <label className="field-label" htmlFor="vm-minutes">Duração máxima da próxima sessão</label>
            <Select id="vm-minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={vm.status !== 'TERMINATED'}>
              {[15, 30, 60, 90, 120, 180, 240, 360, 480, 720].map((n) =>
                <option key={n} value={n}>{n < 60 ? n + ' minutos' : n / 60 + ' hora(s)'}</option>)}
            </Select>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={mutation.isPending || vm.status !== 'TERMINATED'} onClick={() => setConfirm('start')}>
                <Power size={16} /> Ligar
              </Button>
              <Button variant="destructive" disabled={mutation.isPending || vm.status !== 'RUNNING'} onClick={() => setConfirm('stop')}>
                <PowerOff size={16} /> Desligar
              </Button>
              <a className="inline-flex items-center gap-1 text-xs text-carbon-300 underline" href={vm.console_url} target="_blank" rel="noopener noreferrer">
                Console Compute <ExternalLink size={13} />
              </a>
            </div>
            <p className="text-xs text-carbon-500">Alterar o prazo de uma sessão em curso exige parar e iniciar novamente. A contagem exibida vem do encerramento informado pelo GCP.</p>
            {vm.status === 'RUNNING' && !vm.max_duration_enforced &&
              <p className="text-sm text-red-400">Aviso: essa VM está sem desligamento automático confirmado.</p>}
          </>}
        </Card>
      </Section>

      <Section title="Cloud Build" detail="Execute triggers autorizados, inclusive o de provisionamento, sem consumir minutos de runner GitHub">
        <Card className="space-y-4 p-4 sm:p-5">
          {overview.data && !overview.data.trigger_configured &&
            <p className="text-sm text-amber-400">Nenhum trigger autorizado. Configure GCP_CLOUDBUILD_ALLOWED_TRIGGERS no Worker.</p>}
          {overview.data?.triggers.status === 'error' && <IssueBanner error={new Error(overview.data.triggers.message)} />}
          <label className="field-label" htmlFor="build-trigger">Pipeline / trigger</label>
          <Select id="build-trigger" value={selectedTrigger} onChange={(e) => setSelectedTrigger(e.target.value)} disabled={!authorized.length}>
            {authorized.length === 0 && <option value="">Nenhum trigger autorizado</option>}
            {authorized.map((t) =>
              <option key={t.location + t.id} value={t.location + ':' + t.id}>{t.name} · {t.location}</option>)}
          </Select>
          <Button disabled={!selected || mutation.isPending} onClick={() => setConfirm('build')}>
            <Play size={15} /> Executar no Cloud Build
          </Button>
          <p className="text-xs text-carbon-500">O trigger usa o commit atual de main e suas permissões próprias. O Manage não executa comandos arbitrários nem cria triggers privilegiados.</p>
          {builds.length > 0 && <div className="space-y-2 border-t border-carbon-800 pt-4">
            <p className="text-sm font-medium">Builds recentes</p>
            {builds.slice(0, 18).map((build) =>
              <button key={build.id} className="flex w-full items-center justify-between gap-2 rounded-lg bg-carbon-900 px-3 py-2 text-left hover:bg-carbon-800"
                onClick={() => { setBuildId(build.id); setLogTab('build'); }}>
                <span className="min-w-0"><span className="block truncate font-mono text-xs">{build.id.slice(0, 12)}</span>
                  <span className="text-[11px] text-carbon-500">{date(build.create_time)}</span>
                </span>
                <Badge tone={statusTone(build.status)}>{build.status}</Badge>
              </button>)}
          </div>}
        </Card>
      </Section>

      <div className="grid gap-3 sm:grid-cols-3">
        {([
          ['Cloud Run · serviços', overview.data?.services, 'Sem serviços'],
          ['Cloud Run · jobs', overview.data?.jobs, 'Sem jobs'],
          ['Cloud Scheduler', overview.data?.scheduler, 'Sem agendamentos'],
        ] as const).map(([title, source, empty]) =>
          <Card key={title} className="min-w-0 space-y-3 p-4">
            <div className="flex items-center gap-2"><CloudCog size={16} /><strong className="text-sm">{title}</strong></div>
            {source ? <ProviderList source={source} empty={empty} /> : <Spinner />}
          </Card>)}
      </div>

      <Section title="Logs ao vivo" detail="Cloud Logging + eventos seguros de inicialização da VM; atualização a cada 5 segundos">
        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-carbon-800 p-3">
            <Button size="sm" variant={logTab === 'vm' ? 'secondary' : 'ghost'} onClick={() => setLogTab('vm')}>
              <Terminal size={14} /> VM
            </Button>
            <Button size="sm" variant={logTab === 'build' ? 'secondary' : 'ghost'} onClick={() => setLogTab('build')}>
              <ScrollText size={14} /> Build
            </Button>
            {logTab === 'build' && <Select className="max-w-[220px]" value={buildId} onChange={(e) => setBuildId(e.target.value)}>
              {builds.map((b) => <option key={b.id} value={b.id}>{b.id.slice(0, 12)}</option>)}
            </Select>}
            <Button size="sm" variant="ghost" onClick={() => void logs.refetch()}><RefreshCcw size={14} /></Button>
            <label className="ml-auto flex items-center gap-2 text-xs text-carbon-400">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Ao vivo
            </label>
          </div>
          <div className="p-3">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar nos logs e destacar" />
          </div>
          {logs.error && <div className="p-3"><IssueBanner error={logs.error} /></div>}
          {logs.data?.errors?.map((x) => <p className="px-3 pb-2 text-xs text-amber-400" key={x}>{x}</p>)}
          {logs.isPending ? <div className="p-4"><Spinner /></div> :
            lines.length === 0 ? <div className="p-5"><Empty title="Sem registros nesta janela" detail="Acompanhe o próximo ciclo de leitura." /></div> :
            <div className="max-h-[min(65vh,690px)] min-w-0 overflow-y-auto overscroll-contain">
              {lines.slice(-160).map((line, index) => <LogLine key={line.id || line.timestamp + index} item={line} search={search} />)}
            </div>}
        </Card>
      </Section>
      {mutation.error && <IssueBanner error={mutation.error} />}
      {mutation.isPending && <Card className="flex items-center gap-3 p-4"><Spinner /> Enviando operação ao Google Cloud...</Card>}
      {mutation.isSuccess && <Card className="p-3 text-sm text-emerald-400">Operação aceita pelo Google Cloud. Acompanhe o status acima.</Card>}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={confirm ? titles[confirm] : ''}
        description={confirm ? descriptions[confirm] : ''}
        label="Executar"
        busy={mutation.isPending}
        onConfirm={() => { if (confirm) mutation.mutate(confirm); }}
      />
    </div>
  );
}
