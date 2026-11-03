import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Apple, ArrowUpRight, RefreshCcw, ShieldAlert, ShieldCheck, TestTube } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Section } from '../components/ui';
import { IssueBanner, Spinner } from '../components/shared';
import { ICloudLoginForm } from '../components/icloud-login-form';
import { api, send } from '../lib/client';
import { date } from '../lib/utils';

type Finding = {
  checked_at: string;
  configuration: { project: string; region: string };
  apple_probe: 'not_performed';
  apple_session: 'unknown';
  recent_events: Array<{ timestamp?: string; service?: string; severity?: string; message?: string }>;
  preflight_runs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion?: string;
    created_at?: string;
    html_url?: string;
  }>;
  suggest_reauth: boolean;
  reason: string;
};

export function ICloudDiagnostics() {
  const qc = useQueryClient();
  const [started, setStarted] = useState(false);
  const q = useQuery({
    queryKey: ['icloud-diagnostics'],
    queryFn: () => api<Finding>('/icloud/diagnostics'),
    retry: false,
    refetchInterval: 60_000,
  });
  const preflight = useMutation({
    mutationFn: () =>
      send('/dispatch', { workflow: 'icloud-setup.yml', inputs: {}, confirm: 'DEPLOY icloud-setup.yml' }),
    onSuccess: () => {
      setStarted(true);
      void qc.invalidateQueries({ queryKey: ['icloud-diagnostics'] });
    },
  });
  return (
    <div className="space-y-5">
      <ICloudLoginForm onConnected={() => void qc.invalidateQueries({ queryKey: ['icloud-diagnostics'] })} />
      <Card className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Apple size={20} className="mt-1 shrink-0 text-slate-300" />
          <div className="space-y-2">
            <h2 className="text-base font-semibold">Conexão iCloud e sessão Apple</h2>
            <p className="text-sm leading-6 text-slate-400">
              Você pode digitar a senha e concluir a verificação Apple diretamente acima. O diagnóstico
              abaixo também consulta logs recentes, pré-requisitos da infraestrutura e testes de conectividade.
              A sessão só é publicada depois de confirmar o acesso à biblioteca.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCcw size={15} className={q.isFetching ? 'animate-spin' : ''} /> Atualizar diagnóstico
          </Button>
          <Button size="sm" onClick={() => preflight.mutate()} disabled={preflight.isPending}>
            <TestTube size={15} /> Testar infraestrutura iCloud
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="https://photos.migos.club/icloud?test=1" target="_blank" rel="noopener noreferrer">
              <TestTube size={15} /> Testar sessão Apple ao vivo <ArrowUpRight size={14} />
            </a>
          </Button>
        </div>
        {started && (
          <p className="text-xs text-emerald-300">
            Preflight solicitado ao GitHub Actions. A execução não faz login na Apple.
          </p>
        )}
        {preflight.error && <IssueBanner error={preflight.error} />}
      </Card>
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <IssueBanner error={q.error} />
      ) : (
        q.data && (
          <>
            <Section title="Autenticação e recuperação" detail={'Última leitura ' + date(q.data.checked_at)}>
              <Card className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <strong className="text-sm">Estado da sessão Apple</strong>
                  <Badge tone="warning">Não verificado diretamente</Badge>
                </div>
                {q.data.suggest_reauth ? (
                  <p className="flex items-start gap-2 text-sm text-amber-300">
                    <ShieldAlert size={17} className="shrink-0" /> {q.data.reason}
                  </p>
                ) : (
                  <p className="flex items-start gap-2 text-sm text-slate-400">
                    <ShieldCheck size={17} className="shrink-0" /> {q.data.reason}
                  </p>
                )}
                <p className="text-xs leading-5 text-slate-400">
                  Use o formulário de senha e código Apple no topo desta página para renovar a sessão,
                  sem terminal. Se houver erro, confira os logs correlacionados abaixo.
                </p>
                <a
                  href="https://photos.migos.club/icloud"
                  className="text-sm text-sky-300 underline underline-offset-4"
                >
                  Ver status e importações no PhotoIntel
                </a>
              </Card>
            </Section>
            <Section
              title="Erros de iCloud recentes"
              detail="Eventos do Cloud Logging, sem credenciais nem dados privados"
            >
              <Card className="divide-y divide-slate-800">
                {q.data.recent_events.length === 0 ? (
                  <p className="p-4 text-sm text-slate-400">
                    Nenhum evento correspondente neste período. Isso não comprova que o acesso esteja válido.
                  </p>
                ) : (
                  q.data.recent_events.map((event, index) => (
                    <div key={event.timestamp + ':' + index} className="space-y-2 p-3 text-xs">
                      <span className="text-slate-400">{date(event.timestamp)}</span>
                      <p className="break-all text-slate-200">
                        {event.message || event.severity || event.service || 'Evento sem descrição'}
                      </p>
                    </div>
                  ))
                )}
                <div className="p-3">
                  <a
                    className="text-sm text-sky-300 underline"
                    href="/?tab=logs&source=gcp&search=icloud&minutes=1440"
                  >
                    Investigar nos logs do Manage
                  </a>
                </div>
              </Card>
            </Section>
            <Section
              title="Preflight e validações"
              detail="Verificações de infraestrutura e código, não substituem login na Apple"
            >
              <Card className="divide-y divide-slate-800">
                {q.data.preflight_runs.length === 0 && (
                  <p className="p-3 text-sm text-slate-400">Nenhuma validação recente.</p>
                )}
                {q.data.preflight_runs.map((run) => (
                  <a
                    href={run.html_url}
                    key={run.id}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 p-3 text-sm hover:bg-white/5"
                  >
                    <span className="min-w-0 truncate">{run.name}</span>
                    <Badge
                      tone={
                        run.conclusion === 'success'
                          ? 'success'
                          : run.conclusion === 'failure'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {run.conclusion || run.status}
                    </Badge>
                  </a>
                ))}
              </Card>
            </Section>
          </>
        )
      )}
    </div>
  );
}
