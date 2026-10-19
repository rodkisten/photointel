import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Edit3, Plus, Search } from 'lucide-react';
import { request, useAction, useApi } from '../api/client';
import type { Album, Page, SearchRequest } from '../api/types';
import { Empty, ErrorState, PageHeader, PrivateImage, Skeleton } from '../components/common';
import { Gallery } from '../components/gallery';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { useUi } from '../lib/store';

const albumSchema = z.object({ name: z.string().trim().min(1, 'Informe um nome.').max(255),
  description: z.string().max(2000) });
type AlbumForm = z.infer<typeof albumSchema>;
export function AlbumsPage() {
  const [params, setParams] = useSearchParams(); const activeId = params.get('album');
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Album | null>(null);
  const query = useApi<Page<Album>>(`/v1/albums?q=${encodeURIComponent(q)}&limit=100`);
  const create = useAction<Album>('/v1/albums'); const patch = useAction<Album>(undefined, 'PATCH');
  const detailPath = `/v1/albums/${encodeURIComponent(activeId ?? '')}`;
  const detail = useQuery({queryKey: [detailPath], queryFn: () => request<Album>(detailPath), enabled: !!activeId});
  const active = detail.data;
  const form = useForm<AlbumForm>({ resolver: zodResolver(albumSchema), defaultValues: { name: '', description: '' } });
  const search = useMemo<SearchRequest>(() => ({ limit: 90,
    sort: active?.sort_order === 'added_desc' ? 'added_desc' : 'captured_desc',
    ...(activeId ? { filter: { op: 'album', value: activeId } } : {}),
  }), [activeId, active?.sort_order]);
  function start(album?: Album) {
    setEditing(album ?? null); form.reset({ name: album?.name ?? '', description: album?.description ?? '' }); setOpen(true);
  }
  async function submit(data: AlbumForm) {
    if (editing) await patch.mutateAsync({ url: `/v1/albums/${editing.id}`, body: data });
    else await create.mutateAsync({ body: data });
    setOpen(false); useUi.getState().notify(editing ? 'Álbum atualizado.' : 'Álbum criado. Selecione fotos na biblioteca para adicioná-las.');
  }
  return <><PageHeader eyebrow="Coleções pessoais" title={active?.name ?? 'Álbuns'}
    description={active?.description ?? 'Organize histórias com álbuns que pertencem ao seu catálogo privado.'}
    actions={active ? <Button variant="outline" onClick={() => start(active)}><Edit3 size={13} />Editar álbum</Button> :
      <Button onClick={() => start()}><Plus size={14} />Criar álbum</Button>} />
    {activeId ? <>{detail.error && <ErrorState error={detail.error} retry={() => void detail.refetch()} />}<div className="toolbar"><Button variant="ghost" size="sm" onClick={() => setParams({})}>
      <ArrowLeft size={13} />Todos os álbuns</Button><span className="muted">Selecione fotos para removê-las deste álbum.</span>
      {active && <select className="input" style={{ width: 170 }} aria-label="Ordenar álbum" value={active.sort_order}
        onChange={(event) => patch.mutate({ url: `/v1/albums/${active.id}`, body: { sort_order: event.target.value } })}>
        <option value="captured_desc">Data de captura</option><option value="added_desc">Data de adição</option>
        </select>}</div><Gallery search={search} albumId={activeId} /></> : <>
      <div className="toolbar"><Search size={15} /><input className="input" placeholder="Buscar álbuns…"
        aria-label="Buscar álbuns" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} /></div>
      {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <Skeleton /> :
        !query.data.items.length ? <Empty title="Dê um lugar às suas histórias" description="Crie um álbum e adicione fotografias pela seleção da biblioteca."
          action={<Button onClick={() => start()}><Plus size={14} />Criar primeiro álbum</Button>} /> :
        <div className="album-grid">{query.data.items.map((album) => <button className="album-card" key={album.id}
          onClick={() => setParams({ album: album.id })}><div className="album-cover">
          <PrivateImage src={album.cover_url} alt={`Capa de ${album.name}`} /></div><div className="album-info">
          <h3>{album.name}</h3><p>{album.asset_count} fotografias</p></div></button>)}</div>}
    </>}
    <Dialog open={open} onOpenChange={setOpen} title={editing ? 'Editar álbum' : 'Criar álbum'}>
      <form onSubmit={form.handleSubmit(submit)}><div className="stack"><label className="field">Nome
        <input {...form.register('name')} placeholder="Um lugar para revisitar" autoFocus />
        {form.formState.errors.name && <span className="field-error">{form.formState.errors.name.message}</span>}</label>
        <label className="field">Descrição<textarea {...form.register('description')} placeholder="O que reúne essas fotografias?" /></label>
      </div><div className="form-actions"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
        <Button disabled={create.isPending || patch.isPending}>{editing ? 'Salvar álbum' : 'Criar álbum'}</Button></div></form>
    </Dialog></>;
}
