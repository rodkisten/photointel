import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { send } from '../lib/client';
import { Cloud, ExternalLink, RefreshCcw } from 'lucide-react';
import { Badge, Button, Card, Section } from '../components/ui';
import { IssueBanner, Spinner } from '../components/shared';
import { api } from '../lib/client';

type Target = { id: string; name: string; script: string };
export function ProjectsPage() {
  const [repository, setRepository] = useState(() => new URLSearchParams(window.location.search).get('project') || 'rodkisten/photointel');
  useEffect(() => {
    const sync = () => setRepository(new URLSearchParams(window.location.search).get('project') || 'rodkisten/photointel');
    window.addEventListener('manage:project-changed', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('manage:project-changed', sync); window.removeEventListener('popstate', sync); };
  }, []);
  const [scope, setScope] = useState<'repository' | 'environment'>('repository');
  const [environment, setEnvironment] = useState('production');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const client = useQueryClient();
  const queryKey = ['project-variables', repository, scope, environment];
  const vars = useQuery({ queryKey, queryFn: () => api<{ items: Array<{ name: string; value: string; version: string }> }>(
    '/projects/variables?repository=' + encodeURIComponent(repository) + '&scope=' + scope + '&environment=' + encodeURIComponent(environment)), retry: false });
  useEffect(() => { setName(''); setValue(''); setVersion(null); setConfirm(''); }, [repository, scope, environment]);
  const save = useMutation({ mutationFn: () => send('/projects/variables?repository=' + encodeURIComponent(repository) + '&scope=' + scope + '&environment=' + encodeURIComponent(environment),
    { name, value, version, confirm }, 'PUT'), onSuccess: () => { setConfirm(''); void client.invalidateQueries({ queryKey }); } });
  const isPrimary = repository === 'rodkisten/photointel';
  const targets = useQuery({ enabled: isPrimary, queryKey: ['deploy-router-providers'],
    queryFn: () => api<{ cloudflare: Target[] }>('/deploy-router/providers'), retry: false });
  const runs = useQuery({ enabled: isPrimary, queryKey: ['deploy-router'],
    queryFn: () => api<{ runs: Array<{ target: string; state: string; sha: string }> }>('/deploy-router'),
    retry: false, refetchInterval: 30000 });
  return <div className="space-y-5">
    <Section title={'Variáveis GitHub Actions · ' + repository} detail="Alterações são aplicadas ao repositório selecionado. Secrets não podem ser lidos aqui.">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2"><label className="text-sm">Escopo <select className="ml-2 rounded-lg border border-carbon-700 bg-carbon-900 p-2" value={scope} onChange={e => setScope(e.target.value as 'repository' | 'environment')}><option value="repository">Repositório</option><option value="environment">Environment</option></select></label>
          {scope === 'environment' && <input aria-label="Environment" className="rounded-lg border border-carbon-700 bg-carbon-900 p-2 text-base" value={environment} onChange={e => setEnvironment(e.target.value)} />}</div>
        {vars.isPending && <Spinner />}{vars.error && <IssueBanner error={vars.error} />}
        <select aria-label="Selecionar variável" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base" value={name} onChange={e => { const item = vars.data?.items.find(v => v.name === e.target.value); setName(e.target.value); setValue(item?.value || ''); setVersion(item?.version || null); setConfirm(''); }}>
          <option value="">Nova variável ou selecione uma existente</option>{vars.data?.items.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <input aria-label="Nome da variável" placeholder="NOME_DA_VARIAVEL" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 font-mono text-base" value={name} onChange={e => { setName(e.target.value); setVersion(null); }} />
        <textarea aria-label="Valor da variável" rows={5} className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 font-mono text-base" value={value} onChange={e => setValue(e.target.value)} />
        <p className="text-xs text-carbon-400">Para salvar, digite o repositório completo: {repository}</p>
        <input aria-label="Confirmar repositório" placeholder={repository} className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base" value={confirm} onChange={e => setConfirm(e.target.value)} />
        {save.error && <IssueBanner error={save.error} />}
        {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Variável salva no GitHub.</p>}
        <Button disabled={!name || confirm !== repository || save.isPending} onClick={() => save.mutate()}>Salvar variável</Button>
      </Card>
    </Section>
    {isPrimary && <Section title="Projetos conectados" detail="Workers autorizados do PhotoIntel. Esta tela não inicia builds."
      action={<Button size="sm" variant="outline" onClick={() => { void targets.refetch(); void runs.refetch(); }}>
        <RefreshCcw size={14} /> Atualizar</Button>}>
      {targets.isPending && <Spinner />}
      {targets.error && <IssueBanner error={targets.error} />}
      {runs.error && <IssueBanner error={runs.error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {(targets.data?.cloudflare || []).map(target => {
          const last = runs.data?.runs.find(run => run.target === target.id);
          return <Card key={target.id} className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold"><Cloud size={16}/>{target.script}</span>
              <Badge tone="info">Conectado</Badge>
            </div>
            <p className="break-all font-mono text-xs text-carbon-400">{target.name}</p>
            <p className="text-xs text-carbon-400">Repositório: rodkisten/photointel</p>
            <p className="text-xs text-carbon-400">Última execução: {last ? last.state + ' · ' + last.sha.slice(0, 8) : 'nenhuma registrada'}</p>
            <div className="flex gap-4 text-xs">
              <a className="inline-flex items-center gap-1 underline" href="https://github.com/rodkisten/photointel/actions" target="_blank" rel="noreferrer">Workflows <ExternalLink size={12}/></a>
              <a className="underline" href="/triggers">Deploy manual</a>
            </div>
          </Card>;
        })}
      </div>
      {!targets.isPending && !targets.error && !targets.data?.cloudflare.length &&
        <Card className="p-4 text-sm text-carbon-400">Nenhum Worker conectado encontrado.</Card>}
    </Section>}
    {!isPrimary && <Card className="p-4 text-xs text-carbon-400">Os Workers do PhotoIntel não são exibidos neste projeto. Configure as integrações específicas do repositório selecionado.</Card>}
  </div>;
}
