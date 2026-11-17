import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Search, Star, ChevronDown } from 'lucide-react';
import { api, send } from '../lib/client';

type Repo = { id: string; name: string; repository: string; private: boolean; archived: boolean; description: string | null; enabled: boolean };
type Page = { items: Repo[]; has_more: boolean; source: string };
export function ProjectPicker({ selected, onSelect }: { selected: string; onSelect: (repository: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ['github-catalog', page], queryFn: () => api<Page>('/projects/catalog?page=' + page), enabled: open, retry: false });
  const favorites = useQuery({ queryKey: ['github-favorites'], queryFn: () => api<{ items: string[] }>('/projects/favorites'), enabled: open, retry: false });
  const toggle = useMutation({
    mutationFn: ({ repository, favorite }: { repository: string; favorite: boolean }) => send('/projects/favorites', { repository, favorite }, 'PUT'),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['github-favorites'] }),
  });
  const starred = new Set(favorites.data?.items || []);
  const visible = (catalog.data?.items || []).filter(repo => (!favoritesOnly || starred.has(repo.repository)) &&
    (repo.repository.toLowerCase().includes(search.toLowerCase()) || (repo.description || '').toLowerCase().includes(search.toLowerCase())));
  return <div className="relative min-w-0">
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
      className="flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-carbon-800 bg-carbon-900 px-3 py-2 text-sm text-carbon-200">
      <FolderGit2 size={16}/><span className="truncate font-medium">{selected.split('/').pop()}</span><ChevronDown size={15}/>
    </button>
    {open && <div className="absolute left-0 top-full z-40 mt-2 w-[min(90vw,390px)] rounded-xl border border-carbon-700 bg-carbon-950 p-3 shadow-2xl">
      <div className="flex items-center gap-2 rounded-lg border border-carbon-700 px-2"><Search size={16}/>
        <input aria-label="Buscar projetos" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar repositórios..." className="min-w-0 flex-1 bg-transparent py-3 text-base outline-none"/>
      </div>
      <div className="my-2 flex items-center justify-between text-xs">
        <button type="button" onClick={() => setFavoritesOnly(v => !v)} className="rounded-lg border border-carbon-700 px-3 py-2">
          {favoritesOnly ? '★ Favoritos' : '☆ Todos'}
        </button><span className="text-carbon-500">{catalog.data?.source === 'installation' ? 'GitHub App' : 'GitHub'}</span>
      </div>
      <div className="max-h-[min(52dvh,430px)] space-y-1 overflow-y-auto overscroll-contain">
        {catalog.isPending && <p className="p-3 text-xs text-carbon-400">Carregando projetos…</p>}
        {catalog.isError && <p role="alert" className="p-3 text-xs text-amber-400">Não foi possível carregar os repositórios.</p>}
        {visible.map(repo => <div key={repo.id} className="flex items-center gap-1 rounded-lg hover:bg-carbon-800">
          <button type="button" className="min-w-0 flex-1 px-3 py-3 text-left" onClick={() => { onSelect(repo.repository); setOpen(false); }}>
            <span className="block truncate text-sm text-carbon-200">{repo.repository}</span>
            <span className="block truncate text-xs text-carbon-500">{repo.private ? 'Privado' : 'Público'}{repo.archived ? ' · Arquivado' : ''}</span>
          </button>
          <button type="button" aria-label={starred.has(repo.repository) ? 'Remover favorito' : 'Adicionar favorito'}
            disabled={toggle.isPending} onClick={() => toggle.mutate({ repository: repo.repository, favorite: !starred.has(repo.repository) })}
            className="rounded-lg p-3 text-amber-400 disabled:opacity-50"><Star size={18} fill={starred.has(repo.repository) ? 'currentColor' : 'none'}/></button>
        </div>)}
        {!catalog.isPending && !visible.length && <p className="p-3 text-xs text-carbon-500">Nenhum projeto nesta página.</p>}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-carbon-800 pt-2 text-xs">
        <button type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)} className="p-2 disabled:opacity-30">Anterior</button>
        <span>Página {page}</span>
        <button type="button" disabled={!catalog.data?.has_more} onClick={() => setPage(p => p + 1)} className="p-2 disabled:opacity-30">Próxima</button>
      </div>
    </div>}
  </div>;
}
