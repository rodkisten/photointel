import { Activity, ChevronDown, Cpu, FileSearch, Info, Pause, Play, Plus,
  ExternalLink, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiUrl, useAction, useApi } from '../api/client';
import type { Capabilities, Info as InfoData, Job, Page } from '../api/types';
import { DetailList, Empty, ErrorState, PageHeader, Skeleton, Status } from '../components/common';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { PreviewAuditDialog } from '../components/preview-audit';
import { date, items, number, obj, text } from '../lib/format';
import { useUi } from '../lib/store';
import { jobLogsUrl } from '../lib/diagnostics';
import { sentryEventUrl } from '../lib/sentry';

const jobNames: Record<string, string> = {
  icloud_discovery: 'Descoberta iCloud', media_download: 'Download da representação',
  metadata_extract: 'Extração de metadados', thumbnail_generate: 'Geração de prévias',
  hash_generate: 'Identidade de conteúdo', joytag_inference: 'Classificação JoyTag',
  embedding_inference: 'Embeddings SigLIP 2', duplicate_analysis: 'Análise de duplicadas',
  quality_analysis: 'Qualidade técnica', apple_sync: 'Apple Sync',
};
export function JobsPage() {
  const [status, setStatus] = useState(''); const [cursor, setCursor] = useState('');
  const [job, setJob] = useState<Job | null>(null); const [reindex, setReindex] = useState(false);
  const [previewAudit, setPreviewAudit] = useState(false);
  const [limit, setLimit] = useState(100); const [confirm, setConfirm] = useState(false);
  const [batchError, setBatchError] = useState<Error | null>(null);
  const [kinds, setKinds] = useState(['duplicate_analysis', 'quality_analysis']);
  const [live, setLive] = useState(false);
  const client = useQueryClient(); const action = useAction();
  const query = useApi<Page<Job>>(`/v1/jobs?limit=60&status=${status}&cursor=${cursor}`, 15_000);
  const batches = useApi<Page<InfoData>>('/v1/job-batches', 15_000);
  const stats = useApi<InfoData>('/v1/system/statistics', 15_000);
  const costs = useApi<InfoData>('/v1/system/costs', 30_000);
  const system = useApi<InfoData>('/v1/system/status', 30_000);
  const cap = useApi<Capabilities>('/v1/system/capabilities');
  const gpu = ['operational', 'test_only'].includes(cap.data?.gpu_inference?.state ?? '');
  useEffect(() => {
    if (!('EventSource' in window)) return;
    let eventId = ''; let source: EventSource | undefined;
    let stopped = false; let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleRefresh() {
      // Reconnection can replay hundreds of persisted events. Coalesce the burst
      // and let an in-flight request finish instead of restarting it per event.
      if (refreshTimer || stopped) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void client.invalidateQueries({ predicate: (query) =>
          String(query.queryKey[0]).startsWith('/v1/jobs') ||
          String(query.queryKey[0]).startsWith('/v1/job-batches') ||
          query.queryKey[0] === '/v1/system/statistics' }, { cancelRefetch: false });
      }, 500);
    }
    function connect() {
      source = new EventSource(apiUrl(`/v1/jobs/events${eventId ? `?after=${eventId}` : ''}`), { withCredentials: true });
      source.onopen = () => setLive(true);
      source.onerror = () => setLive(false);
      source.addEventListener('job', (event) => {
        eventId = (event as MessageEvent).lastEventId;
        scheduleRefresh();
      });
      source.addEventListener('reconnect', () => {
        source?.close(); if (!stopped) reconnectTimer = setTimeout(connect, 500);
      });
    }
    connect(); return () => {
      stopped = true; source?.close(); clearTimeout(reconnectTimer);
      clearTimeout(refreshTimer);
    };
  }, [client]);
  const counts = obj(stats.data?.job_counts);
  return <><PageHeader eyebrow="Operação contínua" title="Centro de processamento"
    description="Cada etapa persistida, com retomada segura e erros que podem ser inspecionados."
    actions={<><Button variant="outline" onClick={() => setPreviewAudit(true)}>
      <FileSearch size={14} />Buscar prévias com falha</Button>
      <Button onClick={() => { setBatchError(null); setReindex(true); }}>
        <Plus size={14} />Processar lote</Button></>} />
    <div className="metrics">{[
      ['Na fila', stats.data?.pending_processing], ['Em execução', counts.running ?? 0],
      ['Concluídos', counts.completed ?? 0], ['Falhas finais', counts.failed ?? 0],
    ].map(([label, value]) => <div className="metric" key={String(label)}><div className="metric-label">{String(label)}
      <Activity size={14} /></div><div className="metric-value">{number(value)}</div></div>)}</div>
    <div className="toolbar"><select className="input" style={{ width: 180 }} aria-label="Filtrar jobs por estado"
      value={status} onChange={(e) => { setStatus(e.target.value); setCursor(''); }}>
      <option value="">Todos os estados</option>{['queued','running','retrying','paused','completed','failed','cancelled'].map((state) =>
        <option key={state} value={state}>{({ queued:'Na fila', running:'Em execução',retrying:'Nova tentativa',paused:'Pausados',
          completed:'Concluídos',failed:'Falhas',cancelled:'Cancelados' } as Record<string,string>)[state]}</option>)}</select>
      <Button variant="ghost" size="sm" onClick={() => void query.refetch()}><RefreshCw size={13} />Atualizar</Button>
      <span className="toolbar-spacer" /><span className="muted">{live ? 'Eventos conectados · SSE' : 'Atualização periódica · 15 s'}</span></div>
    {!!batches.data?.items.length && <section className="panel" style={{ marginBottom: 20 }}><div className="panel-title">
      <h2>Lotes de processamento</h2><Cpu size={15} className="muted" /></div>
      {batches.data.items.slice(0, 5).map((batch) => {
        const total = Number(batch.total_assets ?? 0); const completed = Number(batch.completed ?? 0);
        const failed = Number(batch.failed ?? 0); const skipped = Number(batch.skipped ?? 0);
        const finished = completed + failed + skipped;
        return <div className="row-item" key={text(batch.id)}><div style={{ flex: 1 }}>
          <strong>{text(batch.name)}</strong><p>{number(completed)} concluídas · {number(failed)} falhas · {number(skipped)} ignoradas
            {total > 0 ? ` · ${number(total)} totais` : ' · descobrindo total'}</p>
          {total > 0 && <div className={`progress-track ${['running','queued','retrying'].includes(String(batch.status)) ? 'progress-active' : ''}`} role="progressbar" aria-label="Progresso persistido do lote"
            aria-valuenow={Math.min(finished, total)} aria-valuemin={0} aria-valuemax={total}>
            <div className="progress-fill" style={{ width: `${Math.min(100, finished / total * 100)}%` }} /></div>}</div>
          <Status value={batch.status} /><Button variant="outline" size="icon" aria-label={batch.status === 'paused' ? 'Retomar lote' : 'Pausar lote'}
            disabled={action.isPending || ['completed','failed','cancelled'].includes(text(batch.status))}
            onClick={() => action.mutate({ url: `/v1/job-batches/${batch.id}/${batch.status === 'paused' ? 'resume' : 'pause'}` })}>
            {batch.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}</Button></div>;
      })}</section>}
    {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <Skeleton /> :
      !query.data.items.length ? <Empty title="Fila tranquila" description="Jobs aparecerão após uma importação ou processamento manual." /> :
      <section className="panel"><div className="panel-title"><h2>Jobs persistidos</h2><span className="muted">Máximo de 60 por página</span></div>
        {query.data.items.map((item) => <div className="job-row" key={item.id}>
          <button className="job-name" onClick={() => setJob(item)} style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', color: 'inherit' }}>
            <span className="job-icon"><Activity size={15} /></span><span><strong>{jobNames[item.job_type] ?? item.job_type}</strong>
              <small>{item.id.slice(0, 8)} · tentativa {item.attempts}/{item.maximum_attempts}</small></span></button>
          <Status value={item.status} /><span className="job-duration muted">{item.started_at && item.finished_at ?
            `${number((new Date(item.finished_at).getTime() - new Date(item.started_at).getTime()) / 1000)} s` : '—'}</span>
          <div className="job-actions">{['failed','cancelled'].includes(item.status) ? <Button variant="ghost" size="icon"
            aria-label="Repetir job" disabled={action.isPending} onClick={() => action.mutate({ url: `/v1/jobs/${item.id}/retry` })}>
            <RotateCcw size={14} /></Button> : !['completed','cancelled'].includes(item.status) &&
            <Button variant="ghost" size="icon" aria-label="Cancelar job" disabled={action.isPending}
              onClick={() => action.mutate({ url: `/v1/jobs/${item.id}/cancel` })}><X size={14} /></Button>}
            <Button variant="ghost" size="icon" aria-label="Inspecionar job" onClick={() => setJob(item)}><ChevronDown size={14} /></Button></div>
        </div>)}{query.data.next_cursor && <div className="form-actions"><Button variant="outline"
          onClick={() => setCursor(query.data!.next_cursor!)}>Próxima página</Button></div>}</section>}
    <div className="two-columns" style={{ marginTop: 20 }}><section className="panel"><div className="panel-title"><h2>Ritmo e estimativas</h2></div>
      <DetailList data={{ throughput: `${number(stats.data?.jobs_per_second_last_hour)} jobs/s`,
        average: `${number(stats.data?.average_job_duration_seconds)} s`,
        remaining: stats.data?.estimated_remaining_seconds == null ? 'Sem amostra suficiente' :
          `${number(Number(stats.data.estimated_remaining_seconds) / 60)} min (estimativa)`,
        gpu: `${number(costs.data?.gpu_runtime_ms)} ms`, transferred: costs.data?.bytes_transferred,
        cost: `USD ${number(costs.data?.estimated_monthly_cost)} / mês (estimativa)`,
      }} labels={{ throughput:'Última hora',average:'Tempo médio',remaining:'Tempo restante',gpu:'Runtime GPU',transferred:'Bytes transferidos',cost:'Custo' }} />
      <p className="field-help">Estimativas da aplicação não limitam a cobrança do provedor.</p></section>
      <section className="panel"><div className="panel-title"><h2>Workers</h2></div>
        {items(system.data?.workers).length ? items(system.data?.workers).map((worker) => <div className="row-item" key={text(worker.id)}>
          <div><strong>{text(worker.id)}</strong><p>Último heartbeat: {date(worker.last_seen, true)}</p></div>
          <Status value={worker.healthy ? 'operational' : 'unavailable'} /></div>) :
          <p className="muted">Nenhum worker registrado. Inicie o serviço worker e verifique o banco.</p>}</section></div>
    <Dialog open={job !== null} onOpenChange={(open) => !open && setJob(null)} title="Inspeção do job">
      {job && <><Status value={job.status} /><DetailList data={{ id: job.id, type: jobNames[job.job_type],
        worker: job.worker_id, attempts: `${job.attempts}/${job.maximum_attempts}`, scheduled: date(job.scheduled_at,true),
        started: date(job.started_at,true), finished: date(job.finished_at,true), heartbeat: date(job.heartbeat_at,true),
      }} /><h3 style={{ margin: '20px 0 10px' }}>Progresso registrado</h3><pre className="code-block bounded-pre">{JSON.stringify(job.progress,null,2)}</pre>
      {job.error_code && <div className="job-error"><strong>{job.error_code}</strong>
        <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(job.error_details,null,2)}</pre>
        <div className="diagnostic-actions">
          {typeof job.error_details?.sentry_event_id === 'string' &&
            sentryEventUrl(job.error_details.sentry_event_id) && <a
              href={sentryEventUrl(job.error_details.sentry_event_id)} target="_blank"
              rel="noopener noreferrer"><ExternalLink size={14}/>Ver erro exato no Sentry</a>}
          <a href={jobLogsUrl(job.job_type, job.id,
            typeof job.error_details?.correlation_id === 'string' ? job.error_details.correlation_id : undefined)} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />Ver logs do job no GCP</a>
          <button type="button" onClick={() => void navigator.clipboard.writeText(
            `PhotoIntel job: ${job.id} · ${job.error_code}`)}>
            Copiar ID do job</button>
          <small>O link filtra os logs estruturados pelo ID do job e pelo correlation ID.
            Jobs antigos podem não ter identificadores nos logs.</small>
        </div></div>}</>}
    </Dialog>
    {previewAudit && <PreviewAuditDialog onClose={() => setPreviewAudit(false)} />}
    <Dialog open={reindex} onOpenChange={setReindex} title="Processar um lote"
      description="A IA só executa com adapter configurado e limites de custo aprovados. Nenhuma imagem é apagada.">
      <div className="stack"><label className="field">Limite de fotografias<input type="number" min="1" max="10000"
        value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
        {['joytag_inference','embedding_inference','duplicate_analysis','quality_analysis','thumbnail_generate'].map((kind) =>
          <label className="checkbox-field" key={kind}><span>{jobNames[kind]}
            {kind.endsWith('_inference') && !gpu && <small>GPU indisponível ou não configurada</small>}</span>
            <input type="checkbox" checked={kinds.includes(kind)} disabled={kind.endsWith('_inference') && !gpu}
              onChange={(e) => setKinds(e.target.checked ? [...kinds,kind] : kinds.filter((value) => value !== kind))} /></label>)}
        {limit > 100 && <label className="checkbox-field"><span>Confirmo reprocessar mais de 100 fotos</span>
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /></label>}
        <div className="notice"><Info size={14} />Estimativas e limites são verificados pelo servidor antes de criar os jobs.</div>
        {batchError && <ErrorState error={batchError} />}
      </div><div className="form-actions"><Button variant="outline" onClick={() => setReindex(false)}>Cancelar</Button>
        <Button disabled={action.isPending || !kinds.length || limit < 1 || limit > 10000 || (limit > 100 && !confirm)}
          onClick={async () => {
            setBatchError(null);
            try {
              await action.mutateAsync({ url:'/v1/jobs/reindex', body: {
                limit, job_types:kinds, confirm_large_batch:confirm,
              } });
            } catch (error) {
              // React Query already reports the precise ApiError to the toast.
              // Swallow this handled rejection so window.unhandledrejection cannot
              // overwrite it with a generic "Falha detectada" notification.
              setBatchError(error instanceof Error ? error : new Error('Falha ao criar lote'));
              return;
            }
            setReindex(false);
            useUi.getState().notify('Lote criado na fila durável.');
          }}>Criar lote</Button></div>
    </Dialog></>;
}
