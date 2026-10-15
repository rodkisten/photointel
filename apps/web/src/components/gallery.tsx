import { Check, Grid2X2, Grid3X3, Image, LayoutGrid, LoaderCircle,
  Plus, Tag, X } from 'lucide-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { request, useAction, useApi } from '../api/client';
import type { Album, Asset, Page, SearchPage, SearchRequest } from '../api/types';
import { date, number } from '../lib/format';
import { useUi } from '../lib/store';
import { Empty, ErrorState, PrivateImage, Skeleton } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { PhotoViewer } from './viewer';

export function Gallery({ search, compact = false, albumId }: {
  search: SearchRequest; compact?: boolean; albumId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const scroll = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const density = useUi((state) => state.density);
  const selected = useUi((state) => state.selected);
  const selecting = useUi((state) => state.selecting);
  const toggle = useUi((state) => state.toggle);
  const clear = useUi((state) => state.clear);
  const [bulk, setBulk] = useState<'tag' | 'album' | null>(null);
  const [keyword, setKeyword] = useState('');
  const [album, setAlbum] = useState('');
  const mutation = useAction();
  const remove = useAction(undefined, 'DELETE');
  const albums = useApi<Page<Album>>('/v1/albums?limit=100');
  const query = useInfiniteQuery({ queryKey: ['gallery', search], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => request<SearchPage>('/v1/search', {
      method: 'POST', body: JSON.stringify({ ...search, cursor: pageParam }),
    }), getNextPageParam: (page) => page.next_cursor ?? undefined });
  const assets = query.data?.pages.flatMap((page) => page.items) ?? [];
  const columns = width < 600 ? [3, 4, 2][density] : width < 1000 ? [5, 7, 4][density] : [7, 10, 5][density];
  const rowCount = Math.ceil(assets.length / columns);
  const rowHeight = width / columns + 36;
  const virtualizer = useVirtualizer({ count: rowCount + (query.hasNextPage ? 1 : 0),
    getScrollElement: () => scroll.current, estimateSize: () => rowHeight, overscan: 5 });
  const visible = virtualizer.getVirtualItems();
  const lastIndex = visible.at(-1)?.index ?? 0;
  useEffect(() => { if (lastIndex >= rowCount - 3 && query.hasNextPage && !query.isFetchingNextPage)
    void query.fetchNextPage();
  }, [lastIndex, rowCount, query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(scroll.current); return () => observer.disconnect();
  }, []);
  useEffect(() => { virtualizer.measure(); }, [columns, virtualizer]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [search]);
  const viewerId = params.get('photo');
  function open(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set('photo', id); else next.delete('photo');
    setParams(next, { replace: true });
  }
  async function applyBulk() {
    if (bulk === 'tag' && keyword.trim()) {
      await mutation.mutateAsync({ url: '/v1/assets/bulk/tags', body: {
        asset_ids: [...selected], add: keyword.split(',').map((key) => key.trim()).filter(Boolean),
      } });
    } else if (bulk === 'album' && album) {
      await mutation.mutateAsync({ url: `/v1/albums/${album}/assets`,
        body: { asset_ids: [...selected] } });
    } else return;
    useUi.getState().notify('Alterações salvas no catálogo.');
    setBulk(null); setKeyword(''); clear();
  }
  return <>
    <div className="toolbar"><span className="muted">{number(assets.length)} fotografias carregadas
      {query.hasNextPage ? ' · carregamento incremental' : ''}</span>
      <div className="toolbar-spacer" /><div className="view-toggle" aria-label="Densidade da grade">
        {[Grid3X3, LayoutGrid, Grid2X2].map((Icon, index) => <button key={index}
          className={density === index ? 'active' : ''}
          aria-label={['Grade padrão', 'Grade densa', 'Grade ampla'][index]}
          aria-pressed={density === index} onClick={() => useUi.getState().setDensity(index)}>
          <Icon size={15} /></button>)}</div>
      <Button variant="outline" size="sm" onClick={() => selecting ? clear() :
        useUi.getState().startSelection()}>{selecting ? <X size={13} /> : <Check size={13} />}
        {selecting ? 'Sair da seleção' : 'Selecionar'}</Button>
    </div>
    {selecting && selected.size > 0 && <div className="selection-bar">
      <strong>{selected.size} selecionadas</strong><div className="inline">
        <Button variant="outline" size="sm" onClick={() => setBulk('tag')}><Tag size={12} />Keyword</Button>
        <Button variant="outline" size="sm" onClick={() => setBulk('album')}><Plus size={13} />Álbum</Button>
        {albumId && <Button variant="outline" size="sm" disabled={remove.isPending}
          onClick={async () => { for (const id of selected) await remove.mutateAsync({
            url: `/v1/albums/${albumId}/assets/${id}` }); clear();
          }}>Remover do álbum</Button>}
        <Button variant="ghost" size="sm" onClick={clear} aria-label="Limpar seleção"><X size={14} /></Button>
      </div></div>}
    {query.isPending ? <Skeleton count={8} /> : query.error ?
      <ErrorState error={query.error} retry={() => void query.refetch()} /> : !assets.length ?
        <Empty title="Seu próximo olhar começa aqui" description="Nenhuma fotografia corresponde a esta
          visualização. Ajuste os filtros ou importe um primeiro lote em Sincronização iCloud." /> :
        <div className={`gallery-scroll ${compact ? 'search-gallery' : ''}`} ref={scroll}
          aria-label="Grade de fotografias" tabIndex={0}>
          <div className="virtual-grid" style={{ height: virtualizer.getTotalSize() }}>
            {visible.map((row) => {
              if (row.index >= rowCount) return <div className="load-more" key="load"
                style={{ position: 'absolute', top: row.start }}><LoaderCircle size={16} />Carregando…</div>;
              const group = assets.slice(row.index * columns, (row.index + 1) * columns);
              const previous = assets[row.index * columns - 1];
              const day = group[0]?.captured_at?.slice(0, 10);
              const showDate = row.index === 0 || day !== previous?.captured_at?.slice(0, 10);
              return <div key={row.key} className="gallery-row" data-index={row.index}
                ref={virtualizer.measureElement} style={{ transform: `translateY(${row.start}px)` }}>
                {showDate && <div className="gallery-date">{day ? date(group[0].captured_at) : 'Data não disponível'}</div>}
                <div className="gallery-cells" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                  {group.map((asset) => <PhotoTile key={asset.id} asset={asset} selecting={selecting}
                    selected={selected.has(asset.id)} onOpen={() => open(asset.id)}
                    onSelect={() => toggle(asset.id)} />)}
                </div></div>;
            })}
          </div>{query.isFetchingNextPage && <p role="status" className="load-more">Buscando próxima página…</p>}
        </div>}
    {query.isFetchNextPageError && <ErrorState error={query.error!}
      retry={() => void query.fetchNextPage()} />}
    {viewerId && <PhotoViewer id={viewerId} assets={assets} onNavigate={open} onClose={() => open(null)} />}
    <Dialog open={bulk !== null} onOpenChange={(value) => !value && setBulk(null)}
      title={bulk === 'tag' ? 'Adicionar palavras-chave' : 'Adicionar a um álbum'}
      description={`Alterar ${selected.size} fotografias no catálogo web.`}>
      {bulk === 'tag' ? <label className="field">Palavras-chave separadas por vírgula
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} autoFocus
          placeholder="viagem, favoritas" maxLength={1500} /></label> :
        <label className="field">Álbum<select value={album} onChange={(event) => setAlbum(event.target.value)}>
          <option value="">Selecione um álbum</option>{albums.data?.items.map((item) =>
            <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <div className="form-actions"><Button variant="outline" onClick={() => setBulk(null)}>Cancelar</Button>
        <Button onClick={() => void applyBulk()} disabled={mutation.isPending ||
          (bulk === 'tag' ? !keyword.trim() : !album)}>Salvar</Button></div>
    </Dialog>
  </>;
}
function PhotoTile({ asset, selected, selecting, onSelect, onOpen }: {
  asset: Asset; selected: boolean; selecting: boolean; onSelect: () => void; onOpen: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  return <button className={`photo-tile ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''}`}
    onClick={() => { if (held.current) { held.current = false; return; }
      if (selecting) onSelect(); else onOpen(); }} aria-label={asset.filename}
    aria-pressed={selecting ? selected : undefined}
    onPointerDown={(event) => { if (event.pointerType === 'touch') {
      held.current = false; timer.current = setTimeout(() => { held.current = true; onSelect(); }, 550);
    } }} onPointerUp={cancel} onPointerCancel={cancel} onPointerMove={cancel}
    onContextMenu={(event) => { event.preventDefault(); if (!held.current) onSelect(); }}>
    <PrivateImage src={asset.thumbnail_url} alt={asset.filename} />
    <span className="photo-select" aria-hidden="true">{selected && <Check size={13} />}</span>
    <span className="photo-overlay">{asset.media_type === 'video' && <Image size={12} />}
      {asset.filename}</span>
  </button>;
}
