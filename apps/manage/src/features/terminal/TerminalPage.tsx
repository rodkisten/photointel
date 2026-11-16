import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api as requestApi } from '../../lib/client';
import { Github, HardDrive, LockKeyhole, MonitorSmartphone, Plus, TerminalSquare } from 'lucide-react';

type Target = { id: string; label: string; kind: 'vm' | 'codespace'; status: 'configured' | 'unavailable'; state?: string };
type Catalog = { items: Target[]; codespaces: { available: boolean; reason: string } };

export function TerminalPage() {
  const { data, isPending, error, refetch } = useQuery({ queryKey: ['terminal', 'catalog'], queryFn: () => requestApi<Catalog>('/terminal/catalog'), retry: false });
  const targets = data?.items || [];
  const [selected, setSelected] = useState<string | null>(null);
  const active = targets.find(target => target.id === selected);
  return (
    <section className="space-y-5" aria-label="Terminal remoto">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-carbon-800 bg-carbon-900/50 p-4">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-carbon-800 p-3 text-carbon-200"><TerminalSquare size={22} /></span>
          <div><h2 className="font-semibold text-carbon-100">Conexões privadas</h2>
            <p className="text-xs text-carbon-400">Somente VMs autorizadas e seus Codespaces</p></div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-carbon-700 px-3 py-2 text-xs text-carbon-400"><LockKeyhole size={14}/> Cloudflare Access</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-3 rounded-2xl border border-carbon-800 bg-carbon-900/40 p-3">
          <h3 className="px-2 text-xs font-semibold uppercase tracking-wider text-carbon-400">Suas máquinas</h3>
          {targets.map(target => (
            <button type="button" key={target.id} onClick={() => setSelected(target.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-carbon-800 p-3 text-left text-sm hover:bg-carbon-800">
              {target.kind === 'vm' ? <HardDrive size={18}/> : <Github size={18}/>}
              <span className="min-w-0 flex-1 truncate">{target.label}<span className="block text-xs text-carbon-500">{target.kind === 'codespace' ? target.state : 'VM cadastrada'}</span></span>
            </button>
          ))}
          {isPending && <p className="px-2 py-4 text-sm text-carbon-500">Carregando máquinas autorizadas…</p>}
          {error && <div className="space-y-2 px-2 py-4 text-sm text-amber-400">Não foi possível carregar as máquinas.<button type="button" onClick={() => void refetch()} className="block underline">Tentar novamente</button></div>}
          {!isPending && !error && !targets.length && <p className="px-2 py-4 text-sm text-carbon-500">Nenhuma VM autorizada configurada.</p>}
          {data?.codespaces && <p className="px-2 py-2 text-xs text-carbon-500">Codespaces: {data.codespaces.reason}</p>}
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-carbon-700 px-3 py-3 text-xs text-carbon-500">
            <Plus size={16}/> Máquinas são cadastradas no servidor, nunca por host arbitrário.
          </div>
        </aside>
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-carbon-800 bg-[#090d13]">
          <div className="flex items-center justify-between border-b border-carbon-800 px-4 py-3">
            <span className="flex items-center gap-2 text-sm text-carbon-300"><TerminalSquare size={16}/>{active?.label || 'Terminal'}</span>
            <span className="text-xs text-carbon-500">Desconectado</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 py-12 text-center">
            <MonitorSmartphone size={34} className="text-carbon-500"/>
            <h3 className="text-base font-semibold text-carbon-200">Terminal pronto para integração</h3>
            <p className="max-w-md text-sm leading-6 text-carbon-400">A interface está isolada. A conexão SSH ficará desativada até existir um gateway autenticado, um catálogo de destinos autorizados e validação das chaves dos hosts.</p>
            <p className="text-xs text-carbon-500">Próxima etapa: WTerm/Ghostty, sessões WebSocket e descoberta GitHub Codespaces.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
