import { useState } from 'react';
import { Check, Edit3, Plus, Search, Tag as TagIcon } from 'lucide-react';
import { useAction, useApi } from '../api/client';
import type { Info, Page, Tag } from '../api/types';
import { Empty, ErrorState, PageHeader, Skeleton, Status } from '../components/common';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { number, text } from '../lib/format';
import { useUi } from '../lib/store';

export function TagsPage() {
  const [q, setQ] = useState(''); const [category, setCategory] = useState('');
  const [cursor, setCursor] = useState('');
  const [selected, setSelected] = useState(new Set<string>());
  const [editing, setEditing] = useState<Tag | 'new' | null>(null);
  const [name, setName] = useState(''); const [canonical, setCanonical] = useState('');
  const [aliases, setAliases] = useState(''); const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true); const [sync, setSync] = useState(false);
  const [threshold, setThreshold] = useState(35); const [sensitive, setSensitive] = useState(false);
  const [tagCategory, setTagCategory] = useState('other');
  const [parent, setParent] = useState(''); const [merge, setMerge] = useState('');
  const categories = useApi<Page<Info>>('/v1/tags/categories');
  const query = useApi<Page<Tag>>(`/v1/tags?limit=100&q=${encodeURIComponent(q)}&category=${category}&cursor=${cursor}`);
  const create = useAction<Tag>('/v1/tags'); const patch = useAction<Tag>(undefined, 'PATCH');
  function edit(tag: Tag | 'new') {
    setEditing(tag); setName(tag === 'new' ? '' : tag.display_name);
    setCanonical(tag === 'new' ? '' : tag.canonical_key);
    setAliases(tag === 'new' ? '' : tag.aliases.map((alias) => alias.alias).join(', '));
    setDescription(tag === 'new' ? '' : tag.description ?? ''); setEnabled(tag === 'new' || tag.enabled);
    setSync(tag !== 'new' && tag.sync_eligible); setSensitive(tag !== 'new' && tag.is_sensitive);
    setThreshold(tag === 'new' ? 35 : tag.minimum_confidence * 100);
    setTagCategory(tag === 'new' ? 'other' : tag.category);
    setParent(tag === 'new' ? '' : tag.parent_id ?? ''); setMerge(tag === 'new' ? '' : tag.merged_into_id ?? '');
  }
  async function save() {
    if (editing === 'new') await create.mutateAsync({ body: {
      canonical_key: canonical.trim(), display_name: name.trim(), category: tagCategory,
      is_sensitive: sensitive, sync_eligible: sync,
    } });
    else if (editing) await patch.mutateAsync({ url: `/v1/tags/${editing.id}`, body: {
      display_name: name.trim(), category: tagCategory, enabled, sync_eligible: sync,
      minimum_confidence: threshold / 100, is_sensitive: sensitive, description,
      aliases: aliases.split(',').map((alias) => alias.trim()).filter(Boolean).map((alias) => ({
        alias, language: 'pt-BR', alias_type: 'display',
      })), parent_id: parent || null, merged_into_id: merge || null,
    } });
    setEditing(null); useUi.getState().notify('Taxonomia atualizada.');
  }
  async function setAll(value: boolean) {
    for (const id of selected) await patch.mutateAsync({ url: `/v1/tags/${id}`, body: { enabled: value } });
    setSelected(new Set()); useUi.getState().notify('Categorias selecionadas atualizadas.');
  }
  return <><PageHeader eyebrow="Organização e vocabulário" title="Palavras-chave"
    description="Classificações com procedência, aliases e critérios que você controla."
    actions={<Button onClick={() => edit('new')}><Plus size={14} />Criar palavra-chave</Button>} />
    <div className="toolbar"><Search size={15} className="muted" /><input className="input"
      aria-label="Buscar palavra-chave" placeholder="Nome ou chave original…" value={q} maxLength={100}
      onChange={(event) => { setQ(event.target.value); setCursor(''); }} />
      <span className="toolbar-spacer" /><span className="muted">Sensíveis seguem sua configuração de privacidade</span></div>
    <div className="category-tabs"><button className={!category ? 'active' : ''}
      onClick={() => { setCategory(''); setCursor(''); }}>Todas as categorias</button>
      {categories.data?.items.map((item) => <button key={text(item.key)} className={category === item.key ? 'active' : ''}
        onClick={() => { setCategory(text(item.key)); setCursor(''); }}>{text(item.name)} · {number(item.count)}</button>)}</div>
    {!!selected.size && <div className="selection-bar"><strong>{selected.size} palavras selecionadas</strong>
      <div className="inline"><Button variant="outline" size="sm" disabled={patch.isPending}
        onClick={() => void setAll(true)}>Habilitar</Button><Button variant="outline" size="sm"
        disabled={patch.isPending} onClick={() => void setAll(false)}>Desabilitar</Button></div></div>}
    {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : query.isPending ?
      <Skeleton /> : !query.data.items.length ? <Empty title="Nenhuma palavra-chave"
        description="Tags reais aparecerão após inferência. Você também pode criar seu próprio vocabulário." /> :
      <section className="panel" style={{ padding: 0, overflow: 'hidden' }}><div className="table-scroll">
        <table className="tag-table"><thead><tr><th aria-label="Seleção" /><th>Palavra-chave</th>
          <th>Categoria</th><th>Confiança mínima</th><th>Estado</th><th aria-label="Ações" /></tr></thead>
          <tbody>{query.data.items.map((tag) => <tr key={tag.id}><td><input type="checkbox"
            aria-label={`Selecionar ${tag.display_name}`} checked={selected.has(tag.id)} onChange={() => {
              const next = new Set(selected); if (next.has(tag.id)) next.delete(tag.id); else next.add(tag.id); setSelected(next);
            }} /></td><td><strong>{tag.display_name}</strong><small>{tag.canonical_key}</small>
              {!!tag.aliases.length && <small>{tag.aliases.map((alias) => alias.alias).join(', ')}</small>}</td>
            <td>{tag.category}{tag.is_sensitive && <small>Exibição sensível</small>}</td>
            <td>{number(tag.minimum_confidence * 100)}%</td><td><Status value={tag.enabled ? 'operational' : 'paused'} /></td>
            <td><Button variant="ghost" size="icon" aria-label={`Editar ${tag.display_name}`}
              onClick={() => edit(tag)}><Edit3 size={14} /></Button></td></tr>)}</tbody></table></div>
        {query.data.next_cursor && <div className="form-actions" style={{ padding: 15, margin: 0 }}>
          <Button variant="outline" onClick={() => { setCursor(query.data!.next_cursor!); setSelected(new Set()); }}>
            Próxima página</Button></div>}</section>}
    <p className="field-help" style={{ marginTop: 15 }}><TagIcon size={11} style={{ display: 'inline', marginRight: 5 }} />
      Aprovação e rejeição de previsões são feitas por fotografia no visualizador.
      Rejeições manuais são preservadas durante novas inferências.</p>
    <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}
      title={editing === 'new' ? 'Nova palavra-chave' : 'Editar palavra-chave'}>
      <div className="stack"><label className="field">Nome em português<input value={name} maxLength={255}
        onChange={(e) => setName(e.target.value)} autoFocus /></label>
        {editing === 'new' && <label className="field">Chave canônica<input value={canonical}
          onChange={(e) => setCanonical(e.target.value)} maxLength={255} placeholder="camiseta_preta" pattern="[\\w-]+" /></label>}
        <label className="field">Categoria<select value={tagCategory} onChange={(e) => setTagCategory(e.target.value)}>
          {['person','body','face_hair','clothing','clothing_bulge','pose_action','sexual_action','genitals','penis',
            'environment','objects','composition','visual','other'].map((item) => <option key={item}>{item}</option>)}</select></label>
        {editing !== 'new' && <><label className="field">Aliases em português, separados por vírgula
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} maxLength={2000} /></label>
          <label className="field">Descrição<textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
          <label className="field">Confiança mínima: {Math.round(threshold)}%
            <input type="range" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
          <label className="field">Tag superior (ID, opcional)<input value={parent} onChange={(e) => setParent(e.target.value)} /></label>
          <label className="field">Mesclar com tag (ID, opcional)<input value={merge} onChange={(e) => setMerge(e.target.value)} /></label>
          <label className="checkbox-field">Habilitada<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /></label></>}
        <label className="checkbox-field">Classificação sensível<input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} /></label>
        <label className="checkbox-field">Elegível para Apple Sync<input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /></label>
      </div><div className="form-actions"><Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
        <Button disabled={!name.trim() || (editing === 'new' && !/^[\w-]+$/.test(canonical)) || patch.isPending || create.isPending}
          onClick={() => void save()}><Check size={13} />Salvar</Button></div>
    </Dialog></>;
}
