import { useQuery } from '@tanstack/react-query';
import { Cloud, ExternalLink, RefreshCcw } from 'lucide-react';
import { Badge, Button, Card, Section } from '../components/ui';
import { IssueBanner, Spinner } from '../components/shared';
import { api } from '../lib/client';

type Target = { id: string; name: string; script: string };
export function ProjectsPage() {
  const targets = useQuery({ queryKey: ['deploy-router-providers'],
    queryFn: () => api<{ cloudflare: Target[] }>('/deploy-router/providers'), retry: false });
  const runs = useQuery({ queryKey: ['deploy-router'],
    queryFn: () => api<{ runs: Array<{ target: string; state: string; sha: string }> }>('/deploy-router'),
    retry: false, refetchInterval: 30000 });
  return <div className="space-y-5">
    <Section title="Projetos conectados" detail="Workers autorizados do PhotoIntel. Esta tela não inicia builds."
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
    </Section>
    <Card className="p-4 text-xs text-carbon-400">Conexão de outros repositórios e descoberta de workflows serão implementadas em outra etapa.</Card>
  </div>;
}
