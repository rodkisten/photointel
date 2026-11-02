import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  Maximize2,
  Minus,
  Plus,
  Search,
  Tag,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { request, useAction, useApi } from '../api/client';
import type {
  Asset,
  AssetDetail,
  Capabilities,
  DuplicateGroup,
  Info as InfoData,
  Page,
  SearchPage,
} from '../api/types';
import { bytes, date, number, text } from '../lib/format';
import { useUi } from '../lib/store';
import { DetailList, ErrorState, PrivateImage, Skeleton, Status } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function PhotoViewer({
  id,
  assets,
  onNavigate,
  onClose,
}: {
  id: string;
  assets: Asset[];
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const query = useApi<AssetDetail>(`/v1/assets/${id}`);
  const duplicate = useApi<Page<DuplicateGroup>>(`/v1/assets/${id}/duplicates`);
  const capabilities = useApi<Capabilities>('/v1/system/capabilities');
  const semantic = capabilities.data?.semantic_search;
  const semanticReady = ['operational', 'test_only'].includes(semantic?.state ?? '');
  const [details, setDetails] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [scale, setScale] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [similar, setSimilar] = useState<SearchPage | null>(null);
  const [similarError, setSimilarError] = useState<Error | null>(null);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const edit = useAction(`/v1/assets/${id}/tags`, 'PATCH');
  const navigate = useNavigate();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const index = assets.findIndex((asset) => asset.id === id);
  const previous = index > 0 ? assets[index - 1] : undefined;
  const next = index >= 0 ? assets[index + 1] : undefined;
  const asset = query.data;
  useEffect(() => {
    setZoom(false);
    setScale(1);
    setSimilar(null);
    setSimilarError(null);
    setKeyword('');
  }, [id]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || zoom) return;
      if (event.key === 'ArrowLeft' && previous) onNavigate(previous.id);
      if (event.key === 'ArrowRight' && next) onNavigate(next.id);
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [previous, next, onNavigate, zoom]);
  async function saveKeyword() {
    if (!keyword.trim()) return;
    await edit.mutateAsync({ body: { add: [keyword.trim()] } });
    setKeyword('');
    useUi.getState().notify('Palavra-chave salva com origem manual.');
  }
  async function loadSimilar() {
    setLoadingSimilar(true);
    setSimilarError(null);
    try {
      setSimilar(await request<SearchPage>(`/v1/assets/${id}/similar?limit=12`));
    } catch (error) {
      setSimilarError(error as Error);
    } finally {
      setLoadingSimilar(false);
    }
  }
  const pinchDistance = (first: React.Touch, second: React.Touch) =>
    Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  function toggleZoom() {
    const next = scale > 1.02 ? 1 : 2;
    setScale(next);
    setZoom(next > 1);
  }
  const preview =
    asset?.resources.find((resource) => resource.resource_type === 'preview_large')?.media_url ??
    asset?.thumbnail_url;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={asset?.filename ?? 'Fotografia'}
      description="Visualização privada e metadados da fotografia"
      className="viewer-dialog"
    >
      <div className="viewer-body">
        <div className="viewer-stage">
          {query.isPending ? (
            <Skeleton count={1} />
          ) : query.error ? (
            <ErrorState error={query.error} retry={() => void query.refetch()} />
          ) : (
            <div
              className={`viewer-image ${zoom ? 'zoomed' : ''}`}
              onDoubleClick={toggleZoom}
              onTouchStart={(event) => {
                if (event.touches.length === 2) {
                  pinch.current = { distance: pinchDistance(event.touches[0], event.touches[1]), scale };
                  touch.current = null;
                } else if (event.touches.length === 1) {
                  pinch.current = null;
                  touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
                }
              }}
              onTouchMove={(event) => {
                if (event.touches.length !== 2) return;
                if (!pinch.current) {
                  pinch.current = { distance: pinchDistance(event.touches[0], event.touches[1]), scale };
                }
                event.preventDefault();
                const nextScale = Math.min(
                  5,
                  Math.max(
                    1,
                    (pinch.current.scale * pinchDistance(event.touches[0], event.touches[1])) /
                      Math.max(1, pinch.current.distance),
                  ),
                );
                setScale(nextScale);
                setZoom(nextScale > 1.02);
                touch.current = null;
              }}
              onTouchEnd={(event) => {
                if (pinch.current) {
                  if (event.touches.length < 2) pinch.current = null;
                  touch.current = null;
                  return;
                }
                if (!touch.current || scale > 1.02) {
                  touch.current = null;
                  return;
                }
                const point = event.changedTouches[0];
                const dx = point.clientX - touch.current.x;
                const dy = point.clientY - touch.current.y;
                touch.current = null;
                if (dy > 100 && Math.abs(dy) > Math.abs(dx) * 1.5) {
                  onClose();
                } else if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.8) {
                  if (dx < 0 && next) onNavigate(next.id);
                  else if (dx > 0 && previous) onNavigate(previous.id);
                }
              }}
              onTouchCancel={() => {
                touch.current = null;
                pinch.current = null;
              }}
            >
              <div className="viewer-zoom-surface" style={{ transform: `scale(${scale})` }}>
                <PrivateImage src={preview} alt={asset?.filename ?? 'Fotografia'} assetId={id} priority />
              </div>
            </div>
          )}
          {previous && (
            <button
              className="viewer-arrow prev"
              aria-label="Fotografia anterior"
              onClick={() => onNavigate(previous.id)}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          {next && (
            <button
              className="viewer-arrow next"
              aria-label="Próxima fotografia"
              onClick={() => onNavigate(next.id)}
            >
              <ChevronRight size={20} />
            </button>
          )}
          <div className="viewer-controls">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleZoom}
              aria-label={zoom ? 'Reduzir zoom' : 'Ampliar fotografia'}
            >
              {zoom ? <Minus size={17} /> : <Plus size={17} />}
            </Button>
            <span className="muted" style={{ fontSize: 10 }}>
              {index >= 0 ? `${index + 1} / ${assets.length} carregadas` : 'Visualização privada'}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setZoom(false);
                setScale(1);
              }}
              aria-label="Ajustar à tela"
            >
              <Maximize2 size={16} />
            </Button>
            <Button
              className="viewer-metadata-button"
              variant="outline"
              size="sm"
              onClick={() => setDetails(!details)}
            >
              <Info size={14} />
              Informações
            </Button>
          </div>
        </div>
        <aside className={`viewer-details ${details ? 'open' : ''}`} aria-label="Informações da fotografia">
          <div className="viewer-tab">
            <h3>Informações</h3>
            <Button
              className="mobile-only"
              variant="ghost"
              size="icon"
              onClick={() => setDetails(false)}
              aria-label="Fechar informações"
            >
              <X size={16} />
            </Button>
          </div>
          {asset && (
            <>
              <div className="viewer-section">
                <DetailList
                  data={{
                    captured_at: date(asset.captured_at, true),
                    dimensions: `${asset.width ?? '—'} × ${asset.height ?? '—'}`,
                    filesize: bytes(asset.filesize),
                    media_type: asset.media_type,
                    revision: asset.content_revision,
                    classification: asset.classification_status,
                  }}
                  labels={{
                    captured_at: 'Captura',
                    dimensions: 'Dimensões',
                    filesize: 'Arquivo',
                    media_type: 'Tipo de mídia',
                    revision: 'Revisão',
                    classification: 'Classificação',
                  }}
                />
                {asset.metadata && (
                  <DetailList
                    data={Object.fromEntries(
                      Object.entries(asset.metadata).filter(
                        ([key]) => !['asset_id', 'additional_metadata'].includes(key),
                      ),
                    )}
                    labels={{
                      camera: 'Câmera',
                      lens: 'Lente',
                      orientation: 'Orientação',
                      latitude: 'Latitude',
                      longitude: 'Longitude',
                      iso: 'ISO',
                      aperture: 'Abertura',
                      focal_length: 'Distância focal',
                      exposure: 'Exposição',
                      original_filename: 'Nome original',
                      timezone: 'Fuso horário',
                    }}
                  />
                )}
              </div>
              <section className="viewer-section">
                <div className="viewer-tab">
                  <h3>Palavras-chave</h3>
                  <Tag size={14} />
                </div>
                <form
                  className="inline"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveKeyword();
                  }}
                >
                  <input
                    aria-label="Nova palavra-chave manual"
                    className="input"
                    placeholder="Nova palavra-chave"
                    value={keyword}
                    maxLength={255}
                    onChange={(event) => setKeyword(event.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Button
                    size="icon"
                    disabled={!keyword.trim() || edit.isPending}
                    aria-label="Salvar palavra-chave"
                  >
                    <Plus size={15} />
                  </Button>
                </form>
                {!asset.tags.length && (
                  <p className="muted" style={{ marginTop: 12 }}>
                    Nenhuma classificação registrada.
                  </p>
                )}
                {asset.tags.map((tag) => (
                  <div
                    key={tag.id}
                    className={`viewer-tag ${tag.user_status === 'rejected' ? 'rejected' : ''}`}
                  >
                    <div>
                      <strong>{tag.display_name}</strong>
                      <small>
                        {tag.category} · {tag.origin === 'user' ? 'Manual' : tag.origin}
                        {tag.confidence !== null ? ` · ${number(tag.confidence * 100)}%` : ''}
                        {tag.user_status === 'rejected' ? ' · rejeitada' : ''}
                      </small>
                    </div>
                    {tag.origin === 'user' && tag.user_status !== 'rejected' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remover ${tag.display_name}`}
                        disabled={edit.isPending}
                        onClick={() => edit.mutate({ body: { remove: [tag.canonical_key] } })}
                      >
                        <X size={13} />
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Aprovar ${tag.display_name}`}
                          disabled={edit.isPending}
                          onClick={() => edit.mutate({ body: { approve: [tag.tag_id] } })}
                        >
                          <Check size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Rejeitar ${tag.display_name}`}
                          disabled={edit.isPending}
                          onClick={() => edit.mutate({ body: { reject: [tag.tag_id] } })}
                        >
                          <X size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </section>
              <section className="viewer-section">
                <h3>Inteligência e procedência</h3>
                {asset.inference_runs.length ? (
                  asset.inference_runs.map((run) => (
                    <div className="viewer-model" key={text(run.id)}>
                      <strong>{text(run.model_name)}</strong>
                      <p>Revisão: {text(run.model_revision)}</p>
                      <p>
                        {number(run.runtime_ms)} ms · {date(run.completed_at, true)}
                      </p>
                      <Status value={run.status} />
                    </div>
                  ))
                ) : (
                  <p className="muted">Nenhuma inferência concluída. Consulte o processamento.</p>
                )}
                {asset.ranking && (
                  <div className="viewer-model">
                    <strong>Por que apareceu?</strong>
                    <DetailList data={asset.ranking} />
                  </div>
                )}
              </section>
              <section className="viewer-section">
                <div className="viewer-tab">
                  <h3>Fotografias semelhantes</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loadingSimilar || !semanticReady}
                    onClick={() => void loadSimilar()}
                  >
                    <Search size={12} />
                    Buscar
                  </Button>
                </div>
                <p className="field-help">
                  {semanticReady
                    ? 'Busca real pelos embeddings do mesmo modelo.'
                    : `Indisponível: ${semantic?.reason ?? 'consultando configuração'}.`}
                </p>
                {similarError && <ErrorState error={similarError} />}
                {similar && (
                  <div className="photo-strip">
                    {similar.items.map((photo) => (
                      <button
                        key={photo.id}
                        onClick={() => onNavigate(photo.id)}
                        aria-label={`Abrir ${photo.filename}`}
                      >
                        <PrivateImage src={photo.thumbnail_url} alt={photo.filename} />
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section className="viewer-section">
                <h3>Qualidade técnica</h3>
                <p className="field-help">Indicadores heurísticos; não avaliam o valor fotográfico.</p>
                <DetailList data={asset.quality} />
              </section>
              <section className="viewer-section">
                <h3>Duplicadas</h3>
                <p className="muted">
                  {duplicate.data
                    ? `${duplicate.data.items.length} grupos encontrados`
                    : 'Consultando grupos…'}
                </p>
                {!!duplicate.data?.items.length && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onClose();
                      navigate(`/duplicates?asset=${id}`);
                    }}
                  >
                    Comparar fotografias <ExternalLink size={12} />
                  </Button>
                )}
              </section>
              <section className="viewer-section">
                <h3>Apple Sync</h3>
                <Status value={asset.mapping_status} />
                <p className="field-help" style={{ marginTop: 10 }}>
                  Escritas exigem vínculo verificado, capacidade disponível e aprovação individual.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onClose();
                    navigate(`/bridge?asset=${id}`);
                  }}
                >
                  Preparar sincronização
                </Button>
              </section>
            </>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
export function metadataProjection(data: InfoData) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}
