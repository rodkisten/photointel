import { Bookmark, Info, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAction, useApi } from '../api/client';
import type { Capabilities, FilterNode, Info as InfoData, Page, SavedSearch, SearchRequest } from '../api/types';
import { PageHeader } from '../components/common';
import { Gallery } from '../components/gallery';
import { FilterBuilder, cleanFilter, emptyGroup } from '../components/filter-builder';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { useUi } from '../lib/store';

function readFilter(raw: string | null): FilterNode | undefined {
  if (!raw || raw.length > 12_000) return undefined;
  try { const parsed = JSON.parse(raw) as FilterNode;
    return parsed && typeof parsed.op === 'string' ? parsed : undefined;
  } catch { return undefined; }
}
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [tree, setTree] = useState<FilterNode>(() => readFilter(params.get('filter')) ?? emptyGroup());
  const [advanced, setAdvanced] = useState(!!params.get('filter'));
  const [sort, setSort] = useState<SearchRequest['sort']>((params.get('sort') ?? 'captured_desc') as SearchRequest['sort']);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState(''); const [until, setUntil] = useState('');
  const [media, setMedia] = useState(''); const [maxSize, setMaxSize] = useState('');
  const [minWidth, setMinWidth] = useState(''); const [source, setSource] = useState('');
  const [duplicates, setDuplicates] = useState(''); const [quality, setQuality] = useState('');
  const libraries = useApi<Page<InfoData>>('/v1/libraries');
  const caps = useApi<Capabilities>('/v1/system/capabilities');
  const saved = useApi<Page<SavedSearch>>('/v1/saved-searches');
  const save = useAction('/v1/saved-searches');
  const remove = useAction(undefined, 'DELETE');
  const semantic = caps.data?.semantic_search;
  const semanticReady = ['operational', 'test_only'].includes(semantic?.state ?? '');
  const paramsString = params.toString();
  const active = useMemo<SearchRequest>(() => {
    const values = new URLSearchParams(paramsString);
    const filter = readFilter(values.get('filter'));
    return { limit: 90, sort: (values.get('sort') ?? (values.get('q') ? 'relevance' : 'captured_desc')) as SearchRequest['sort'],
      ...(values.get('q') ? { query: values.get('q')! } : {}),
      ...(values.get('similar') ? { source_asset_id: values.get('similar')! } : {}),
      ...(filter ? { filter } : {}) };
  }, [paramsString]);
  function apply() {
    const children: FilterNode[] = [];
    const nested = advanced ? cleanFilter(tree) : undefined;
    if (nested) children.push(nested);
    if (from || until) children.push({ op: 'date', key: 'captured_at',
      ...(from ? { minimum: from } : {}), ...(until ? { maximum: until } : {}) });
    if (media) children.push({ op: 'media_type', value: media });
    if (source) children.push({ op: 'source', value: source });
    if (maxSize) children.push({ op: 'number', key: 'filesize', value: Number(maxSize) * 1024 ** 2, comparison: 'lte' });
    if (minWidth) children.push({ op: 'number', key: 'width', value: Number(minWidth), comparison: 'gte' });
    if (duplicates) children.push({ op: 'duplicate', value: duplicates === 'yes' });
    if (quality) children.push({ op: 'quality', key: 'sharpness', value: Number(quality), comparison: 'gte' });
    const next = new URLSearchParams();
    if (query.trim()) next.set('q', query.trim());
    if (children.length) next.set('filter', JSON.stringify({ op: 'and', children }));
    next.set('sort', query.trim() ? 'relevance' : sort);
    setParams(next, { replace: true });
  }
  function loadSaved(value: SearchRequest) {
    setQuery(value.query ?? ''); setTree(value.filter ?? emptyGroup());
    setAdvanced(!!value.filter); setSort(value.sort);
    setFrom(''); setUntil(''); setMedia(''); setMaxSize(''); setMinWidth('');
    setSource(''); setDuplicates(''); setQuality('');
    const next = new URLSearchParams();
    if (value.query) next.set('q', value.query);
    if (value.filter) next.set('filter', JSON.stringify(value.filter));
    if (value.source_asset_id) next.set('similar', value.source_asset_id);
    next.set('sort', value.sort); setParams(next, { replace: true });
  }
  function reset() { loadSaved({ sort: 'captured_desc', limit: 90 }); }
  return <><PageHeader eyebrow="Inteligência visual" title="Encontre pela sua ideia."
    description="Descreva uma cena em português. Combine a busca semântica com regras precisas."
    actions={<Button variant="outline" onClick={() => setSaveOpen(true)}><Bookmark size={14} />Salvar busca</Button>} />
    <form onSubmit={(event) => { event.preventDefault(); apply(); }}><div className="search-input-wrap">
      <Sparkles size={19} /><input aria-label="Busca semântica em português" value={query} maxLength={1000}
        placeholder="Paisagem com montanhas ao pôr do sol…" onChange={(event) => setQuery(event.target.value)} />
      <Button disabled={!!query.trim() && !semanticReady}><Search size={14} />Buscar</Button></div></form>
    <p className="search-note"><Info size={12} /><span>{semanticReady ?
      'Sua frase é interpretada por embeddings SigLIP 2. Datas, tags e medidas são filtros exatos aplicados separadamente.' :
      `Busca semântica indisponível: ${semantic?.reason ?? 'consultando configuração'}. Você pode usar os filtros exatos abaixo.`}</span></p>
    <div className="toolbar"><Button variant={advanced ? 'default' : 'outline'} size="sm"
      onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={13} />Filtros avançados</Button>
      <select className="input" aria-label="Ordenar resultados" style={{ width: 175 }} value={sort}
        onChange={(event) => { const value = event.target.value as SearchRequest['sort'];
          setSort(value); const next = new URLSearchParams(params); next.set('sort', value); setParams(next, { replace: true }); }}>
        <option value="captured_desc">Data de captura</option><option value="added_desc">Data de adição</option>
        <option value="relevance">Relevância semântica</option><option value="quality_desc">Qualidade técnica</option>
        <option value="filesize_asc">Tamanho de arquivo</option></select>
      {(active.filter || active.query || active.source_asset_id) && <Button variant="ghost" size="sm" onClick={reset}>
        <X size={13} />Limpar busca</Button>}</div>
    {advanced && <div className="filter-panel"><div className="filter-grid">
      <label className="field">Capturada a partir de<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="field">Capturada até<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      <label className="field">Tipo de mídia<select value={media} onChange={(e) => setMedia(e.target.value)}>
        <option value="">Todas</option><option value="image">Fotografia</option><option value="live_photo">Live Photo</option>
        <option value="video">Vídeo</option></select></label>
      <label className="field">Biblioteca<select value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="">Todas as fontes</option>{libraries.data?.items.map((library) => <option key={String(library.id)}
          value={String(library.id)}>{String(library.name)}</option>)}</select></label>
      <label className="field">Tamanho máximo (MB)<input type="number" min="0" value={maxSize}
        onChange={(e) => setMaxSize(e.target.value)} placeholder="Sem limite" /></label>
      <label className="field">Largura mínima (px)<input type="number" min="0" value={minWidth}
        onChange={(e) => setMinWidth(e.target.value)} placeholder="Qualquer dimensão" /></label>
      <label className="field">Duplicadas<select value={duplicates} onChange={(e) => setDuplicates(e.target.value)}>
        <option value="">Todas</option><option value="yes">Com candidatas</option><option value="no">Sem candidatas</option></select></label>
      <label className="field">Nitidez técnica mínima<input type="number" min="0" value={quality}
        onChange={(e) => setQuality(e.target.value)} placeholder="Sem mínimo" /></label>
    </div><div className="panel-section"><h3 style={{ marginBottom: 13 }}>Regras e grupos booleanos</h3>
      <FilterBuilder node={tree} onChange={setTree} /></div>
      <div className="form-actions"><Button variant="outline" onClick={reset}>Limpar filtros</Button>
        <Button onClick={apply} disabled={!!query.trim() && !semanticReady}>Aplicar filtros exatos</Button></div></div>}
    {!!saved.data?.items.length && <div className="saved-list">{saved.data.items.map((item) =>
      <div className="saved-item" key={item.id}><button onClick={() => loadSaved(item.query)}>
        <Bookmark size={10} style={{ display: 'inline', marginRight: 6 }} />{item.name}</button>
        <button aria-label={`Remover busca ${item.name}`} disabled={remove.isPending}
          onClick={() => remove.mutate({ url: `/v1/saved-searches/${item.id}` })}><X size={11} /></button></div>)}</div>}
    {(active.query || active.filter || active.source_asset_id) && <div className="notice"><Info size={14} /><span>
      {active.query ? `Busca semântica: “${active.query}”. ` : active.source_asset_id ? 'Busca por semelhança visual. ' : 'Busca por filtros exatos. '}
      {active.filter ? 'Filtros estruturados aplicados. ' : ''}
      A relevância é uma similaridade do modelo, não uma certeza.</span></div>}
    <Gallery search={active} compact />
    <Dialog open={saveOpen} onOpenChange={setSaveOpen} title="Salvar esta busca"
      description="Os critérios ficam disponíveis apenas dentro do seu workspace privado.">
      <label className="field">Nome<input value={name} maxLength={255} autoFocus
        onChange={(event) => setName(event.target.value)} placeholder="Paisagens favoritas" /></label>
      <div className="form-actions"><Button variant="outline" onClick={() => setSaveOpen(false)}>Cancelar</Button>
        <Button disabled={!name.trim() || save.isPending} onClick={async () => {
          await save.mutateAsync({ body: { name: name.trim(), query: active } });
          setSaveOpen(false); setName(''); useUi.getState().notify('Busca salva.');
        }}>Salvar</Button></div>
    </Dialog></>;
}
