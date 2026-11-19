import { useEffect, useState } from 'react';
import { api, send } from '../lib/client';
import { Card } from '../components/ui';
import { IssueBanner } from '../components/shared';

type Conflict = { path: string; repository: unknown; manage: unknown; resolvedBy: 'repository' | 'manage' | null };
type RepositoryConfig = { repository: string; found: boolean; config: Partial<Settings>; overrides: Partial<Settings>; choices: Record<string, 'repository' | 'manage'>; conflicts: Conflict[]; settings: Settings };

type Settings = {
  events: string[]; grouping: 'window' | 'run' | 'none'; windowSeconds: number;
  updateMode: 'edit' | 'new'; retentionMinutes: { running: number; success: number; error: number }; template: string;
};
const labels: Record<string, string> = {
  workflow_started: 'Workflow iniciado', workflow_success: 'Workflow concluído',
  workflow_failure: 'Falha em workflow', workflow_recovered: 'Workflow recuperado',
  deploy_failed: 'Falha em deploy', job_failed: 'Falha em job',
};
export function NotificationsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [repository, setRepository] = useState('rodkisten/photointel');
  const [repoConfig, setRepoConfig] = useState<RepositoryConfig | null>(null);
  const [choices, setChoices] = useState<Record<string, 'repository' | 'manage'>>({});
  const [overrides, setOverrides] = useState<Partial<Settings>>({});
  const [loadingRepo, setLoadingRepo] = useState(false);
  useEffect(() => {
    void api<{ settings: Settings }>('/notifications/settings').then(data => setSettings(data.settings)).catch(setError);
  }, []);
  useEffect(() => {
    let active = true;
    setLoadingRepo(true);
    setRepoConfig(null);
    void api<RepositoryConfig>('/notifications/repository?repository=' + encodeURIComponent(repository))
      .then(data => { if (active) { setRepoConfig(data); setChoices(data.choices); setOverrides(data.overrides); } })
      .catch(err => { if (active) setError(err as Error); })
      .finally(() => { if (active) setLoadingRepo(false); });
    return () => { active = false; };
  }, [repository]);
  const change = (patch: Partial<Settings>) => setSettings(current => current ? { ...current, ...patch } : current);
  if (!settings) return <Card className="p-5">{error ? <IssueBanner error={error} /> : 'Carregando notificações…'}</Card>;
  const sample = settings.template.replace(/{{(\w+)}}/g, (_, key: string) => ({
    workflow: 'Media Build', run_number: '42', job: 'Cloud Build', step: 'Deploy',
    error: 'Permissão insuficiente (403)', diagnosis: 'Revisar IAM', url: 'https://github.com/rodkisten/photointel/actions',
  } as Record<string, string>)[key] || 'exemplo');
  return <div className="space-y-5">
    <Card className="space-y-4 p-5">
      <h2 className="font-semibold text-carbon-100">Configuração por repositório · notify.yml</h2>
      <label className="block text-sm">Repositório
        <input className="mt-1 w-full rounded bg-carbon-900 p-2" value={repository} onChange={e => setRepository(e.target.value)} placeholder="owner/repo" />
      </label>
      {loadingRepo && <p className="text-sm text-carbon-400">Carregando notify.yml do GitHub…</p>}
      {repoConfig && <>
        <p className="text-sm text-carbon-300">{repoConfig.found ? 'Arquivo encontrado no GitHub' : 'Sem notify.yml: usando padrões globais'}</p>
        <p className="text-xs text-carbon-400">Edite somente os campos que deseja sobrescrever. Os demais herdam o arquivo e os padrões.</p>
        <label className="block text-sm">Template personalizado
          <textarea className="mt-1 min-h-28 w-full rounded bg-carbon-900 p-3 font-mono text-sm"
            value={overrides.template ?? ''} placeholder="Herdar template do repositório"
            onChange={e => setOverrides(current => ({ ...current, template: e.target.value || undefined }))}/>
        </label>
        <label className="block text-sm">Janela personalizada
          <select className="mt-1 w-full rounded bg-carbon-900 p-2" value={overrides.windowSeconds ?? ''}
            onChange={e => setOverrides(current => ({ ...current, windowSeconds: e.target.value ? Number(e.target.value) : undefined }))}>
            <option value="">Herdar</option>{[5, 10, 15, 30].map(n => <option key={n} value={n}>{n} segundos</option>)}
          </select>
        </label>
        {repoConfig.conflicts.length > 0 && <div className="space-y-3 rounded-xl border border-amber-500/40 p-3">
          <h3 className="font-semibold">Conflitos de configuração</h3>
          {repoConfig.conflicts.map(conflict => <div key={conflict.path} className="space-y-2 text-sm">
            <p className="font-mono">{conflict.path}</p>
            <p className="break-words text-carbon-400">Arquivo: {JSON.stringify(conflict.repository)} · Manage: {JSON.stringify(conflict.manage)}</p>
            <select className="w-full rounded bg-carbon-900 p-2" value={choices[conflict.path] || ''}
              onChange={e => setChoices(current => ({ ...current, [conflict.path]: e.target.value as 'repository' | 'manage' }))}>
              <option value="">Resolver conflito…</option><option value="repository">Manter notify.yml</option><option value="manage">Usar Manage</option>
            </select>
          </div>)}
        </div>}
        <button className="rounded bg-carbon-200 px-4 py-2 text-sm font-semibold text-carbon-950 disabled:opacity-50"
          disabled={saving} onClick={async () => { setSaving(true); setSaved(false); setError(null);
            try {
              await send('/notifications/repository?repository=' + encodeURIComponent(repository), { overrides, choices }, 'PUT');
              const next = await api<RepositoryConfig>('/notifications/repository?repository=' + encodeURIComponent(repository));
              setRepoConfig(next); setChoices(next.choices); setOverrides(next.overrides); setSaved(true);
            } catch (err) { setError(err as Error); } finally { setSaving(false); }
          }}>{saving ? 'Salvando…' : 'Salvar escolhas do repositório'}</button>
      </>}
    </Card>
    <Card className="space-y-4 p-5">
      <h2 className="font-semibold text-carbon-100">Eventos que geram notificações</h2>
      <div className="grid gap-3 sm:grid-cols-2">{Object.entries(labels).map(([id, label]) =>
        <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.events.includes(id)}
          onChange={e => change({ events: e.target.checked ? [...settings.events, id] : settings.events.filter(v => v !== id) })}/>{label}</label>)}</div>
      <h2 className="font-semibold text-carbon-100">Agrupamento e atualização</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">Agrupar<select className="mt-1 w-full rounded bg-carbon-900 p-2" value={settings.grouping}
          onChange={e => change({ grouping: e.target.value as Settings['grouping'] })}>
          <option value="window">Por janela</option><option value="run">Por execução</option><option value="none">Individual</option></select></label>
        <label className="text-sm">Janela<select className="mt-1 w-full rounded bg-carbon-900 p-2" value={settings.windowSeconds}
          onChange={e => change({ windowSeconds: Number(e.target.value) })}>
          {[5, 10, 15, 30].map(n => <option key={n} value={n}>{n} segundos</option>)}</select></label>
        <label className="text-sm">Atualizações<select className="mt-1 w-full rounded bg-carbon-900 p-2" value={settings.updateMode}
          onChange={e => change({ updateMode: e.target.value as Settings['updateMode'] })}>
          <option value="edit">Editar mensagem</option><option value="new">Nova mensagem</option></select></label>
      </div>
      <h2 className="font-semibold text-carbon-100">Apagar automaticamente</h2>
      <p className="text-xs text-carbon-400">0 = nunca apagar. Prazos em minutos, até 30 dias.</p>
      <div className="grid gap-3 sm:grid-cols-3">{(['running', 'success', 'error'] as const).map(kind =>
        <label key={kind} className="text-sm">{({ running: 'Executando', success: 'Sucesso', error: 'Erro' })[kind]}
          <input className="mt-1 w-full rounded bg-carbon-900 p-2" type="number" min={0} max={43200}
            value={settings.retentionMinutes[kind]} onChange={e => change({ retentionMinutes: {
              ...settings.retentionMinutes, [kind]: Number(e.target.value) } })}/></label>)}</div>
      <h2 className="font-semibold text-carbon-100">Template da mensagem</h2>
      <textarea className="min-h-40 w-full rounded bg-carbon-900 p-3 font-mono text-sm" value={settings.template}
        onChange={e => change({ template: e.target.value })}/>
      <p className="text-xs text-carbon-400">Placeholders: workflow, run_number, job, step, error, diagnosis, url.</p>
      <button className="rounded bg-carbon-200 px-4 py-2 text-sm font-semibold text-carbon-950 disabled:opacity-50"
        disabled={saving} onClick={async () => { setSaving(true); setError(null); setSaved(false);
          try { await send('/notifications/settings', { settings }, 'PUT'); setSaved(true); }
          catch (e) { setError(e as Error); } finally { setSaving(false); } }}>
        {saving ? 'Salvando…' : 'Salvar configurações'}</button>
      {saved && <p className="text-sm text-emerald-400">Configuração salva no GitHub.</p>}
      {error && <IssueBanner error={error}/>}
    </Card>
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold text-carbon-100">Prévia da notificação</h2>
      <div className="max-w-lg rounded-xl border border-carbon-700 bg-carbon-900 p-4">
        <p className="mb-2 text-xs font-semibold text-carbon-300">PhotoIntel · Bot</p>
        <pre className="whitespace-pre-wrap break-words text-sm">{sample}</pre>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
          <span className="rounded border border-carbon-700 p-2">📋 Logs</span>
          <span className="rounded border border-carbon-700 p-2">🔧 Manage</span>
        </div>
      </div>
      <p className="text-xs text-carbon-400">Simulação. O agrupamento e a entrega em lote após 5 segundos dependem do suporte do Relay.</p>
    </Card>
  </div>;
}
