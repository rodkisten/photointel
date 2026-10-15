import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Images } from 'lucide-react';
import { PageHeader } from '../components/common';
import { Gallery } from '../components/gallery';
import type { SearchRequest } from '../api/types';

export function Library() {
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') ?? 'captured_desc') as SearchRequest['sort'];
  const media = params.get('type');
  const search = useMemo<SearchRequest>(() => ({ sort, limit: 90,
    ...(media ? { filter: { op: 'media_type', value: media } } : {}),
  }), [sort, media]);
  function update(key: string, value: string) {
    const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }
  return <><PageHeader eyebrow="Seu acervo" title="Biblioteca"
    description="Cada fotografia, uma nova possibilidade de descoberta."
    actions={<span className="status"><Images size={12} />Acervo privado</span>} />
    <div className="toolbar"><select aria-label="Ordenar fotografias" className="input"
      style={{ width: 190 }} value={sort} onChange={(event) => update('sort', event.target.value)}>
      <option value="captured_desc">Mais recentes na captura</option><option value="added_desc">Últimas adicionadas</option>
      <option value="quality_desc">Qualidade técnica</option><option value="filesize_asc">Menor tamanho de arquivo</option>
    </select><select aria-label="Tipo de mídia" className="input" style={{ width: 145 }}
      value={media ?? ''} onChange={(event) => update('type', event.target.value)}>
      <option value="">Todas as mídias</option><option value="image">Fotografias</option>
      <option value="live_photo">Live Photos</option><option value="video">Vídeos</option></select></div>
    <Gallery search={search} /></>;
}
