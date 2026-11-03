import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCcw, Search } from 'lucide-react';
import { Badge, Button, Card, Input, Select } from '../components/ui';
import { JsonView } from '../components/json-view';
import { ScrollArea } from '../components/scroll-area';
import { External, Spinner, Empty, IssueBanner } from '../components/shared';
import { RunRow } from '../components/runs';
import { api } from '../lib/client';
import { date, cn, state } from '../lib/utils';
import type { CloudLog, CfLog, Issue, Run } from '../types';
import {
  apiLogParams,
  logLinkPath,
  primaryTerm,
  readLogLink,
  TERM,
  type LogLink,
  type LogSource,
} from '../log-deeplink';

type Source = LogSource;
type ResponseData = {
  items: Array<CloudLog | CfLog | Run | Issue>;
  console_url?: string;
  dashboard_url?: string;
  read_enabled?: boolean;
};
const TABS: Array<{ id: Source; label: string }> = [
  { id: 'gcp', label: 'GCP' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'github', label: 'Actions' },
  { id: 'sentry', label: 'Sentry' },
];

export function LogViewer() {
  const link = useSearch({ from: '/logs' });
  const navigate = useNavigate({ from: '/logs' });
  const [search, setSearch] = useState(() => primaryTerm(link));
  const [serverFilter, setServerFilter] = useState(() => primaryTerm(link));
  const [showStructured, setShowStructured] = useState(true);
  const source = link.source;
  const minutes = link.minutes;

  // Back/forward and deep links always restore the selected provider and filters.
  useEffect(() => {
    const term = primaryTerm(link);
    setSearch(term);
    setServerFilter(term);
  }, [link]);

  const updateLink = (next: LogLink) => {
    void navigate({ to: '/logs', search: next, replace: true });
  };

  const params = apiLogParams(link, serverFilter).toString();
  const q = useQuery<ResponseData>({
    queryKey: ['logs', source, params],
    queryFn: async () => {
      if (source === 'gcp') return api<ResponseData>('/gcp/logs?' + params);
      if (source === 'cloudflare') return api<ResponseData>('/cloudflare/logs?' + params);
      if (source === 'github') return api<ResponseData>('/runs');
      return api<ResponseData>('/sentry/issues');
    },
    refetchInterval: source === 'sentry' ? 60000 : 20000,
    retry: false,
  });
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const linkedTerms =
      serverFilter === primaryTerm(link)
        ? [link.correlation, link.job, link.ray, link.event, link.entry, link.search]
            .filter(Boolean)
            .map((term) => term.toLowerCase())
        : [];
    return (q.data?.items || []).filter((item) => {
      if (!needle) return true;
      const body = JSON.stringify(item).toLowerCase();
      return body.includes(needle) || linkedTerms.some((term) => body.includes(term));
    });
  }, [q.data, search, link, serverFilter]);
  const applyServerFilter = () => {
    const term = search.trim();
    if (term && !TERM.test(term)) return;
    if (term !== primaryTerm(link)) {
      updateLink({
        ...link,
        correlation: '',
        job: '',
        jobType: '',
        ray: '',
        event: '',
        entry: '',
        at: '',
        search: term,
      });
    }
    setServerFilter(term);
  };
  return (
    <div className="min-w-0 max-w-full space-y-4 overflow-x-hidden">
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-[#292b2f] bg-[#151618] p-1">
        {TABS.map(({ id, label }) => (
          <button
            type="button"
            key={id}
            onClick={() => {
              updateLink({
                ...link,
                source: id,
                correlation: '',
                job: '',
                jobType: '',
                ray: '',
                event: '',
                entry: '',
                at: '',
                search: '',
                minutes: '30',
              });
              setServerFilter('');
              setSearch('');
            }}
            aria-pressed={source === id}
            className={cn(
              'min-w-[70px] flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
              source === id ? 'bg-[#35373b] text-white' : 'text-carbon-500 hover:text-carbon-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {(link.correlation || link.job || link.ray || link.event || link.entry || link.at) && (
        <div className="rounded-lg border border-[#303238] bg-[#191b20] px-3 py-2 text-xs text-carbon-400">
          Investigação vinculada
          {link.correlation && <span className="ml-2 break-all">Correlação: {link.correlation}</span>}
          {link.job && <span className="ml-2 break-all">Job: {link.job}</span>}
          {link.ray && <span className="ml-2 break-all">Ray: {link.ray}</span>}
          {link.event && <span className="ml-2 break-all">Evento: {link.event}</span>}
          {link.entry && <span className="ml-2 break-all">Registro: {link.entry}</span>}
          {link.at && <span className="ml-2">Ocorrido em {date(link.at)} (±15 min)</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {(source === 'gcp' || source === 'cloudflare') && (
          <Select
            aria-label="Janela de tempo"
            className="w-[110px] shrink-0"
            value={minutes}
            onChange={(event) => updateLink({ ...link, minutes: event.target.value })}
          >
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="60">1 hora</option>
            <option value="240">4 horas</option>
            <option value="1440">24 horas</option>
            <option value="10080">7 dias</option>
          </Select>
        )}
        <div className="relative min-w-0 basis-full flex-1 sm:basis-[190px]">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-3 text-carbon-500" />
          <Input
            value={search}
            className="pl-8"
            placeholder="Correlation ID, job ID ou termo de log"
            aria-label="Buscar e destacar logs"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyServerFilter();
            }}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={applyServerFilter}
          disabled={
            source === 'github' || source === 'sentry' || (search.trim() !== '' && !TERM.test(search.trim()))
          }
        >
          Buscar no provedor
        </Button>
        <Button variant="outline" size="icon" aria-label="Atualizar logs" onClick={() => void q.refetch()}>
          <RefreshCcw size={16} />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-carbon-500">
        <span>
          {visible.length} de {q.data?.items?.length || 0} registros · busca destaca chaves e valores
        </span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showStructured}
            onChange={(event) => setShowStructured(event.target.checked)}
            className="accent-white"
          />{' '}
          Detalhes JSON
        </label>
      </div>
      {q.isPending ? (
        <Card className="p-6">
          <Spinner />
        </Card>
      ) : q.error ? (
        <IssueBanner error={q.error} />
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <ScrollArea className="h-[min(65vh,720px)] w-full">
            {source === 'sentry' && q.data?.read_enabled === false && (
              <div className="space-y-2 border-b border-[#282a2e] p-4 text-sm text-carbon-300">
                <p>
                  O DSN envia erros sem token adicional. Para listar issues, configure o token de leitura.
                </p>
                <External href={q.data.dashboard_url}>Abrir Sentry</External>
              </div>
            )}
            {visible.length === 0 && (
              <div className="p-5">
                <Empty
                  title="Nenhum registro correspondente"
                  detail="Altere o termo ou amplie a janela de tempo."
                />
              </div>
            )}
            {visible.map((raw, i) => {
              if (source === 'github') {
                const item = raw as Run;
                return (
                  <div key={item.id} className="border-b border-[#282a2e]">
                    <RunRow
                      run={item}
                      onSelect={() => window.open(item.html_url, '_blank', 'noopener,noreferrer')}
                    />
                    {showStructured && (
                      <details className="px-4 pb-3">
                        <summary className="cursor-pointer text-xs text-carbon-500">Dados JSON</summary>
                        <JsonView data={item} search={search} showSearch={false} maxHeight={300} />
                      </details>
                    )}
                  </div>
                );
              }
              if (source === 'sentry') {
                const item = raw as Issue;
                return (
                  <div key={item.id} className="space-y-2 border-b border-[#282a2e] px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone="danger">{item.level}</Badge>
                      <span className="text-xs text-carbon-500">{item.project}</span>
                    </div>
                    <p className="break-words text-sm font-medium">{item.title}</p>
                    <div className="flex justify-between text-xs text-carbon-500">
                      <span>
                        {item.count} eventos · {date(item.lastSeen)}
                      </span>
                      <External href={item.permalink}>Ver erro</External>
                    </div>
                    {showStructured && (
                      <details>
                        <summary className="cursor-pointer text-xs text-carbon-500">Dados JSON</summary>
                        <JsonView data={item} search={search} showSearch={false} maxHeight={300} />
                      </details>
                    )}
                  </div>
                );
              }
              const item = raw as CloudLog & CfLog;
              const heading = source === 'gcp' ? item.service || item.resource : item.service || item.outcome;
              return (
                <div
                  key={item.insertId || item.id || i}
                  className="min-w-0 space-y-2 border-b border-[#282a2e] px-3 py-3 sm:px-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-xs text-carbon-400">{heading}</span>
                    <Badge tone={state(item.severity === 'ERROR' ? 'error' : 'neutral')}>
                      {item.severity || 'LOG'}
                    </Badge>
                  </div>
                  <JsonView
                    data={item.message}
                    search={search}
                    showSearch={false}
                    maxHeight={340}
                    title={source === 'gcp' ? 'Cloud Logging · mensagem' : 'Cloudflare · mensagem'}
                  />
                  {showStructured && (
                    <details>
                      <summary className="cursor-pointer text-xs text-carbon-500">Metadados JSON</summary>
                      <JsonView
                        data={item}
                        search={search}
                        showSearch={false}
                        maxHeight={300}
                        title="Registro completo"
                      />
                    </details>
                  )}
                  {(item.insertId || item.id) && (
                    <a
                      href={logLinkPath({
                        ...link,
                        entry: String(item.insertId || item.id),
                        at: (() => {
                          const dateValue = new Date(item.timestamp);
                          return Number.isNaN(dateValue.getTime()) ? '' : dateValue.toISOString();
                        })(),
                      })}
                      className="inline-flex text-xs text-sky-300 underline underline-offset-4"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir este registro exato
                    </a>
                  )}
                  <p className="text-[11px] text-carbon-500">
                    {source === 'gcp'
                      ? date(item.timestamp)
                      : new Date(item.timestamp).toLocaleString('pt-BR')}
                  </p>
                </div>
              );
            })}
          </ScrollArea>
        </Card>
      )}
      <p className="text-xs leading-5 text-carbon-600">
        Mensagens são sanitizadas no servidor. JSON válido aparece em árvore; logs de texto permanecem
        selecionáveis, com busca destacada.
      </p>
    </div>
  );
}
