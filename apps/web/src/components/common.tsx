import { AlertCircle, Camera, Check, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import { DiagnosticActions } from './error-boundary';
import { diagnosticFor, reportDiagnostic, type Diagnostic } from '../lib/diagnostics';
import { responseError } from '../api/error';
import { ApiError, apiUrl, json, request } from '../api/client';
import { statusLabel, text } from '../lib/format';
import { useUi } from '../lib/store';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import type { Info } from '../api/types';

// ==========================================
// Tipos & Interfaces
// ==========================================

export interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export interface EmptyProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export interface DetailListProps {
  data: Info;
  labels?: Record<string, string>;
}

export interface PrivateImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  onClick?: () => void;
  priority?: boolean;
  assetId?: string;
  sizes?: string;
}

export interface PreviewState {
  status: 'ready' | 'processing' | 'queued' | 'failed' | 'source_pending' | 'preview_missing';
  ingestion_status: string;
  available_variants: string[];
  message: string;
  job: {
    id: string;
    type: string;
    status: string;
    attempts: number;
    max_attempts: number;
    error_code: string | null;
    scheduled_at: string | null;
    created_at: string | null;
  } | null;
  worker_dispatch: { status: string; error_code: string | null } | null;
}

// ==========================================
// Componentes de Layout Genéricos
// ==========================================

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="muted page-description">{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

export function Status({ value }: { value: unknown }) {
  const status = String(value ?? 'unknown');
  return (
    <span className={`status status-${status}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}

export function Empty({ title, description, action }: EmptyProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Camera size={27} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-group" aria-label="Carregando" role="status">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton" key={index} />
      ))}
    </div>
  );
}

export function DetailList({ data, labels = {} }: DetailListProps) {
  return (
    <dl className="detail-list">
      {Object.entries(data)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => (
          <div key={key}>
            <dt>{labels[key] ?? key.replaceAll('_', ' ')}</dt>
            <dd>{text(value)}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Toast() {
  const toast = useUi((state) => state.toast);
  const dismiss = useUi((state) => state.dismiss);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(dismiss, toast.kind === 'error' ? 30_000 : 5_000);
      return () => clearTimeout(timer);
    }
  }, [toast, dismiss]);

  if (!toast) return null;

  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.kind === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}
      <div className="toast-message">
        <span>{toast.text}</span>
        {toast.kind === 'error' && toast.incident && (
          <DiagnosticActions incident={toast.incident} error={toast.error} />
        )}
      </div>
      <button onClick={dismiss} aria-label="Dispensar aviso">
        <X size={16} />
      </button>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  const incident = useMemo(() => diagnosticFor(error, 'api'), [error]);
  const isAuthError = error instanceof ApiError && [401, 403].includes(error.status);

  return (
    <div className="error-state" role="alert">
      <AlertCircle size={20} />
      <div>
        <strong>Não foi possível concluir</strong>
        <p>{error.toString()}</p>
        <DiagnosticActions incident={incident} error={error} />
        {error instanceof ApiError && (
          <details>
            <summary>Detalhes do erro</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(error, null, 2)}
            </pre>
          </details>
        )}
      </div>
      
      {retry && (
        <Button variant="outline" onClick={retry}>
          <RefreshCw size={15} />
          Tentar novamente
        </Button>
      )}
      
      {isAuthError && (
        <Button onClick={() => window.location.assign('/auth/login')}>
          Entrar novamente
        </Button>
      )}
    </div>
  );
}

// ==========================================
// Componentes de Imagem Privada
// ==========================================

/**
 * Diálogo isolado para lidar com polling de status, diagnóstico 
 * e reparo de imagens, aliviando o estado de renderização da PrivateImage.
 */
function PreviewDiagnosticDialog({
  assetId,
  originalSrc,
  currentUrl,
  open,
  onOpenChange,
  onReload,
  onOverrideSrc,
}: {
  assetId?: string;
  originalSrc?: string | null;
  currentUrl?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReload: () => void;
  onOverrideSrc: (newSrc: string) => void;
}) {
  const [diagnosing, setDiagnosing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [incident, setIncident] = useState<Diagnostic | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);

  // Polling Effect - Só executa quando o dialog está aberto
  useEffect(() => {
    if (!open || !assetId || !/^[a-f0-9-]{36}$/i.test(assetId)) return;
    
    let cancelled = false;
    
    const refresh = async () => {
      try {
        const state = await request<PreviewState>(`/v1/jobs/assets/${assetId}/preview`);
        if (cancelled) return;
        
        setPreviewState(state);
        
        if (state.status === 'ready') {
          onOverrideSrc(`/v1/assets/${assetId}/media/thumbnail_medium`);
        }
      } catch (error) {
        if (!cancelled) {
          setLastError(error instanceof Error ? error : new Error('Falha na consulta'));
          setIncident(reportDiagnostic(error, 'api'));
        }
      }
    };
    
    void refresh();
    const timer = setInterval(refresh, 8000);
    
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, assetId, onOverrideSrc]);

  async function diagnose(event: MouseEvent) {
    event.stopPropagation();
    setDiagnosing(true);
    try {
      if (assetId && /^[a-f0-9-]{36}$/i.test(assetId)) {
        const latest = await request<{
          found: boolean;
          sentry_event_id: string | null;
          correlation_id: string | null;
          error_code: string | null;
        }>(`/v1/observability/assets/${assetId}/latest-error`);
        
        if (latest.found && latest.sentry_event_id) {
          throw new ApiError(
            'Falha registrada no worker de processamento',
            500,
            latest.error_code || 'MEDIA_PROCESSING_FAILED',
            latest.correlation_id || undefined,
            { source: 'gcp', eventId: latest.sentry_event_id, method: 'GET', path: '/v1/observability/assets/latest-error' }
          );
        }
      }
      
      if (!currentUrl) {
        throw new ApiError('Prévia ainda não gerada', 404, 'PREVIEW_NOT_GENERATED', undefined, { source: 'gcp' });
      }

      const response = await fetch(apiUrl(currentUrl), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      });
      
      if (!response.ok) throw await responseError(response, currentUrl, 'GET');
      
      throw new ApiError(
        'Prévia retornada, mas o navegador não conseguiu decodificá-la',
        response.status,
        'MEDIA_RENDER_FAILED',
        response.headers.get('X-Correlation-ID') ?? undefined,
        { source: 'gcp', method: 'GET', path: currentUrl }
      );
    } catch (error) {
      setLastError(error instanceof Error ? error : new Error('Falha no diagnóstico'));
      setIncident(reportDiagnostic(error, 'api'));
    } finally {
      setDiagnosing(false);
    }
  }

  async function repair(event: MouseEvent) {
    event.stopPropagation();
    if (!assetId || !/^[a-f0-9-]{36}$/i.test(assetId)) return;
    
    setRepairing(true);
    try {
      const result = await request<{ created: boolean; status: string; message: string }>(
        `/v1/jobs/assets/${assetId}/preview/repair`,
        json('POST')
      );
      setPreviewMessage(result.message);
      setIncident(null);
      setLastError(null);
      
      const state = await request<PreviewState>(`/v1/jobs/assets/${assetId}/preview`);
      setPreviewState(state);
    } catch (error) {
      setPreviewMessage(null);
      setLastError(error instanceof Error ? error : new Error('Falha no reparo'));
      setIncident(reportDiagnostic(error, 'api'));
    } finally {
      setRepairing(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Prévia da fotografia"
      description={
        originalSrc
          ? 'Não foi possível carregar a imagem. Confira os detalhes ou tente recuperar a prévia.'
          : 'A prévia ainda não foi disponibilizada pelo processamento.'
      }
    >
      <div className="stack">
        {originalSrc && (
          <Button variant="outline" onClick={onReload}>
            <RefreshCw size={15} /> Recarregar imagem
          </Button>
        )}
        
        {assetId && (
          <Button
            variant="outline"
            disabled={repairing || previewState?.status === 'processing'}
            onClick={repair}
          >
            <RefreshCw size={15} />
            {repairing ? 'Enfileirando…' : 'Solicitar reparo da prévia'}
          </Button>
        )}
        
        {originalSrc && (
          <Button variant="ghost" disabled={diagnosing} onClick={diagnose}>
            {diagnosing ? 'Consultando…' : 'Inspecionar erro de mídia'}
          </Button>
        )}
        
        {previewState && (
          <div className="preview-repair-state" role="status">
            <strong>{previewState.message}</strong>
            <dl>
              <dt>Importação</dt>
              <dd>{previewState.ingestion_status}</dd>
              {previewState.job && (
                <>
                  <dt>Job</dt>
                  <dd>{previewState.job.type} · {previewState.job.status}</dd>
                  <dt>Tentativas</dt>
                  <dd>{previewState.job.attempts}/{previewState.job.max_attempts}</dd>
                  {previewState.job.error_code && (
                    <>
                      <dt>Última falha</dt>
                      <dd>{previewState.job.error_code}</dd>
                    </>
                  )}
                  {previewState.job.scheduled_at && (
                    <>
                      <dt>Agendado</dt>
                      <dd>{new Date(previewState.job.scheduled_at).toLocaleString('pt-BR')}</dd>
                    </>
                  )}
                </>
              )}
              {previewState.worker_dispatch && (
                <>
                  <dt>Despacho do worker</dt>
                  <dd>
                    {previewState.worker_dispatch.status}
                    {previewState.worker_dispatch.error_code && ` · ${previewState.worker_dispatch.error_code}`}
                  </dd>
                </>
              )}
            </dl>
            {previewMessage && <p>{previewMessage}</p>}
          </div>
        )}
        
        {incident && (
          <div className="preview-diagnostic">
            <strong>{incident.code}</strong>
            {lastError && <p>{lastError.message}</p>}
            <DiagnosticActions incident={incident} error={lastError ?? undefined} />
          </div>
        )}
        
        <p className="muted">
          O reparo desperta um job existente ou cria somente a etapa faltante. O status é atualizado
          automaticamente enquanto este painel estiver aberto.
        </p>
      </div>
    </Dialog>
  );
}

export function PrivateImage({
  src,
  alt,
  className,
  onClick,
  priority = false,
  assetId,
  sizes,
}: PrivateImageProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [variant, setVariant] = useState(0);
  const [overrideSrc, setOverrideSrc] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  // Calcula os candidatos de imagem dependendo se há um override.
  const candidates = useMemo(() => {
    const effective = overrideSrc ?? src;
    if (!effective) return [];
    
    const result = [effective];
    const match = effective.match(
      /^(\/v1\/assets\/[0-9a-f-]{16,}\/media\/)(preview_large|thumbnail_medium)(\?[^#]*)?$/i
    );
    
    if (match) {
      const query = match[3] ?? '';
      if (match[2] === 'preview_large') result.push(match[1] + 'thumbnail_medium' + query);
      result.push(match[1] + 'thumbnail_small' + query);
    }
    
    return result;
  }, [src, overrideSrc]);

  // Reseta estado interno de renderização quando a props src originária muda
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setVariant(0);
    setAttempt(0);
    setOverrideSrc(null);
  }, [src]);

  const current = candidates[Math.min(variant, candidates.length - 1)];

  // Se não tem source válido ou falhou em todas as instâncias, mostra estado ausente.
  if (!(overrideSrc ?? src) || failed) {
    return (
      <div className={`image-unavailable ${className ?? ''}`.trim()}>
        <Camera size={16} aria-hidden="true" />
        <span>{failed ? 'Prévia indisponível' : 'Prévia pendente'}</span>
        
        <button
          type="button"
          className="preview-action-button"
          aria-label="Ações da prévia"
          onClick={(event) => {
            event.stopPropagation();
            setActionsOpen(true);
          }}
        >
          <MoreHorizontal size={16} />
        </button>

        <div onClick={(e) => e.stopPropagation()}>
          <PreviewDiagnosticDialog 
            open={actionsOpen}
            onOpenChange={setActionsOpen}
            assetId={assetId}
            originalSrc={src}
            currentUrl={current}
            onReload={() => {
              setFailed(false);
              setVariant(0);
              setAttempt((value) => value + 1);
              setActionsOpen(false);
            }}
            onOverrideSrc={(newSrc) => {
              setOverrideSrc(newSrc);
              setFailed(false);
              setVariant(0);
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      </div>
    );
  }

  // Lógica de construção da URL Final + Cache Busting
  const url = attempt ? `${current}${current.includes('?') ? '&' : '?'}retry=${attempt}` : current;
  
  const sourceMatch = (overrideSrc ?? src)?.match(
    /^(\/v1\/assets\/[0-9a-f-]{36}\/media\/)(?:thumbnail_small|thumbnail_medium|preview_large)(\?[^#]*)?$/i
  );
  
  const base = sourceMatch?.[1];
  const sourceQuery = sourceMatch?.[2] ?? '';
  
  const variantUrl = (name: string) =>
    apiUrl(`${base}${name}${sourceQuery}${attempt ? `${sourceQuery ? '&' : '?'}retry=${attempt}` : ''}`);

  const responsive = base && variant === 0
    ? [
        `${variantUrl('thumbnail_small')} 240w`,
        `${variantUrl('thumbnail_medium')} 640w`,
        ...(priority ? [`${variantUrl('preview_large')} 1600w`] : []),
      ].join(', ')
    : undefined;

  const imageSizes = sizes ?? (priority 
    ? '(max-width: 720px) 100vw, 70vw' 
    : '(max-width: 600px) 33vw, (max-width: 1200px) 20vw, 14vw'
  );

  const blurred = base
    ? variantUrl('thumbnail_small')
    : assetId && /^[a-f0-9-]{36}$/i.test(assetId)
      ? apiUrl(`/v1/assets/${assetId}/media/thumbnail_small`)
      : null;

  return (
    <span
      className={`private-image-frame ${loaded ? 'image-ready' : ''} ${className ?? ''}`.trim()}
      style={blurred ? ({ '--private-placeholder': `url("${blurred}")` } as React.CSSProperties) : undefined}
    >
      <img
        key={`${url}-${variant}`}
        src={apiUrl(url)}
        srcSet={responsive}
        sizes={responsive ? imageSizes : undefined}
        crossOrigin="use-credentials"
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(false);
          if (variant + 1 < candidates.length) {
            setVariant((n) => n + 1);
          } else {
            setFailed(true);
          }
        }}
        onClick={onClick}
        draggable={false}
      />
    </span>
  );
}
