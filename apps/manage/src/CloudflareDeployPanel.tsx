import { useQuery } from '@tanstack/react-query';
import { Card, Section } from './components/ui';
import { api } from './lib/client';
import { IssueBanner } from './components/shared';

type Binding = { name: string; type: string; value: string | null; protected: boolean };
type Deployment = {
  id: string;
  created_on: string | null;
  source: string | null;
  versions: Array<{ version_id: string; percentage: number | null }>;
};

export function CloudflareDeployPanel() {
  const bindings = useQuery({
    queryKey: ['cloudflare', 'bindings'],
    queryFn: () => api<{ items: Binding[] }>('/cloudflare/variables'),
    retry: false,
  });
  const deployments = useQuery({
    queryKey: ['cloudflare', 'deployments'],
    queryFn: () => api<{ items: Deployment[] }>('/cloudflare/deployments'),
    refetchInterval: 60_000,
    retry: false,
  });
  return (
    <div className="space-y-6">
      <Section title="Cloudflare · últimas publicações" detail="Histórico do Worker photointel">
        <Card className="space-y-3 p-4">
          {deployments.error && <IssueBanner error={deployments.error} />}
          {deployments.isPending && <p>Consultando publicações…</p>}
          {deployments.data?.items.length === 0 && <p>Nenhuma publicação encontrada.</p>}
          {deployments.data?.items.map((item) => (
            <div key={item.id} className="border-b border-[#2d2f33] pb-3 text-sm">
              <div className="font-mono">{item.id.slice(0, 12)}</div>
              <div>{item.created_on ? new Date(item.created_on).toLocaleString('pt-BR') : 'Data indisponível'}</div>
              <div className="text-xs">{item.source || 'Origem não informada'} · {item.versions.length} versão(ões)</div>
            </div>
          ))}
        </Card>
      </Section>
      <Section title="Cloudflare · variáveis do Worker" detail="Configuração atual; valores secretos nunca são exibidos">
        <Card className="space-y-3 p-4">
          {bindings.error && <IssueBanner error={bindings.error} />}
          {bindings.isPending && <p>Consultando variáveis…</p>}
          {bindings.data?.items.length === 0 && <p>Nenhuma variável encontrada.</p>}
          {bindings.data?.items.map((item) => (
            <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2d2f33] pb-2 text-sm">
              <span className="font-mono">{item.name}</span>
              <span className="text-xs text-carbon-500">{item.type} · {item.protected ? 'valor protegido' : item.value}</span>
            </div>
          ))}
          <p className="text-xs text-carbon-500">
            Leitura apenas. Alterações devem ser reconciliadas com CF__ para evitar divergência no próximo deploy.
          </p>
        </Card>
      </Section>
    </div>
  );
}
