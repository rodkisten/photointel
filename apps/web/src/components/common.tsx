import { AlertCircle, Camera, Check, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { DiagnosticActions } from './error-boundary';
import { diagnosticFor, reportDiagnostic } from '../lib/diagnostics';
import type { Diagnostic } from '../lib/diagnostics';
import { responseError } from '../api/error';
import { ApiError, apiUrl, json, request } from '../api/client';
import { statusLabel, text } from '../lib/format';
import { useUi } from '../lib/store';
import { Button } from './ui/button';
import type { Info } from '../api/types';

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string; title: string; description?: string; actions?: ReactNode;
}) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p>
    <h1>{title}</h1>{description && <p className="muted page-description">{description}</p>}
  </div>{actions && <div className="header-actions">{actions}</div>}</header>;
}
export function Status({ value }: { value: unknown }) {
  const status = String(value ?? 'unknown');
  return <span className={`status status-${status}`}><i />{statusLabel(status)}</span>;
}
export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  const incident = useMemo(() => diagnosticFor(error, 'api'), [error]);
  return <div className="error-state" role="alert"><AlertCircle size={20} />
    <div><strong>Não foi possível concluir</strong><p>{error.toString()}</p>
      <DiagnosticActions incident={incident} />
      {error instanceof ApiError && <details><summary>Detalhes do erro</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {JSON.stringify(error, null, 2)}
        </pre></details>}</div>
    {retry && <Button variant="outline" onClick={retry}><RefreshCw size={15} />
      Tentar novamente</Button>}
    {error instanceof ApiError && [401, 403].includes(error.status) &&
      <Button onClick={() => window.location.assign('/auth/login')}>Entrar novamente</Button>}
  </div>;
}
export function Empty({ title, description, action }: {
  title: string; description: string; action?: ReactNode;
}) {
  return <div className="empty-state"><div className="empty-icon"><Camera size={27} /></div>
    <h2>{title}</h2><p>{description}</p>{action}</div>;
}
export function Skeleton({ count = 4 }: { count?: number }) {
  return <div className="skeleton-group" aria-label="Carregando" role="status">
    {Array.from({ length: count }, (_, index) => <div className="skeleton" key={index} />)}
  </div>;
}
export function DetailList({ data, labels = {} }: { data: Info; labels?: Record<string, string> }) {
  return <dl className="detail-list">{Object.entries(data).filter(([, value]) =>
    value !== null && value !== undefined).map(([key, value]) => <div key={key}>
    <dt>{labels[key] ?? key.replaceAll('_', ' ')}</dt><dd>{text(value)}</dd>
  </div>)}</dl>;
}
export function Toast() {
  const toast = useUi((state) => state.toast);
  const dismiss = useUi((state) => state.dismiss);
  useEffect(() => { if (toast) { const timer = setTimeout(dismiss, 7000);
    return () => clearTimeout(timer); } }, [toast, dismiss]);
  if (!toast) return null;
  return <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
    {toast.kind === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}
    <div className="toast-message"><span>{toast.text}</span>
      {toast.kind === 'error' && toast.incident && <DiagnosticActions incident={toast.incident} />}
    </div><button onClick={dismiss} aria-label="Dispensar aviso"><X size={16} /></button>
  </div>;
}
export function PrivateImage({ src, alt, className, onClick, priority = false, assetId }: {
  src: string | null | undefined; alt: string; className?: string;
  onClick?: () => void; priority?: boolean; assetId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [variant, setVariant] = useState(0);
  const [diagnosing, setDiagnosing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [incident, setIncident] = useState<Diagnostic | null>(null);
  const candidates = useMemo(() => {
    if (!src) return [];
    const result = [src];
    const match = src.match(/^(\/v1\/assets\/[0-9a-f-]{16,}\/media\/)(preview_large|thumbnail_medium)$/i);
    if (match) {
      if (match[2] === 'preview_large') result.push(match[1] + 'thumbnail_medium');
      result.push(match[1] + 'thumbnail_small');
    }
    return result;
  }, [src]);
  useEffect(() => {
    setFailed(false); setVariant(0); setAttempt(0); setIncident(null);
  }, [src]);
  const current = candidates[Math.min(variant, candidates.length - 1)];
  async function diagnose(event: MouseEvent) {
    event.stopPropagation();
    setDiagnosing(true);
    try {
      if (!current) throw new ApiError('Prévia ainda não gerada', 404,
        'PREVIEW_NOT_GENERATED', undefined, { source: 'gcp' });
      const response = await fetch(apiUrl(current), {
        method: 'GET', credentials: 'include', cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      });
      if (!response.ok) throw await responseError(response, current, 'GET');
      // A valid HTTP response with invalid browser image bytes is not an API 404.
      throw new ApiError('Prévia retornada, mas o navegador não conseguiu decodificá-la',
        response.status, 'MEDIA_RENDER_FAILED',
        response.headers.get('X-Correlation-ID') ?? undefined,
        { source: 'gcp', method: 'GET', path: current });
    } catch (error) {
      setIncident(reportDiagnostic(error, 'api'));
    } finally { setDiagnosing(false); }
  }
  async function repair(event: MouseEvent) {
    event.stopPropagation();
    if (!assetId || !/^[a-f0-9-]{36}$/i.test(assetId)) return;
    setRepairing(true);
    try {
      await request('/v1/jobs/reindex', json('POST', {
        asset_ids: [assetId], limit: 1, job_types: ['thumbnail_generate'],
      }));
      useUi.getState().notify('Reprocessamento da prévia enfileirado.');
      setIncident(null);
    } catch (error) { setIncident(reportDiagnostic(error, 'api')); }
    finally { setRepairing(false); }
  }
  if (!src || failed) return <div className={`image-unavailable ${className ?? ''}`}>
    <Camera size={22} />
    <span>{failed ? 'Prévia indisponível' : 'Prévia pendente'}</span>
    {src && <button type="button" onClick={(event) => { event.stopPropagation();
      setFailed(false); setVariant(0); setIncident(null);
      setAttempt((value) => value + 1); }}>Recarregar</button>}
    {assetId && <button type="button" disabled={repairing} onClick={(event) => void repair(event)}>
      {repairing ? 'Enfileirando…' : 'Reprocessar'}</button>}
    <button type="button" disabled={diagnosing} onClick={(event) => void diagnose(event)}>
      {diagnosing ? 'Consultando…' : 'Ver erro'}</button>
    {incident && <div className="preview-diagnostic" onClick={(event) => event.stopPropagation()}>
      <strong>{incident.code}</strong><DiagnosticActions incident={incident} />
    </div>}
  </div>;
  const url = attempt ? `${current}${current.includes('?') ? '&' : '?'}retry=${attempt}` : current;
  return <img key={`${url}-${variant}`} src={apiUrl(url)}
    crossOrigin="use-credentials" alt={alt} className={className}
    loading={priority ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer"
    onError={() => { if (variant + 1 < candidates.length) setVariant((n) => n + 1);
      else setFailed(true); }}
    onClick={onClick} draggable={false} />;
}
