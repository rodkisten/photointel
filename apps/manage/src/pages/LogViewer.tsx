import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, AlertCircle, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, Cloud, CloudCog, Code2, Copy, ExternalLink, GitBranch, History, LoaderCircle, Logs, Menu, Play, RefreshCcw, RotateCcw, Save, Search, Server, Settings2, Shield, Terminal, Workflow, X } from 'lucide-react';
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
export function LogViewer() {
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
              {data.read_enabled === false && (
                <div className="space-y-2 p-4 text-sm text-slate-300">
                  <p>O DSN envia as exceções sem token adicional. A leitura de issues dentro
                    do painel exige o token de leitura opcional.</p>
                  <External href={data.dashboard_url}>Abrir todos os erros no Sentry</External>
                </div>
              )}
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
              ) : data.read_enabled !== false ? (
                <div className="p-6">
                  <Empty title="Nenhum issue aberto" />
                </div>
              ) : null}
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
