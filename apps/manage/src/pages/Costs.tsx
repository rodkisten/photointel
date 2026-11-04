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
  items: Array<{ name: string; cost: number | null; detail?: string; units?: number | null }>;
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
  note: string;
};

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

function SourceDetails({ source, id }: { source: CostSource; id: string }) {
  if (source.status !== 'ok') {
    return <p className="text-xs leading-5 text-carbon-400">{source.note || 'Fonte indisponível.'}</p>;
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
      <div className="space-y-0.5">
        {source.items.length ? source.items.slice(0, 100).map((item, index) => (
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
      </div>
      {source.note && <p className="text-[11px] leading-5 text-carbon-500">{source.note}</p>}
      {source.url && <a className="inline-flex items-center gap-1 text-xs text-carbon-300 underline underline-offset-4"
        href={source.url} target="_blank" rel="noreferrer">Abrir no provedor <ExternalLink size={12} /></a>}
    </div>
  );
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
            <div className="grid gap-3 sm:grid-cols-2">
              {INFO.map(({ id, label, icon: Icon, subtitle }) => {
                const source = data.providers[id];
                return (
                  <Card key={id} className="min-w-0 space-y-4 p-4 sm:p-5">
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-carbon-900 p-2"><Icon size={19} className="text-carbon-300" /></div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-carbon-100">{label}</p>
                        <p className="mt-0.5 text-xs leading-5 text-carbon-500">{subtitle}</p>
                      </div>
                      <Badge tone={source.status === 'ok' ? 'success' : 'warning'}>
                        {source.status === 'ok' ? 'Conectado' : source.status === 'unconfigured' ? 'Configurar' : 'Indisponível'}
                      </Badge>
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
