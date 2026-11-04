import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Copy, GitBranch, GitCommit, Plus, RefreshCcw, Save, Trash2, Webhook } from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select, Textarea } from '../components/ui';
import { Empty, IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';
import { date } from '../lib/utils';

type Rule = { id: string; name: string; enabled: boolean; provider: 'cloudflare' | 'gcp';
  target: string; patterns: string[]; created_at: string; updated_at: string };
type Run = { id: string; rule_name: string; provider: string; sha: string; state: string;
  provider_id: string | null; detail: string | null; status_url: string | null; created_at: string };
type Snapshot = { rules: Rule[]; runs: Run[]; webhook: string;
  configured: Record<string, boolean> };
type Inspect = { items: Array<{ pattern: string; kind: string; exists: boolean; matches: number }>; valid: boolean };
const templates = [
  { name: 'Backend Python / GCP', provider: 'gcp', target: 'release', patterns:
    'apps/api/\ninfra/docker/api.Dockerfile\ninfra/gcp/\ninfra/migrations/\npackages/icloudpd-source/' },
  { name: 'Manage / Workers Builds', provider: 'cloudflare', target: '', patterns:
    'apps/manage/\ninfra/scripts/deploy_manage.py' },
  { name: 'Frontend / Workers Builds', provider: 'cloudflare', target: '', patterns:
    'apps/web/\npackage-lock.json\npackages/' },
];
const empty = { name: '', provider: 'cloudflare' as 'cloudflare' | 'gcp',
  target: '', enabled: false, patterns: '' };
function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'info' {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'warning';
  if (status === 'running') return 'info';
  return 'neutral';
}
export function DeployTriggers() {
  const qc = useQueryClient();
  const snapshot = useQuery({ queryKey: ['deploy-router'], queryFn: () => api<Snapshot>('/deploy-router'),
    refetchInterval: 10000, retry: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(empty);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [search, setSearch] = useState('');
  const [simulated, setSimulated] = useState('');
  const [simResult, setSimResult] = useState<string | null>(null);
  const tree = useQuery({ queryKey: ['deploy-tree', search], queryFn: () =>
    api<{ entries: Array<{ path: string; type: string }> }>('/deploy-router/tree?q=' +
      encodeURIComponent(search)), enabled: search.length > 1, retry: false });
  const patterns = useMemo(() => draft.patterns.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean), [draft.patterns]);
  const inspectMutation = useMutation({ mutationFn: () => send<Inspect>('/deploy-router/validate', { patterns }),
    onSuccess: setInspect });
  const save = useMutation({ mutationFn: () => {
    const body = { ...draft, patterns };
    return editing ? api('/deploy-router/rules/' + editing, { method: 'PUT', body: JSON.stringify(body) }) :
      send('/deploy-router/rules', body);
  }, onSuccess: () => {
    setEditing(null); setDraft(empty); setInspect(null);
    void qc.invalidateQueries({ queryKey: ['deploy-router'] });
  } });
  const remove = useMutation({ mutationFn: (id: string) => api('/deploy-router/rules/' + id, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deploy-router'] }) });
  const refresh = useMutation({ mutationFn: () => send('/deploy-router/refresh', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deploy-router'] }) });
  const simulate = useMutation({ mutationFn: () =>
    send<{ items: Array<{ name: string; files: string[] }> }>('/deploy-router/simulate',
      { paths: simulated.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean) }),
    onSuccess: (data) => setSimResult(data.items.length ?
      data.items.map((x) => x.name + ': ' + x.files.join(', ')).join('\n') : 'Nenhuma regra corresponde aos caminhos') });
  const settings = snapshot.data?.configured;
  function load(rule: Rule) {
    setEditing(rule.id);
    setDraft({ name: rule.name, provider: rule.provider, target: rule.target,
      enabled: rule.enabled, patterns: rule.patterns.join('\n') });
    setInspect(null);
  }
  function template(index: number) {
    const item = templates[index];
    setEditing(null); setInspect(null);
    setDraft({ name: item.name, provider: item.provider as 'cloudflare' | 'gcp',
      target: item.target, enabled: false, patterns: item.patterns });
  }
  useEffect(() => { setInspect(null); }, [draft.patterns]);
  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-carbon-100"><Webhook size={18} /> Webhook GitHub</div>
        <p className="text-sm text-carbon-400">Envie eventos push da main para este endereço. Não usa GitHub Actions. A assinatura HMAC é obrigatória.</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md bg-carbon-950 p-3 text-xs text-carbon-200">https://photos-hooks.migos.club/hooks/github</code>
          <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText('https://photos-hooks.migos.club/hooks/github')}>
            <Copy size={15} /> Copiar
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone={settings?.github ? 'success' : 'warning'}>Assinatura: {settings?.github ? 'configurada' : 'pendente'}</Badge>
          <Badge tone={settings?.cloudflare ? 'success' : 'warning'}>Cloudflare</Badge>
          <Badge tone={settings?.gcp_release ? 'success' : 'warning'}>GCP release</Badge>
          <Badge tone={settings?.xrelay ? 'success' : 'warning'}>xrelay</Badge>
        </div>
        <p className="text-xs text-carbon-500">GitHub → Settings → Webhooks → Add webhook. Content type: application/json, evento: Just the push event. Use o mesmo secret da variável GITHUB_WEBHOOK_SECRET do Worker.</p>
      </Card>
      {snapshot.error && <IssueBanner error={snapshot.error} />}
      <Section title="Regras por arquivo ou pasta" detail="Cada regra vincula um conjunto de caminhos a um build. Caminhos são validados contra a árvore real do GitHub.">
        <div className="flex flex-wrap gap-2">
          {templates.map((item, i) => <Button key={item.name} variant="ghost" size="sm" onClick={() => template(i)}>
            <Plus size={14} /> {item.name}
          </Button>)}
        </div>
        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="field-label" htmlFor="route-name">Nome</label>
              <Input id="route-name" value={draft.name} placeholder="Ex.: API de produção"
                onChange={(e) => setDraft((x) => ({ ...x, name: e.target.value }))} /></div>
            <div><label className="field-label" htmlFor="route-provider">Provedor</label>
              <Select id="route-provider" value={draft.provider} onChange={(e) => setDraft((x) =>
                ({ ...x, provider: e.target.value as 'cloudflare' | 'gcp', target: '' }))}>
                <option value="cloudflare">Cloudflare Workers Builds</option>
                <option value="gcp">Google Cloud Build</option>
              </Select></div>
          </div>
          <div>
            <label className="field-label" htmlFor="route-target">Destino</label>
            {draft.provider === 'gcp' ?
              <Select id="route-target" value={draft.target} onChange={(e) => setDraft((x) => ({ ...x, target: e.target.value }))}>
                <option value="">Selecione o webhook provisionado</option>
                <option value="release">Cloud Build · API + Jobs + Scheduler</option>
                <option value="provision">Cloud Build · Bootstrap/IAM</option>
              </Select> :
              <Input id="route-target" placeholder="UUID do trigger de Workers Builds"
                value={draft.target} onChange={(e) => setDraft((x) => ({ ...x, target: e.target.value }))} />}
            <p className="mt-1 text-xs text-carbon-500">GCP: URL secreta associada ao destino no Worker. Cloudflare: UUID de um build trigger conectado ao mesmo repositório.</p>
          </div>
          <div>
            <label className="field-label" htmlFor="route-patterns">Paths (um por linha)</label>
            <Textarea id="route-patterns" rows={5} spellCheck={false} value={draft.patterns}
              placeholder={'apps/api/\ninfra/gcp/**/*.py\napps/manage/src/worker.ts'}
              onChange={(e) => setDraft((x) => ({ ...x, patterns: e.target.value }))} />
            <p className="mt-1 text-xs text-carbon-500">Arquivos, diretórios e globs *, ** e ?. As regras são verificadas na árvore do GitHub.</p>
            <div className="mt-3">
              <label className="field-label" htmlFor="route-search">Buscar arquivo ou diretório</label>
              <Input id="route-search" value={search} placeholder="apps/api/"
                onChange={(e) => setSearch(e.target.value)} />
              {tree.data && <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-carbon-800">
                {tree.data.entries.slice(0, 24).map((entry) =>
                  <button type="button" key={entry.path} className="block w-full break-all border-b border-carbon-800 px-3 py-2 text-left font-mono text-xs text-carbon-300 hover:bg-carbon-900"
                    onClick={() => { setDraft((x) => ({ ...x, patterns: x.patterns + (x.patterns ? '\\n' : '') + entry.path + (entry.type === 'tree' ? '/' : '') })); setSearch(''); }}>
                    {entry.type === 'tree' ? '📁 ' : '📄 '}{entry.path}
                  </button>)}
              </div>}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-carbon-300">
            <input type="checkbox" checked={draft.enabled}
              onChange={(e) => setDraft((x) => ({ ...x, enabled: e.target.checked }))} />
            Ativar automaticamente para push na main
          </label>
          {inspect && <div className="space-y-1 rounded-md border border-carbon-800 p-3">
            {inspect.items.map((p) => <div key={p.pattern} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 break-all font-mono">{p.pattern}</span>
              <Badge tone={p.exists ? 'success' : 'warning'}>{p.exists ? p.kind + ' · ' + p.matches : 'Não encontrado'}</Badge>
            </div>)}
          </div>}
          {(inspectMutation.error || save.error) && <IssueBanner error={inspectMutation.error || save.error} />}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => inspectMutation.mutate()} disabled={!patterns.length || inspectMutation.isPending}>
              <CheckCircle2 size={15} /> Validar paths
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !draft.name || !draft.target || !patterns.length}>
              <Save size={15} /> {editing ? 'Atualizar' : 'Salvar regra'}
            </Button>
            {editing && <Button variant="ghost" onClick={() => { setEditing(null); setDraft(empty); }}>Cancelar</Button>}
          </div>
        </Card>
      </Section>
      <Section title="Regras salvas" detail="Desativadas não disparam builds, mas continuam editáveis.">
        {snapshot.isPending ? <Spinner /> : !snapshot.data?.rules.length ? <Empty message="Nenhuma regra configurada" /> :
          <div className="space-y-2">{snapshot.data.rules.map((rule) =>
            <Card key={rule.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap gap-2"><span className="text-sm font-semibold">{rule.name}</span>
                  <Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'Ativo' : 'Pausado'}</Badge>
                  <Badge>{rule.provider}</Badge>
                </div>
                <p className="break-all font-mono text-xs text-carbon-500">{rule.patterns.join(' · ')}</p>
                <p className="text-xs text-carbon-500">Destino: {rule.target}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => load(rule)}>Editar</Button>
                <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => {
                  if (window.confirm('Excluir regra ' + rule.name + '?')) remove.mutate(rule.id);
                }}><Trash2 size={15} /></Button>
              </div>
            </Card>)}</div>}
      </Section>
      <Section title="Simular mudança" detail="Teste a correspondência sem disparar builds nem gastar recursos.">
        <Card className="space-y-3 p-4">
          <Textarea rows={2} value={simulated} onChange={(e) => setSimulated(e.target.value)}
            placeholder="apps/api/src/photointel/main.py" />
          <Button size="sm" disabled={!simulated.trim() || simulate.isPending}
            onClick={() => simulate.mutate()}><GitBranch size={15} /> Testar regras</Button>
          {simulate.error && <IssueBanner error={simulate.error} />}
          {simResult && <pre className="whitespace-pre-wrap break-all rounded-md bg-carbon-950 p-3 text-xs">{simResult}</pre>}
        </Card>
      </Section>
      <Section title="Execuções recentes" detail="Atualização periódica. Builds Cloudflare também são consultados em segundo plano.">
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" disabled={refresh.isPending}
            onClick={() => refresh.mutate()}><RefreshCcw size={15} /> Atualizar status</Button>
        </div>
        {refresh.error && <IssueBanner error={refresh.error} />}
        {!snapshot.data?.runs.length ? <Empty message="Nenhum deploy recebido ainda" /> :
          <div className="space-y-2">{snapshot.data.runs.map((run) =>
            <Card key={run.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(run.state)}>{run.state}</Badge>
                <strong className="text-sm">{run.rule_name}</strong>
                <span className="text-xs text-carbon-500">{date(run.created_at)}</span>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-carbon-400">
                <span>{run.provider}</span><span className="font-mono"><GitCommit size={12} className="mr-1 inline" />{run.sha.slice(0, 10)}</span>
                {run.detail && <span className="text-amber-400"><CircleAlert size={12} className="mr-1 inline" />{run.detail}</span>}
                {run.status_url && <a className="underline" href={run.status_url}
                  target="_blank" rel="noreferrer">Abrir provedor</a>}
              </div>
            </Card>)}</div>}
      </Section>
      <div className="text-xs text-carbon-500">Os secrets nunca são armazenados nas regras. GCP deve enviar callbacks assinados para indicar conclusão; caso contrário, a execução ficará como submitted.</div>
    </div>
  );
}
