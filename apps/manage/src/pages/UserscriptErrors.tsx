import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bug, ChevronRight, Clock3, Copy, RefreshCw } from 'lucide-react';
import { Card } from '../components/ui';
import { IssueBanner, Spinner } from '../components/shared';
import { useProject } from '../context/ProjectContext';
import { api } from '../lib/client';

type ErrorItem = {
  fingerprint: string; script: string; source: string; message: string; stack: string;
  url: string; request: { url?: string; method?: string; contentType?: string | null; body?: string | null; truncated?: boolean } | null;
  response: { status?: number | null; contentType?: string | null; durationMs?: number | null; body?: string | null; error?: string | null; truncated?: boolean } | null;
  count: number; firstSeen: string; lastSeen: string;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

function PayloadBlock({ title, value }: { title: string; value: unknown }) {
  if (value == null || value === '') return null;
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wider text-carbon-400">{title}</h3>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-carbon-800 bg-carbon-950 p-3 font-mono text-[11px] leading-relaxed text-carbon-200">{content}</pre>
  </section>;
}

export function UserscriptErrors() {
  const { project } = useProject();
  const [active, setActive] = useState('');
  const [search, setSearch] = useState('');
  const repository = project?.repository;
  const isUserscripts = repository === 'rodkisten/userscripts-cf';
  const query = useQuery({
    queryKey: ['userscript-errors', repository],
    queryFn: () => api<{ items: ErrorItem[] }>('/userscript-errors?repository=' + encodeURIComponent(repository!)),
    enabled: isUserscripts,
    retry: false,
    refetchInterval: 10_000,
  });
  const items = query.data?.items ?? [];
  const filtered = useMemo(() => items.filter(item => `${item.message} ${item.script} ${item.source} ${item.url}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const selected = filtered.find(item => item.fingerprint === active) ?? filtered[0];

  if (!isUserscripts) return <Card className="space-y-2 p-6">
    <h2 className="font-semibold text-carbon-100">Selecione userscripts</h2>
    <p className="text-sm text-carbon-400">Escolha <code>rodkisten/userscripts-cf</code> no seletor global para ver os erros enviados pelo runtime.</p>
  </Card>;
  if (query.isPending) return <Card className="flex justify-center p-12"><Spinner /></Card>;
  if (query.error) return <IssueBanner error={query.error} />;

  return <div className="grid min-h-[65vh] gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.6fr)]">
    <Card className="flex min-h-[60vh] flex-col overflow-hidden p-0">
      <div className="border-b border-carbon-800 p-4">
        <div className="flex items-center justify-between gap-2">
          <div><p className="text-sm font-semibold text-carbon-100">Issues</p><p className="mt-1 text-xs text-carbon-500">{items.length} eventos recentes · atualiza a cada 10 s</p></div>
          <button type="button" onClick={() => void query.refetch()} aria-label="Atualizar erros" className="rounded-lg border border-carbon-700 p-2 text-carbon-300 hover:bg-carbon-800"><RefreshCw size={15} /></button>
        </div>
        <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar mensagem, script ou URL" aria-label="Buscar erros" className="mt-3 w-full rounded-lg border border-carbon-800 bg-carbon-950 px-3 py-2 text-xs text-carbon-100 outline-none placeholder:text-carbon-600 focus:border-carbon-600" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? <p className="p-5 text-sm text-carbon-500">{items.length ? 'Nenhum erro corresponde à busca.' : 'Nenhum erro recebido ainda. O runtime envia novas ocorrências automaticamente.'}</p> : filtered.map(item => <button key={item.fingerprint} onClick={() => setActive(item.fingerprint)} className={`w-full border-b border-carbon-800/70 p-4 text-left transition-colors ${selected?.fingerprint === item.fingerprint ? 'bg-carbon-800/70' : 'hover:bg-carbon-900'}`}>
          <div className="flex items-start gap-3"><span className="mt-0.5 rounded-md bg-rose-500/10 p-1.5 text-rose-300"><Bug size={15} /></span><div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium text-carbon-100">{item.message}</p>
            <p className="mt-1 truncate font-mono text-[10px] text-carbon-500">{item.script} · {item.source}</p>
            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-carbon-500"><span className="flex items-center gap-1"><Clock3 size={11} />{formatDate(item.lastSeen)}</span><span className="rounded bg-carbon-800 px-1.5 py-0.5">{item.count}×</span></div>
          </div><ChevronRight size={15} className="mt-1 shrink-0 text-carbon-600" /></div>
        </button>)}
      </div>
    </Card>
    <Card className="min-w-0 space-y-5 p-4 sm:p-6">
      {!selected ? <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 text-center"><Bug size={28} className="text-carbon-600" /><p className="text-sm text-carbon-400">Selecione uma issue para inspecionar os detalhes.</p></div> : <>
        <header className="space-y-3 border-b border-carbon-800 pb-4">
          <div className="flex flex-wrap items-center gap-2"><span className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-rose-300">Error</span><span className="font-mono text-[10px] text-carbon-500">{selected.fingerprint}</span></div>
          <h2 className="break-words text-lg font-semibold text-carbon-100">{selected.message}</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-carbon-400"><span>Script: <b className="font-mono text-carbon-200">{selected.script}</b></span><span>Origem: <b className="font-mono text-carbon-200">{selected.source}</b></span><span>Ocorrências: <b className="text-carbon-200">{selected.count}</b></span></div>
          <p className="break-all font-mono text-[11px] text-sky-300">{selected.url || 'URL não informada'}</p>
          <p className="text-[10px] text-carbon-500">Primeira ocorrência: {formatDate(selected.firstSeen)} · Última: {formatDate(selected.lastSeen)}</p>
        </header>
        <PayloadBlock title="Stack trace" value={selected.stack || 'Stack trace indisponível'} />
        {selected.request && <section className="space-y-2"><h3 className="text-xs font-semibold uppercase tracking-wider text-carbon-400">Request</h3><div className="rounded-lg border border-carbon-800 bg-carbon-950 p-3"><p className="break-all font-mono text-xs text-sky-300">{selected.request.method || 'GET'} {selected.request.url || 'URL indisponível'}</p><p className="mt-1 text-[10px] text-carbon-500">{selected.request.contentType || 'content type indisponível'}</p></div><PayloadBlock title="Request body" value={selected.request.body} />{selected.request.truncated && <p className="text-[10px] text-amber-400">Corpo truncado no coletor.</p>}</section>}
        {selected.response && <section className="space-y-2"><h3 className="text-xs font-semibold uppercase tracking-wider text-carbon-400">Response {selected.response.status ? `· HTTP ${selected.response.status}` : ''}{selected.response.durationMs ? ` · ${selected.response.durationMs} ms` : ''}</h3><p className="text-[10px] text-carbon-500">{selected.response.contentType || ''}{selected.response.error ? ` · ${selected.response.error}` : ''}</p><PayloadBlock title="Response body" value={selected.response.body} />{selected.response.truncated && <p className="text-[10px] text-amber-400">Corpo truncado no coletor.</p>}</section>}
        <div className="flex justify-end"><button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(selected, null, 2))} className="inline-flex items-center gap-2 rounded-lg border border-carbon-700 px-3 py-2 text-xs text-carbon-300 hover:bg-carbon-800"><Copy size={13} />Copiar evento JSON</button></div>
      </>}
    </Card>
  </div>;
}
