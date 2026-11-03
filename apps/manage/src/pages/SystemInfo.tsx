import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { readLogLink, toLogSearch } from '../log-deeplink';
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
export function SystemInfo({ meta }: { meta: Meta }) {
  const [selectedJob, setSelectedJob] = useState('');
  const credentials = useQuery({
    queryKey: ['manage-credential-diagnostics'],
    queryFn: () =>
      api<{
        github_secret_version: string | null;
        checked_at: string;
        checks: Array<{
          provider: 'github' | 'cloudflare';
          check: string;
          ok: boolean;
          status: number;
          reason: string;
          hint: string;
          accepted_permissions?: string;
        }>;
      }>('/diagnostics'),
    enabled: false,
    retry: false,
    staleTime: 0,
  });
  const health = useQuery({
    queryKey: ['overview'],
    queryFn: () =>
      api<{ providers: string[]; provider_events?: Array<string | undefined>; correlation_id?: string }>(
        '/overview',
      ),
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
              [
                'Sentry · envio',
                meta.sentry ? 'DSN configurado · capturas habilitadas' : 'DSN não configurado',
                meta.sentry,
                true,
              ],
              [
                'Sentry · leitura',
                meta.sentry_reader ? 'Token de leitura configurado' : 'Token de leitura opcional ausente',
                Boolean(meta.sentry_reader),
                false,
              ],
            ] as Array<[string, string, boolean, boolean]>
          ).map(([name, detail, ok, verified]) => (
            <div key={name} className="flex items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{name}</p>
                <p className="break-words text-xs text-carbon-500">{detail}</p>
                {['GitHub', 'Cloudflare', 'Google Cloud'].includes(name) &&
                  health.data?.provider_events?.[['GitHub', 'Cloudflare', 'Google Cloud'].indexOf(name)] && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-rose-300">Evento Sentry gerado</span>
                      {sentryIssueSearch(health.data?.correlation_id) && (
                        <External href={sentryIssueSearch(health.data?.correlation_id)}>Ver exceção</External>
                      )}
                      <span className="text-carbon-600">
                        {
                          health.data?.provider_events?.[
                            ['GitHub', 'Cloudflare', 'Google Cloud'].indexOf(name)
                          ]
                        }
                      </span>
                    </div>
                  )}
              </div>
              <Badge tone={ok ? 'success' : 'warning'}>{ok ? 'OK' : verified ? 'Erro' : 'Pendente'}</Badge>
            </div>
          ))}
        </Card>
      </Section>
      <Section
        title="Diagnóstico de credenciais"
        detail="O próprio Worker testa os secrets instalados, sem expor ou receber tokens do navegador"
      >
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-carbon-400">
              GitHub: repositório, Actions e variável de ambiente; Cloudflare: Workers
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={credentials.isFetching}
              onClick={() => void credentials.refetch()}
            >
              {credentials.isFetching ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <RefreshCcw size={15} />
              )}
              Testar credenciais
            </Button>
          </div>
          {credentials.error && <IssueBanner error={credentials.error} />}
          {credentials.data && (
            <>
              <p className="text-xs text-carbon-500">
                GitHub · Secret Manager versão {credentials.data.github_secret_version || 'desconhecida'} ·
                Testado em {date(credentials.data.checked_at)}
              </p>
              <div className="divide-y divide-[#282a2e]">
                {credentials.data.checks.map((item) => (
                  <div key={item.provider + item.check} className="space-y-1 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">{item.check}</p>
                      <Badge tone={item.ok ? 'success' : 'danger'}>
                        {item.ok ? 'Acesso OK' : item.status ? 'HTTP ' + item.status : 'Falha'}
                      </Badge>
                    </div>
                    {!item.ok && <p className="text-xs leading-5 text-rose-200">{item.hint}</p>}
                    {item.accepted_permissions && (
                      <p className="break-words font-mono text-xs text-carbon-400">
                        Permissões exigidas: {item.accepted_permissions}
                      </p>
                    )}
                    {!item.ok && <p className="text-[11px] text-carbon-600">Diagnóstico: {item.reason}</p>}
                  </div>
                ))}
              </div>
              <p className="text-xs leading-5 text-carbon-500">
                Teste somente de leitura. A versão indica a referência usada no último deploy, não confirma o
                conteúdo do token. Nenhuma credencial é retornada.
              </p>
            </>
          )}
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
            <p className="text-sm text-carbon-400">{telegram.data?.explanation}</p>
            <div className="grid grid-cols-2 gap-2 text-xs text-carbon-400">
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
                <Server size={16} className="text-carbon-500" />
                <span className="min-w-0 flex-1 truncate text-sm">{j.name.split('/').pop()}</span>
                <span className="text-xs text-carbon-600">{date(j.updateTime)}</span>
                <ChevronRight size={14} className="text-carbon-600" />
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
                    <span className="truncate text-xs text-carbon-300">{e.name.split('/').pop()}</span>
                    <Badge tone={e.failedCount > 0 ? 'danger' : e.completionTime ? 'success' : 'info'}>
                      {e.failedCount > 0 ? 'Falhou' : e.completionTime ? 'Finalizado' : 'Executando'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-carbon-500">
                    {e.succeededCount || 0} concluídos · {e.runningCount || 0} executando ·{' '}
                    {e.failedCount || 0} falhas · {e.taskCount || 0} tarefas
                  </p>
                  <div className="mt-1 flex justify-between text-xs text-carbon-600">
                    <span>{date(e.createTime)}</span>
                    <Link
                      to="/logs"
                      search={toLogSearch(readLogLink(
                        '?source=gcp&search=' +
                          encodeURIComponent(selectedJob) +
                          '&at=' +
                          encodeURIComponent(e.createTime),
                      ))}
                      className="inline-flex items-center gap-1.5 text-carbon-300 underline-offset-4 hover:text-white hover:underline"
                    >
                      Logs no Manage
                    </Link>
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
                <History size={15} className="shrink-0 text-carbon-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{j.name.split('/').pop()}</p>
                  <p className="text-xs text-carbon-500">
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
                <Cloud size={16} className="text-carbon-500" />
                <span className="min-w-0 flex-1 truncate text-sm">{d.hostname}</span>
                <span className="truncate text-xs text-carbon-600">{d.service}</span>
              </div>
            ))}
          </Card>
        )}
      </Section>
      <div className="flex flex-wrap gap-4 text-xs">
        <External href="https://github.com/rodkisten/photointel/actions">GitHub Actions</External>
        <Link to="/logs" search={toLogSearch(readLogLink('?source=gcp'))} className="text-carbon-300 hover:underline">
          Logs GCP · Manage
        </Link>
        <Link
          to="/logs"
          search={toLogSearch(readLogLink('?source=cloudflare'))}
          className="text-carbon-300 hover:underline"
        >
          Logs Cloudflare · Manage
        </Link>
      </div>
    </div>
  );
}
