import { AlertCircle, Camera, Check, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DiagnosticActions } from './error-boundary';
import { diagnosticFor } from '../lib/diagnostics';
import { ApiError, apiUrl } from '../api/client';
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
    <span>{toast.text}</span><button onClick={dismiss} aria-label="Dispensar aviso"><X size={16} /></button>
  </div>;
}
export function PrivateImage({ src, alt, className, onClick, priority = false }: {
  src: string | null | undefined; alt: string; className?: string;
  onClick?: () => void; priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setAttempt(0); }, [src]);
  if (!src || failed) return <div className={`image-unavailable ${className ?? ''}`}>
    <Camera size={22} /><span>{failed ? 'Prévia indisponível' : 'Prévia pendente'}</span>
    {src && <button onClick={(event) => { event.stopPropagation(); setFailed(false);
      setAttempt((value) => value + 1); }}>Recarregar</button>}</div>;
  return <img key={`${src}-${attempt}`} src={apiUrl(attempt ? `${src}?retry=${attempt}` : src)} crossOrigin="use-credentials"
    alt={alt} className={className} loading={priority ? 'eager' : 'lazy'}
    decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}
    onClick={onClick} draggable={false} />;
}


