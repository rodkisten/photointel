import { Copy, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type { DuplicateGroup, Page } from '../api/types';
import { DetailList, Empty, ErrorState, PageHeader, PrivateImage, Skeleton } from '../components/common';
import { Button } from '../components/ui/button';
import { PhotoViewer } from '../components/viewer';
import { bytes, number } from '../lib/format';

export function DuplicatesPage() {
  const [params] = useSearchParams();
  const [kind, setKind] = useState('all'); const [threshold, setThreshold] = useState(0);
  const [cursor, setCursor] = useState(''); const [selected, setSelected] = useState(new Set<string>());
  const [viewer, setViewer] = useState<string | null>(null);
  const query = useApi<Page<DuplicateGroup>>(params.get('asset') ? `/v1/assets/${params.get('asset')}/duplicates` :
    `/v1/duplicates?kind=${kind}&threshold=${threshold / 100}&limit=20&cursor=${cursor}`);
  const groups = query.data?.items ?? [];
  const assets = groups.flatMap((group) => group.members.map((member) => member.asset));
  const toggle = (id: string) => { const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };
  return <><PageHeader eyebrow="Revisão não destrutiva" title="Um instante. Várias versões."
    description="Compare cópias e fotografias próximas, com todos os fatores à vista."
    actions={<span className="status"><Copy size={12} />Nenhuma exclusão</span>} />
    <div className="notice"><ShieldCheck size={15} /><span>Os grupos são candidatos para revisão.
      pHash não identifica todas as edições ou recortes. Nenhuma ação aqui exclui fotografias.</span></div>
    <div className="toolbar"><select className="input" style={{ width: 180 }} aria-label="Tipo de duplicada"
      value={kind} onChange={(e) => { setKind(e.target.value); setCursor(''); }}>
      <option value="all">Todos os grupos</option><option value="exact">Cópias exatas</option><option value="near">Visualmente próximas</option>
    </select><label className="field" style={{ minWidth: 170 }}>Similaridade mínima: {threshold}%
      <input type="range" min="0" max="100" value={threshold} onChange={(e) => { setThreshold(Number(e.target.value)); setCursor(''); }} /></label>
      <div className="toolbar-spacer" />{!!selected.size && <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
        Limpar {selected.size} selecionadas</Button>}</div>
    {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <Skeleton /> :
      !groups.length ? <Empty title="Nenhum grupo encontrado" description="Execute a análise de duplicadas no Processamento,
        ou reduza o limiar. Fotos distintas nunca são mescladas automaticamente." /> :
      groups.map((group, index) => <section className="panel duplicate-group" key={group.id}>
        <div className="panel-title"><div><h2>Grupo {index + 1} · {group.duplicate_type === 'exact' ? 'Cópias exatas' : 'Próximas visualmente'}</h2>
          <p className="field-help" style={{ marginTop: 5 }}>{group.members.length} fotografias · sugestão por fatores técnicos</p></div>
          <Button size="sm" variant="outline" onClick={() => setSelected((current) => new Set([...current,
            ...group.members.map((member) => member.asset_id)]))}>Selecionar grupo</Button></div>
        <div className="duplicate-comparison">{group.members.map((member) => <article className="duplicate-photo" key={member.asset_id}>
          {member.quality_rank === 1 && <span className="duplicate-best">Maior qualidade técnica</span>}
          <button style={{ padding: 0, width: '100%', border: 0, display: 'block' }} onClick={() => setViewer(member.asset_id)}
            aria-label={`Comparar ${member.asset.filename}`}><PrivateImage src={member.asset.thumbnail_url} alt={member.asset.filename} /></button>
          <div className="duplicate-info"><label><input type="checkbox" checked={selected.has(member.asset_id)}
            onChange={() => toggle(member.asset_id)} />{member.asset.filename}</label>
            <DetailList data={{ similarity: `${number(member.similarity * 100)}%`,
              dimensions: `${member.asset.width} × ${member.asset.height}`, size: bytes(member.asset.filesize),
              sharpness: member.asset.quality.sharpness ?? '—', brightness: member.asset.quality.brightness ?? '—' }}
            labels={{ similarity: 'Similaridade', dimensions: 'Dimensões', size: 'Arquivo', sharpness: 'Nitidez', brightness: 'Brilho' }} />
          </div></article>)}</div>
      </section>)}
    {query.data?.next_cursor && <Button variant="outline" onClick={() => setCursor(query.data!.next_cursor!)}>Próximos grupos</Button>}
    {viewer && <PhotoViewer id={viewer} assets={assets} onClose={() => setViewer(null)} onNavigate={setViewer} />}
  </>;
}
