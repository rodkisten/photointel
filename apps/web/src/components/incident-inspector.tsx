import { useEffect, useState } from 'react';
import { ClipboardCopy, ExternalLink, RefreshCw } from 'lucide-react';
import { ApiError } from '../api/error';
import { request } from '../api/client';
import { diagnosticClipboardText, diagnosticLogsQuery, diagnosticLogsUrl } from '../lib/diagnostics';
import { useUi } from '../lib/store';
import { sentryEventUrl } from '../lib/sentry';
import { Dialog } from './ui/dialog';

interface LogEntry {
  timestamp: string | null;
  severity: string;
  service: string;
  event: string | null;
  status_code: number | null;
  error_code: string | null;
  reason: string | null;
  method: string | null;
  route_group: string | null;
  exception_type: string | null;
  job_type: string | null;
  job_id: string | null;
}
interface IncidentResponse {
  correlation_id: string;
  entries: LogEntry[];
  count: number;
  note: string;
}

function hint(error: Error | undefined, status: number | undefined): string {
  if (error instanceof ApiError) {
    const details = error.details;
    const reason = details && typeof details === 'object' && !Array.isArray(details) &&
      'reason' in details ? details.reason : undefined;
    if (reason === 'NO_ELIGIBLE_ASSETS')
      return 'As fotos solicitadas já estão na fila ou não podem ser processadas agora. Consulte os jobs pendentes antes de criar outro lote.';
    if (error.code === 'GPU_UNAVAILABLE')
      return 'A inferência precisa de GPU configurada. Desmarque JoyTag e SigLIP para processamentos locais.';
    if ([401, 403].includes(error.status))
      return 'Verifique sua sessão do Cloudflare Access e faça login novamente.';
    if (error.status === 409)
      return 'A operação conflitou com o estado atual dos dados. A mensagem e o motivo informados pela API aparecem abaixo.';
    if (error.status >= 500)
      return 'O servidor falhou. Veja os eventos correlacionados e, quando existir, a ocorrência no Sentry.';
    if (error.code === 'NETWORK_ERROR')
      return 'Não houve resposta HTTP. Verifique conectividade, Cloudflare Access e a disponibilidade da API.';
  }
  if (status === 409) return 'A operação foi recusada pelo servidor. Consulte o código e os eventos correlacionados.';
  return 'Os identificadores abaixo permitem investigar esta tentativa específica, sem expor dados das fotos.';
}

function copy(value: string) {
  void navigator.clipboard.writeText(value).catch(() => {
    console.warn('[PhotoIntel] A área de transferência não está disponível');
  });
}

function describe(value: unknown): string {
  if (value === undefined || value === null) return 'Não informado';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value, null, 2);
}

export function IncidentInspector() {
  const inspector = useUi((state) => state.inspector);
  const close = useUi((state) => state.closeInspector);
  const [data, setData] = useState<IncidentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const id = inspector?.incident.id;
  const source = inspector?.incident.source;

  useEffect(() => {
    setData(null);
    setLookupError(null);
    if (!id || source !== 'gcp') return;
    const abort = new AbortController();
    setLoading(true);
    void request<IncidentResponse>(`/v1/observability/incidents/${id}`, {
      signal: abort.signal,
    }).then((result) => {
      if (!abort.signal.aborted) setData(result);
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setLookupError(
        error instanceof Error ? error.message : 'Não foi possível consultar os registros',
      );
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); };
  }, [id, source]);

  if (!inspector) return null;
  const { incident, error } = inspector;
  const api = error instanceof ApiError ? error : null;
  const eventUrl = incident.eventId ? sentryEventUrl(incident.eventId) : undefined;
  const details = api?.details && typeof api.details === 'object'
    ? api.details : undefined;
  const fields: Array<[string, unknown]> = [
    ['Status HTTP', incident.status || (api?.status || 'Sem resposta')],
    ['Código', incident.code],
    ['Origem', incident.source === 'gcp' ? 'Cloud Run · API' : 'Cloudflare / navegador'],
    ['Método', api?.method],
    ['Rota', api?.path],
    ['Correlation ID', incident.id],
    ['Sentry Event ID', incident.eventId],
  ];
  const report = [
    diagnosticClipboardText(incident),
    ...(api ? ['Requisição: ' + [api.method, api.path].filter(Boolean).join(' ')] : []),
    'Descrição: ' + (api?.message || incident.message),
    ...(details ? ['Detalhes: ' + JSON.stringify(details)] : []),
    ...(data?.entries?.length ? ['Eventos: ' + JSON.stringify(data.entries)] : []),
  ].join('\n');

  return <Dialog open onOpenChange={(open) => !open && close()} title="Diagnóstico da ocorrência"
    description="Detalhes legíveis e registros relacionados à tentativa, sem abrir o console do provedor."
    className="incident-inspector">
    <div className="incident-inspector-body">
      <section className="incident-summary">
        <strong>{api?.message || incident.message || 'Falha detectada'}</strong>
        <p>{hint(error, incident.status)}</p>
      </section>
      <dl className="incident-fields">
        {fields.filter(([, value]) => value !== undefined && value !== null)
          .map(([label, value]) => <div key={label}>
            <dt>{label}</dt><dd>{describe(value)}</dd>
          </div>)}
      </dl>
      {details && <section className="incident-section">
        <h3>Motivo informado pela API</h3>
        <pre className="incident-json">{JSON.stringify(details, null, 2)}</pre>
      </section>}
      <section className="incident-section">
        <h3>Registros do Cloud Run</h3>
        {source !== 'gcp' ? <p className="muted">Falha do navegador ou da borda. Consulte o diagnóstico do Cloudflare.</p> :
          loading ? <p role="status" className="muted">Consultando eventos relacionados…</p> :
          lookupError ? <div className="incident-lookup-error" role="status">
            <p>Não foi possível recuperar os eventos: {lookupError}</p>
            <p>O erro original acima continua disponível para inspeção.</p>
          </div> :
          data?.entries.length ? <div className="incident-entries">
            {data.entries.map((entry, index) => <article className="incident-entry"
              key={entry.timestamp + ':' + index}>
              <div className="incident-entry-heading">
                <strong>{entry.event || entry.error_code || 'Evento'}</strong>
                <span>{entry.severity}</span>
              </div>
              <small>{entry.timestamp ? new Date(entry.timestamp).toLocaleString('pt-BR') : 'Sem data'}
                {' · '}{entry.service}</small>
              <dl className="incident-fields">
                {([
                  ['HTTP', entry.status_code], ['Código', entry.error_code],
                  ['Motivo', entry.reason], ['Método', entry.method],
                  ['Rota', entry.route_group], ['Exceção', entry.exception_type],
                  ['Job', entry.job_type], ['Job ID', entry.job_id],
                ] as Array<[string, string | number | null]>)
                  .filter(([, value]) => value !== null && value !== undefined)
                  .map(([label, value]) => <div key={label}>
                    <dt>{label}</dt><dd>{value}</dd>
                  </div>)}
              </dl>
            </article>)}
          </div> : <p className="muted">Nenhum evento correspondente nos últimos 14 dias.
            O erro pode ter ocorrido antes da publicação ou ainda não ter sido indexado.</p>}
      </section>
      <div className="incident-actions">
        <button type="button" onClick={() => copy(incident.id)}>
          <ClipboardCopy size={15} />Copiar ID
        </button>
        <button type="button" onClick={() => copy(report)}>
          <ClipboardCopy size={15} />Copiar relatório
        </button>
        {eventUrl && <a href={eventUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} />Abrir no Sentry</a>}
        {source === 'gcp' && <>
          <button type="button" onClick={() => copy(diagnosticLogsQuery(incident))}>
            <ClipboardCopy size={15} />Copiar filtro avançado
          </button>
          <a href={diagnosticLogsUrl(incident)} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} />Abrir Google Cloud</a>
        </>}
        <button type="button" onClick={() => close()}><RefreshCw size={15} />Voltar</button>
      </div>
      <p className="incident-help">O campo de busca rápida do Google Cloud aceita apenas texto.
        Para filtros avançados, use o editor de consultas, não a busca do topo.
        O inspetor acima dispensa ambas as etapas quando a API de logs está disponível.</p>
    </div>
  </Dialog>;
}
