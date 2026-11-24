import {
  useQuery,
} from '@tanstack/react-query';
import {
  Cloud,
  GitBranch,
  RefreshCcw,
  Server,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Section,
} from '../components/ui';
import {
  api,
} from '../lib/client';
import {
  cn,
  date,
} from '../lib/utils';
import type {
  Run,
} from '../types';
import {
  Spinner,
  Empty,
  IssueBanner,
} from '../components/shared';
import {
  RunRow,
} from '../components/runs';
import type {
  RunCostsResponse,
} from '../components/run-cost';
export function Overview() {
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
  const ids = q.data?.runs.slice(0, 10).map((run) => run.id) || [];
  const estimates = useQuery({
    queryKey: ['run-costs', ids.join(',')],
    queryFn: () => api<RunCostsResponse>('/costs/runs?ids=' + ids.join(',')),
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
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
              <Icon size={19} className="text-carbon-300" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{name}</p>
                <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-amber-400')} />
              </div>
              <p className="mt-0.5 text-xs text-carbon-500">{ok ? sub : data.providers[i]}</p>
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
            data.runs.slice(0, 10).map((r) => (
              <RunRow key={r.id} run={r} estimate={estimates.data?.items[String(r.id)]} />
            ))
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
                  <Cloud size={15} className="text-carbon-500" />
                  <span className="min-w-0 flex-1 truncate text-sm">{w.name}</span>
                  <span className="text-xs text-carbon-600">{date(w.modified_on)}</span>
                </div>
              ))
            ) : (
              <div className="p-4 text-sm text-carbon-500">Sem dados do Cloudflare</div>
            )}
          </Card>
        </Section>
        <Section title="Serviços Cloud Run">
          <Card className="divide-y divide-[#282a2e]">
            {data.services.length ? (
              data.services.map((s) => (
                <div key={s.name} className="flex items-center gap-3 px-4 py-3">
                  <Server size={15} className="text-carbon-500" />
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
              <div className="p-4 text-sm text-carbon-500">Federação GCP não configurada ou sem serviços</div>
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}
