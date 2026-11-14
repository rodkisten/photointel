import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CalendarDays, ChevronRight, Cloud, DollarSign, ExternalLink, GitBranch, RefreshCcw, Server, Wallet } from 'lucide-react';
import { Link } from '@tanstack/react-router';

import { Badge, Button, Card, Section, Select } from '../components/ui';
import { Empty, IssueBanner, Spinner } from '../components/shared';
import { api } from '../lib/client';

export type CostSource = {
  status: 'ok' | 'unconfigured' | 'unavailable';
  currency: string;
  total: number | null;
  gross_total?: number | null;
  items: Array<{ name: string; cost: number | null; detail?: string; units?: number | null; gross?: number | null; credits?: number | null; resource?: string; day?: string; usage_unit?: string; usage_amount?: number | null }>;
  note?: string;
  url?: string;
  quota?: { used_usd: number; included_usd: number | null; percent: number | null; unit: string };
};
export type CostsResponse = {
  month: string;
  checked_at: string;
  providers: Record<'github' | 'gcp' | 'cloudflare' | 'modal', CostSource>;
  total_usd: number | null;
  complete: boolean;
  alert?: { threshold_usd: number; actual_usd: number; exceeded: boolean; supported: boolean } | null;
  note: string;
};

// Missing amounts belong last: they are unknown, never silently treated as zero.
export function byCostDescending<T extends { cost: number | null }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.cost === null || !Number.isFinite(a.cost)) return b.cost === null || !Number.isFinite(b.cost) ? 0 : 1;
    if (b.cost === null || !Number.isFinite(b.cost)) return -1;
    return b.cost - a.cost;
  });
}

export function money(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Indisponível';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: value < 0.01 ? 5 : 2,
  }).format(value);
}
function months() {
  const current = new Date();
  return Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - offset, 1));
    return {
      value: date.toISOString().slice(0, 7),
      label: new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date),
    };
  });
}

const INFO = [
  { id: 'github', label: 'GitHub Actions', icon: GitBranch, subtitle: 'Uso e valores oficiais do Actions' },
  { id: 'gcp', label: 'Google Cloud', icon: Server, subtitle: 'Billing exportado para BigQuery' },
  { id: 'cloudflare', label: 'Cloudflare Workers', icon: Cloud, subtitle: 'Requisições por Worker; sem fatura individual' },
  { id: 'modal', label: 'Modal', icon: Activity, subtitle: 'Compute, GPU e ajustes do workspace' },
] as const;

// These explanations describe common billing drivers, not a verified root cause.
function costDriver(service: string, sku: string): string {
  const label = (service + ' ' + sku).toLowerCase();
  if (/cloud run/.test(label) && /cpu|vcpu/.test(label))
    return 'CPU faturada: verifique duração, instâncias mínimas, alocação de CPU, concorrência e tentativas de jobs.';
  if (/cloud run/.test(label) && /memory|ram/.test(label))
    return 'Memória faturada: confira GiB provisionados, duração das instâncias e jobs, retries e min instances.';
  if (/cloud run/.test(label) && /request/.test(label))
    return 'Requisições: confira tráfego, health checks, polling, retries e chamadas entre serviços.';
  if (/compute engine/.test(label) && /core|cpu|instance/.test(label))
    return 'VMs: confira tipo, horas ligadas, região, descontos e recursos ociosos.';
  if (/storage|disk|persistent disk|snapshot/.test(label))
    return 'Armazenamento: capacidade provisionada e retenção podem gerar cobrança mesmo com a VM desligada.';
  if (/network|egress|internet|nat|load balanc/.test(label))
    return 'Rede: confira bytes transferidos, destinos, Cloud NAT, IP externo e balanceadores.';
  if (/logging|monitoring/.test(label))
    return 'Observabilidade: confira ingestão de logs, volume de métricas, retenção e consultas.';
  if (/cloud build/.test(label))
    return 'Builds: confira duração, classe de máquina, frequência de pipelines e tentativas repetidas.';
  if (/artifact registry/.test(label))
    return 'Imagens: confira GB armazenados, versões antigas e tráfego de download.';
  if (/bigquery/.test(label))
    return 'BigQuery: confira bytes processados por consultas, armazenamento e frequência de atualização do painel.';
  return 'Verifique a unidade de consumo, a configuração do recurso e o histórico de uso no console GCP.';
}

function GcpBreakdown({ source }: { source: CostSource }) {
  const [filter, setFilter] = useState('');
  const [service, setService] = useState('');
  const [group, setGroup] = useState<'service' | 'resource' | 'sku' | 'day'>('service');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(20);
  const items = source.items.filter((item) =>
    (!service || item.name === service) &&
    [item.name, item.detail, item.resource, item.day].some((value) =>
      String(value || '').toLocaleLowerCase('pt-BR').includes(filter.toLocaleLowerCase('pt-BR'))));
  const services = [...new Set(source.items.map((item) => item.name))].sort();
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = group === 'service' ? item.name : group === 'resource' ? item.resource || 'Não atribuído'
      : group === 'sku' ? item.detail || 'SKU desconhecida' : item.day || 'Dia desconhecido';
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) =>
    b[1].reduce((sum, item) => sum + (item.cost || 0), 0) - a[1].reduce((sum, item) => sum + (item.cost || 0), 0));
  const pageCount = Math.max(1, Math.ceil(sortedGroups.length / rowsPerPage));
  const currentPage = Math.min(page, pageCount);
  const visibleGroups = sortedGroups.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);
  const totals = (entries: typeof items) => ({ 
    net: entries.reduce((sum, item) => sum + (item.cost || 0), 0),
    gross: entries.reduce((sum, item) => sum + (item.gross || 0), 0),
    credits: entries.reduce((sum, item) => sum + (item.credits || 0), 0),
  });
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs text-carbon-400">Buscar serviço, SKU, recurso ou dia
        <input aria-label="Filtrar lançamentos GCP" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}
          placeholder="Buscar custos..." className="mt-1 w-full min-w-0 rounded-lg border border-carbon-700 bg-carbon-900 p-2 text-carbon-100" />
      </label>
      <label className="text-xs text-carbon-400">Agrupar por
        <select aria-label="Agrupar custos GCP" value={group} onChange={(event) => { setGroup(event.target.value as typeof group); setExpanded(null); setPage(1); }}
          className="mt-1 w-full rounded-lg border border-carbon-700 bg-carbon-900 p-2 text-carbon-100">
          <option value="service">Serviço</option><option value="resource">Recurso</option>
          <option value="sku">SKU</option><option value="day">Dia</option>
        </select>
      </label>
    </div>
    <select aria-label="Serviço GCP" value={service} onChange={(event) => { setService(event.target.value); setPage(1); }}
      className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-2 text-xs text-carbon-100">
      <option value="">Todos os serviços</option>{services.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
    <p className="text-[11px] text-carbon-500">{items.length} lançamentos filtrados · {groups.size} grupos. Valores oficiais exportados, sujeitos a atraso. As causas são hipóteses de investigação, não diagnósticos confirmados.</p>
    {visibleGroups.map(([name, entries]) => {
      const summary = totals(entries);
      const open = expanded === name;
      return <div key={name} className="rounded-lg border border-carbon-800">
        <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? null : name)}
          className="flex w-full items-center justify-between gap-3 p-3 text-left">
          <span className="min-w-0 break-all text-xs font-medium text-carbon-200">{name}</span>
          <span className="shrink-0 text-right text-xs tabular-nums text-carbon-100">{money(summary.net, source.currency)}
            <span className="block text-[10px] text-carbon-500">{entries.length} lançamentos</span></span>
        </button>
        {open && <div className="space-y-2 border-t border-carbon-800 p-3 text-xs">
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-carbon-900 p-2 text-[11px]">
            <span>Bruto<br />{money(summary.gross, source.currency)}</span>
            <span>Créditos<br />{money(summary.credits, source.currency)}</span>
            <span>Líquido<br />{money(summary.net, source.currency)}</span>
          </div>
          {byCostDescending(entries).slice(0, 200).map((item, index) => <div key={index} className="border-b border-carbon-800/60 py-2 last:border-0">
            <div className="flex justify-between gap-2"><strong className="break-words text-carbon-200">{item.detail || item.name}</strong>
              <span className="shrink-0 tabular-nums">{money(item.cost, source.currency)}</span></div>
            <p className="mt-1 break-all text-[11px] text-carbon-500">{item.name} · {item.resource || 'Recurso não identificado'} · {item.day || 'Sem data'}</p>
            <p className="mt-1 text-[11px] leading-4 text-carbon-400">Possíveis causas: {costDriver(item.name, item.detail || '')}</p>
            <p className="text-[11px] text-carbon-500">Uso: {item.usage_amount === null || item.usage_amount === undefined ? 'Indisponível' : item.usage_amount.toLocaleString('pt-BR')} {item.usage_unit || ''} · Bruto: {money(item.gross, source.currency)} · Créditos: {money(item.credits, source.currency)}</p>
          </div>)}
          {entries.length > 200 && <p className="text-carbon-400">Exibindo 200 de {entries.length} lançamentos deste grupo. Refine os filtros.</p>}
        </div>}
      </div>;
    })}
    {sortedGroups.length > 0 && <nav aria-label="Paginação dos custos GCP" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-carbon-800 p-2 text-xs">
      <label className="flex items-center gap-2">Grupos por página
        <select aria-label="Grupos por página" value={rowsPerPage} onChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(1); }} className="rounded bg-carbon-900 p-2 text-carbon-100">
          <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button type="button" disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); setExpanded(null); }} className="rounded border border-carbon-700 px-3 py-2 disabled:opacity-40">Anterior</button>
        <span className="tabular-nums">{currentPage} / {pageCount}</span>
        <button type="button" disabled={currentPage === pageCount} onClick={() => { setPage(currentPage + 1); setExpanded(null); }} className="rounded border border-carbon-700 px-3 py-2 disabled:opacity-40">Próxima</button>
      </div>
    </nav>}
    {!items.length && <Empty title="Nenhum lançamento para os filtros selecionados" />}
  </div>;
}

type GroupResponse = {
  status: 'ok' | 'empty' | 'pending';
  group?: string; page?: number; size?: number; count?: number;
  currency?: string; total?: number | null;
  items: Array<{ name: string; cost: number | null; gross: number | null; credits: number | null }>;
  note?: string;
};
type MonitoringResponse = {
  status: 'ok' | 'partial'; checked_at: string; total_requests: number;
  services: Array<{ name: string; requests: number }>; note: string;
};

function BillingAnalytics({ month }: { month: string }) {
  const [group, setGroup] = useState('service');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const query = useQuery({
    queryKey: ['billing-groups', month, group, page, size],
    queryFn: () => api<GroupResponse>('/costs/groups?month=' + month + '&group=' + group + '&page=' + page + '&size=' + size),
    retry: false, staleTime: 5 * 60_000,
  });
  const monitoring = useQuery({
    queryKey: ['costs-monitoring'],
    queryFn: () => api<MonitoringResponse>('/costs/monitoring'),
    retry: false, refetchInterval: 5 * 60_000,
  });
  const rows = byCostDescending(query.data?.items || []);
  const max = Math.max(0, ...rows.map((item) => Math.abs(item.cost || 0)));
  const pages = Math.max(1, Math.ceil((query.data?.count || 0) / size));
  return <div className="space-y-4">
    <Section title="Faturamento detalhado" detail="Agrupado no BigQuery, com paginação no servidor">
      <div className="space-y-3 rounded-xl border border-carbon-800 p-3">
        <div className="flex flex-wrap gap-2">
          <select aria-label="Agrupamento BigQuery" value={group}
            onChange={(event) => { setGroup(event.target.value); setPage(1); }}
            className="min-w-0 flex-1 rounded-lg bg-carbon-900 p-2 text-xs text-carbon-100">
            <option value="service">Serviço</option><option value="sku">SKU</option>
            <option value="resource">Recurso</option><option value="day">Dia</option>
          </select>
          <select aria-label="Itens por página BigQuery" value={size}
            onChange={(event) => { setSize(Number(event.target.value)); setPage(1); }}
            className="rounded-lg bg-carbon-900 p-2 text-xs text-carbon-100">
            <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
          </select>
        </div>
        {query.isPending ? <Spinner /> : query.error ? <IssueBanner error={query.error} /> :
          <div className="space-y-2">
            {query.data?.note && <p className="text-xs text-carbon-500">{query.data.note}</p>}
            {rows.map((item) => <div key={item.name} className="space-y-1 border-b border-carbon-800 py-2 last:border-0">
              <div className="flex justify-between gap-2 text-xs">
                <span className="min-w-0 break-words">{item.name}</span>
                <strong className="shrink-0 tabular-nums">{money(item.cost, query.data?.currency)}</strong>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-carbon-800" role="img" aria-label={'Proporção do custo de ' + item.name}>
                <div className="h-full rounded-full bg-carbon-300" style={{ width: (max ? Math.abs(item.cost || 0) / max * 100 : 0) + '%' }} />
              </div>
              <p className="text-[11px] text-carbon-500">Bruto {money(item.gross, query.data?.currency)} · Créditos {money(item.credits, query.data?.currency)}</p>
            </div>)}
            <div className="flex items-center justify-between gap-2 text-xs">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-carbon-700 p-2 disabled:opacity-40">Anterior</button>
              <span>{page} / {pages} · {query.data?.count || 0} grupos</span>
              <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border border-carbon-700 p-2 disabled:opacity-40">Próxima</button>
            </div>
          </div>}
      </div>
    </Section>
    <Section title="Operação recente" detail="Cloud Monitoring, separado do faturamento">
      <div className="space-y-2 rounded-xl border border-carbon-800 p-3">
        {monitoring.isPending ? <Spinner /> : monitoring.error ? <IssueBanner error={monitoring.error} /> :
          <><p className="text-sm font-semibold">{monitoring.data?.total_requests.toLocaleString('pt-BR')} requisições na última hora</p>
            {monitoring.data?.services.map((service, index) => <p key={service.name + index} className="flex justify-between gap-2 text-xs">
              <span className="break-all">{service.name}</span><span>{service.requests.toLocaleString('pt-BR')}</span>
            </p>)}
            <p className="text-[11px] text-carbon-500">{monitoring.data?.note}{monitoring.data?.status === 'partial' ? ' Resultado parcial.' : ''}</p>
          </>}
      </div>
    </Section>
  </div>;
}

function SourceDetails({ source, id }: { source: CostSource; id: string }) {
  if (source.status !== 'ok') {
    return <div className="space-y-2">
      <p className="text-xs leading-5 text-carbon-400">{source.note || 'Fonte indisponível.'}</p>
      {source.url && <a className="inline-flex items-center gap-1 text-xs text-carbon-300 underline underline-offset-4"
        href={source.url} target="_blank" rel="noreferrer">Verificar no provedor <ExternalLink size={12} /></a>}
    </div>;
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-carbon-900 p-3">
          <p className="text-carbon-500">Custo líquido</p>
          <p className="mt-1 font-semibold text-carbon-100">
            {source.total === null ? 'Não disponível' : money(source.total, source.currency)}
          </p>
        </div>
        <div className="rounded-lg bg-carbon-900 p-3">
          <p className="text-carbon-500">{id === 'cloudflare' ? 'Requisições contabilizadas' : 'Custo bruto'}</p>
          <p className="mt-1 font-semibold text-carbon-100">
            {id === 'cloudflare'
              ? source.items.reduce((total, item) => total + (item.units || 0), 0).toLocaleString('pt-BR')
              : money(source.gross_total, source.currency)}
          </p>
        </div>
      </div>
      {id === 'github' && source.quota && (
        <div className="space-y-2 rounded-lg border border-carbon-800 p-3">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-medium text-carbon-300">Cota de computação</span>
            <span className="text-right text-carbon-400">
              {money(source.quota.used_usd)} / {source.quota.included_usd === null
                ? 'limite não configurado'
                : money(source.quota.included_usd)}
            </span>
          </div>
          {source.quota.percent !== null && (
            <div className="h-2 overflow-hidden rounded-full bg-carbon-800" role="progressbar"
              aria-valuenow={Math.min(100, source.quota.percent)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-carbon-300"
                style={{ width: Math.min(100, source.quota.percent) + '%' }} />
            </div>
          )}
          <p className="text-[11px] text-carbon-500">
            {source.quota.percent === null
              ? 'Configure MANAGE_GITHUB_ACTIONS_INCLUDED_USD com o crédito do seu plano.'
              : source.quota.percent.toFixed(1) + '% do crédito de referência (não é o saldo faturado).'}
          </p>
        </div>
      )}
      {id === 'gcp' && <GcpBreakdown source={source} />}
      {id !== 'gcp' && <div className="space-y-0.5">
        {source.items.length ? byCostDescending(source.items).slice(0, 100).map((item, index) => (
          <div key={index} className="flex min-w-0 items-center justify-between gap-4 border-b border-carbon-800/60 py-2.5 last:border-0">
            <div className="min-w-0">
              <p className="break-words text-xs font-medium text-carbon-200">{item.name}</p>
              {item.detail && <p className="mt-0.5 break-words text-[11px] text-carbon-500">{item.detail}</p>}
            </div>
            <span className="shrink-0 text-right text-xs font-medium tabular-nums text-carbon-300">
              {item.cost !== null ? (id === 'cloudflare' ? '≈ ' : '') + money(item.cost, source.currency)
                : item.units !== null && item.units !== undefined ? item.units.toLocaleString('pt-BR') + ' req.' : 'Não medido'}
            </span>
          </div>
        )) : <Empty title="Nenhum lançamento no mês" />}
      </div>}
      {source.note && <p className="text-[11px] leading-5 text-carbon-500">{source.note}</p>}
      {source.url && <a className="inline-flex items-center gap-1 text-xs text-carbon-300 underline underline-offset-4"
        href={source.url} target="_blank" rel="noreferrer">Abrir no provedor <ExternalLink size={12} /></a>}
    </div>
  );
}

function TopSpenders({ data }: { data: CostsResponse }) {
  // The provider and GCP rankings are separate: never double-count GCP in the total.
  const providers: Array<{ name: string; amount: number }> = INFO.flatMap(({ id, label }) => {
    const amount = data.providers[id].status === 'ok' && data.providers[id].currency === 'USD'
      ? data.providers[id].total : null;
    return amount !== null && Number.isFinite(amount) && amount > 0
      ? [{ name: label, amount }] : [];
  }).sort((a, b) => b.amount - a.amount);
  const gcp = data.providers.gcp;
  const totals = new Map<string, number>();
  if (gcp.status === 'ok') {
    for (const item of gcp.items) {
      if (item.cost === null || !Number.isFinite(item.cost)) continue;
      totals.set(item.name, (totals.get(item.name) || 0) + item.cost);
    }
  }
  const services = [...totals].map(([name, amount]) => ({ name, amount }))
    .filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 8);
  const render = (entries: typeof providers, label: string) => {
    const max = Math.max(0, ...entries.map((item) => item.amount));
    return <div className="space-y-2">
      <h3 className="text-xs font-semibold text-carbon-300">{label}</h3>
      {entries.length ? entries.map((item, index) =>
        <div key={item.name} className="space-y-1.5 rounded-lg border border-carbon-800 p-2.5">
          <div className="flex items-start justify-between gap-3 text-xs">
            <span className="min-w-0 break-words text-carbon-200">
              <span className="mr-2 tabular-nums text-carbon-500">{index + 1}.</span>{item.name}
            </span>
            <strong className="shrink-0 tabular-nums text-carbon-100">{money(item.amount)}</strong>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-carbon-800" role="img"
            aria-label={item.name + ': ' + money(item.amount)}>
            <div className="h-full rounded-full bg-carbon-300"
              style={{ width: (max > 0 ? Math.max(0, item.amount / max * 100) : 0) + '%' }} />
          </div>
        </div>
      ) : <p className="text-xs text-carbon-500">Nenhum valor positivo disponível para este período.</p>}
    </div>;
  };
  return <Section title="Maiores gastos" detail="Ranking por custo líquido conhecido, do maior para o menor">
    <div className="grid gap-5 md:grid-cols-2">
      {render(providers, 'Por provedor')}
      {render(services, 'Serviços Google Cloud')}
    </div>
    <p className="mt-3 text-[11px] leading-5 text-carbon-500">
      Valores positivos em USD, sem estimar dados ausentes. O ranking GCP detalha o próprio Google Cloud,
      não é somado novamente ao ranking de provedores. Créditos podem tornar o custo líquido de um serviço negativo.
      A exportação do BigQuery pode ter atraso.
    </p>
  </Section>;
}

export function CostsPage() {
  const choices = useMemo(months, []);
  const [month, setMonth] = useState(choices[0].value);
  const costs = useQuery({
    queryKey: ['costs', month],
    queryFn: () => api<CostsResponse>('/costs?month=' + month),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: false,
  });
  const data = costs.data;
  const sortedProviders = data
    ? [...INFO].sort((a, b) => {
        const left = data.providers[a.id];
        const right = data.providers[b.id];
        const leftValue = left.status === 'ok' && left.total !== null && left.currency === 'USD' ? left.total : null;
        const rightValue = right.status === 'ok' && right.total !== null && right.currency === 'USD' ? right.total : null;
        if (leftValue === null) return rightValue === null ? 0 : 1;
        if (rightValue === null) return -1;
        return rightValue - leftValue;
      })
    : INFO;
  const available = data ? INFO.filter(({ id }) => data.providers[id]?.status === 'ok'
    && data.providers[id]?.total !== null).length : 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-carbon-400">Custos faturados e consumo estimado</p>
          <p className="mt-1 text-[11px] text-carbon-500">A cobrança de um workflow não é necessariamente o custo do deploy na nuvem.</p>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-carbon-500" />
          <Select aria-label="Mês dos custos" className="w-40" value={month} onChange={(event) => setMonth(event.target.value)}>
            {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </Select>
          <Button variant="ghost" size="icon" aria-label="Atualizar custos" onClick={() => void costs.refetch()}><RefreshCcw size={16} /></Button>
        </div>
      </div>
      {costs.isPending ? <Card className="flex justify-center p-10"><Spinner /></Card>
        : costs.error ? <IssueBanner error={costs.error} />
        : data && (
          <>
            <Card className="space-y-3 p-5 sm:p-6">
              <div className="flex items-center gap-2 text-xs text-carbon-400"><Wallet size={16} /> Total conhecido em USD</div>
              <p className="text-3xl font-semibold tracking-tight tabular-nums text-carbon-100">
                {data.total_usd === null ? 'Sem dados' : money(data.total_usd)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warning">Parcial, não é a fatura consolidada</Badge>
                <span className="text-xs text-carbon-500">{available} de 3 fontes com valores monetários disponíveis</span>
              </div>
              <p className="text-xs leading-5 text-carbon-500">
                {data.note} A somatória considera GitHub, GCP e Modal apenas quando suas moedas são USD;
                não inclui valores não informados, impostos ou conversões cambiais.
              </p>
            </Card>
            {data.alert && <Card className="space-y-2 p-4">
              <p className="text-sm font-medium">Alerta mensal GCP</p>
              <p className="text-xs text-carbon-400">{money(data.alert.actual_usd)} / {money(data.alert.threshold_usd)}</p>
              <Badge tone={data.alert.exceeded ? 'warning' : 'success'}>
                {data.alert.supported ? data.alert.exceeded ? 'Limite de aviso ultrapassado' : 'Abaixo do limite de aviso' : 'Moeda não comparável'}
              </Badge>
              <p className="text-[11px] text-carbon-500">Aviso visual, não bloqueia serviços nem substitui orçamento do Cloud Billing.</p>
            </Card>}
            <TopSpenders data={data} />
            <BillingAnalytics month={month} />
            <div className="grid gap-3 sm:grid-cols-2">
              {sortedProviders.map(({ id, label, icon: Icon, subtitle }) => {
                const source = data.providers[id];
                return (
                  <Card key={id} className="min-w-0 space-y-4 p-4 sm:p-5">
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-carbon-900 p-2"><Icon size={19} className="text-carbon-300" /></div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-carbon-100">{label}</p>
                        <p className="mt-0.5 text-xs leading-5 text-carbon-500">{subtitle}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {source.total !== null && source.status === 'ok' && <strong className="text-sm tabular-nums text-carbon-100">{money(source.total, source.currency)}</strong>}
                        <Badge tone={source.status === 'ok' ? 'success' : 'warning'}>
                          {source.status === 'ok' ? 'Conectado' : source.status === 'unconfigured' ? 'Configurar' : 'Indisponível'}
                        </Badge>
                      </div>
                    </div>
                    <SourceDetails id={id} source={source} />
                  </Card>
                );
              })}
            </div>
            <Section title="Custo por execução" detail="Estimativa bruta baseada no runner e nos minutos de cada job; descontos não atribuíveis por run">
              <Link to="/deploys" className="flex items-center justify-between rounded-xl border border-carbon-800 p-4 text-sm text-carbon-200 hover:bg-carbon-900">
                <span className="inline-flex items-center gap-2"><DollarSign size={16} /> Consultar workflows e durações</span>
                <ChevronRight size={16} />
              </Link>
            </Section>
            <p className="text-xs text-carbon-600">
              Dados consultados em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.checked_at))}.
            </p>
          </>
        )}
    </div>
  );
}
