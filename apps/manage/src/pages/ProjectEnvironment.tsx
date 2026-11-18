import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Section } from '../components/ui';
import { CodeMirrorEnvEditor, detectEnvironmentFormat } from '../components/codemirror-env-editor';
import { DotenvFields } from '../components/dotenv-fields';
import { IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';

type Variable = { name: string; value: string; version: string };
type Scope = 'repository' | 'environment';

/** External GitHub repositories use the same CodeMirror/fields controls as PhotoIntel. */
export function ProjectEnvironment({ repository }: { repository: string }) {
  const client = useQueryClient();
  const [scope, setScope] = useState<Scope>('repository');
  const [environment, setEnvironment] = useState('production');
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [mode, setMode] = useState<'code' | 'fields'>('code');
  const [editing, setEditing] = useState(false);
  const key = ['project-variables', repository, scope, environment];
  const endpoint = '/projects/variables?repository=' + encodeURIComponent(repository) +
    '&scope=' + scope + '&environment=' + encodeURIComponent(environment);
  const variables = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: Variable[] }>(endpoint),
    enabled: Boolean(repository && (scope === 'repository' || environment.trim())),
    retry: false,
  });
  useEffect(() => {
    setSelected(''); setName(''); setValue(''); setVersion(null); setConfirmation(''); setEditing(false);
  }, [repository, scope, environment]);
  const save = useMutation({
    mutationFn: () => send(endpoint, { name, value, version, confirm: confirmation }, 'PUT'),
    onSuccess: () => {
      setConfirmation('');
      setEditing(false);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const original = variables.data?.items.find(item => item.name === selected);
  const dirty = editing && (name !== (original?.name ?? '') || value !== (original?.value ?? ''));
  const staleSelection = Boolean(selected && !original);
  const staleVersion = Boolean(original && version !== original.version);
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && confirmation === repository &&
    !variables.isPending && !variables.isError && !staleSelection && !staleVersion && dirty && !save.isPending;
  return <Section title={'Ambiente GitHub · ' + repository}
    detail="Variáveis do repositório selecionado · CodeMirror 6 · secrets nunca são recuperados">
    <Card className="space-y-4 p-4" key={repository}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={dirty ? 'warning' : 'success'}>{dirty ? 'Não salvo' : 'Sincronizado'}</Badge>
        <span className="text-xs text-carbon-400">GitHub Actions · {scope === 'repository' ? 'Repository' : environment}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-carbon-400">Escopo
          <select aria-label="Escopo GitHub" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base"
            value={scope} onChange={event => setScope(event.target.value as Scope)}>
            <option value="repository">Repositório</option><option value="environment">Environment</option>
          </select>
        </label>
        {scope === 'environment' && <label className="space-y-1 text-xs text-carbon-400">Environment
          <input aria-label="Nome do environment" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base"
            value={environment} onChange={event => setEnvironment(event.target.value)} />
        </label>}
      </div>
      {variables.isPending && <Spinner />}
      {variables.error && <IssueBanner error={variables.error} />}
      <label className="block space-y-1 text-xs text-carbon-400">Variável
        <select aria-label="Selecionar variável GitHub" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base"
          value={selected} onChange={event => {
            const item = variables.data?.items.find(entry => entry.name === event.target.value);
            setSelected(item?.name ?? ''); setName(item?.name ?? '');
            setValue(item?.value ?? ''); setVersion(item?.version ?? null); setConfirmation(''); setEditing(false);
          }}>
          <option value="">Criar nova variável</option>
          {variables.data?.items.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-xs text-carbon-400">Nome
        <input aria-label="Nome da variável" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 font-mono text-base"
          placeholder="NOME_DA_VARIAVEL" value={name}
          onChange={event => { setEditing(true); setName(event.target.value); if (event.target.value !== selected) setVersion(null); }} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-carbon-400">CodeMirror 6 · {detectEnvironmentFormat(value)} · {value.split(/\r?\n/).length} linhas</span>
        <div role="group" aria-label="Modo do editor" className="flex gap-1 rounded-lg border border-carbon-800 p-1">
          <Button size="sm" variant={mode === 'code' ? 'secondary' : 'ghost'} onClick={() => setMode('code')}>Código</Button>
          <Button size="sm" variant={mode === 'fields' ? 'secondary' : 'ghost'}
            disabled={detectEnvironmentFormat(value) === 'json'} onClick={() => setMode('fields')}>Chave e valor</Button>
        </div>
      </div>
      {mode === 'fields' && detectEnvironmentFormat(value) === 'dotenv'
        ? <DotenvFields value={value} onChange={next => { setEditing(true); setValue(next); }} />
        : <CodeMirrorEnvEditor ariaLabel={'Editar ' + (name || 'variável GitHub')}
            value={value} onChange={next => { setEditing(true); setValue(next); }} format={detectEnvironmentFormat(value)} />}
      <p className="text-xs text-amber-300">⚠️ GitHub Actions Variables não são secrets. Revise o repositório e o valor antes de salvar.</p>
      <label className="block space-y-1 text-xs text-carbon-400">Confirmar repositório · {repository}
        <input aria-label="Confirmar repositório" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base"
          value={confirmation} placeholder={repository} onChange={event => setConfirmation(event.target.value)} />
      </label>
      {staleSelection && <p role="alert" className="text-sm text-amber-300">A variável selecionada não está mais disponível. Atualize a lista antes de salvar.</p>}
      {staleVersion && <p role="alert" className="text-sm text-amber-300">A variável foi atualizada no servidor. Selecione-a novamente antes de salvar.</p>}
      {save.error && <IssueBanner error={save.error} />}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Variável salva no GitHub.</p>}
      <Button disabled={!valid} onClick={() => save.mutate()}>Salvar variável</Button>
    </Card>
  </Section>;
}
