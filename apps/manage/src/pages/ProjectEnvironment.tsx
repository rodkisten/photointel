import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Section } from '../components/ui';
import { CodeMirrorEnvEditor, detectEnvironmentFormat } from '../components/codemirror-env-editor';
import { DotenvFields } from '../components/dotenv-fields';
import { IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';

type Variable = { name: string; value: string; version: string };
type Scope = 'repository' | 'environment';

/** Prefer content evidence; names are only a fallback for empty/new configuration values. */
function isEnvironmentLike(variable: Variable): boolean {
  const name = variable.name.toUpperCase();
  const value = variable.value.trim();
  if (value.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return true;
    } catch { /* malformed JSON is still editable if explicitly named as configuration */ }
  }
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (lines.length > 0 && lines.every(line => /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))) return true;
  return /(?:^|_)(?:ENV|ENVIRONMENT|DOTENV|CONFIG_ENV|ENV_VARS)(?:_|$)/.test(name);
}

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
  const [category, setCategory] = useState<'environment' | 'simple'>('environment');
  const [editing, setEditing] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState('');
  const [copyScope, setCopyScope] = useState<Scope>('repository');
  const [copyEnvironment, setCopyEnvironment] = useState('production');
  const [copyConfirm, setCopyConfirm] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
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
    setSelected(''); setName(''); setValue(''); setVersion(null); setConfirmation(''); setEditing(false); setSavedMessage('');
  }, [repository, scope, environment]);
  const save = useMutation({
    mutationFn: (input: { name: string; value: string; version: string | null; confirm: string }) =>
      send(endpoint, input, 'PUT'),
    onSuccess: () => {
      setConfirmation('');
      setEditing(false);
      setSavedMessage('Variável salva no GitHub. Atualizando inventário…');
      setSelected(''); setName(''); setValue(''); setVersion(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const projectCatalog = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ items: { id: string; repository: string; enabled: boolean }[] }>('/projects'),
    retry: false,
    enabled: copyOpen,
  });
  const copyEndpoint = '/projects/variables?repository=' + encodeURIComponent(copyTarget) +
    '&scope=' + copyScope + '&environment=' + encodeURIComponent(copyEnvironment);
  const destinationVariables = useQuery({
    queryKey: ['project-variables', copyTarget, copyScope, copyEnvironment],
    queryFn: () => api<{ items: Variable[] }>(copyEndpoint),
    enabled: copyOpen && Boolean(copyTarget) && (copyScope === 'repository' || Boolean(copyEnvironment.trim())),
    retry: false,
  });
  const destinationExisting = destinationVariables.data?.items.find(item => item.name === originalNameForCopy());
  function originalNameForCopy() { return selected || name; }
  const copy = useMutation({
    mutationFn: () => send(copyEndpoint, {
      name: originalNameForCopy(), value: variables.data?.items.find(item => item.name === selected)?.value ?? '',
      version: null, confirm: copyTarget,
    }, 'PUT'),
    onSuccess: () => {
      setCopyMessage('Variável copiada para ' + copyTarget + '.');
      setCopyOpen(false);
      setCopyConfirm('');
      void client.invalidateQueries({ queryKey: ['project-variables', copyTarget] });
    },
  });
  const otherScope = scope === 'repository' ? 'environment' : 'repository';
  const otherEndpoint = '/projects/variables?repository=' + encodeURIComponent(repository) +
    '&scope=' + otherScope + '&environment=' + encodeURIComponent(environment);
  const otherVariables = useQuery({
    queryKey: ['project-variables', repository, otherScope, environment],
    queryFn: () => api<{ items: Variable[] }>(otherEndpoint),
    enabled: Boolean(repository && environment.trim()),
    retry: false,
  });
  const otherEnvironmentCount = (otherVariables.data?.items ?? []).filter(isEnvironmentLike).length;
  const environmentVariables = (variables.data?.items ?? []).filter(isEnvironmentLike);
  const simpleVariables = (variables.data?.items ?? []).filter(item => !isEnvironmentLike(item));
  const shownVariables = category === 'environment' ? environmentVariables : simpleVariables;
  const original = variables.data?.items.find(item => item.name === selected);
  const useCodeEditor = category === 'environment' || (original ? isEnvironmentLike(original) : false);
  const inventoryReady = variables.isSuccess && !variables.isFetching;
  const dirty = editing && (name !== (original?.name ?? '') || value !== (original?.value ?? ''));
  const staleSelection = Boolean(selected && !original);
  const staleVersion = Boolean(original && version !== original.version);
  const renameAttempt = Boolean(selected && name !== selected);
  const existingName = variables.data?.items.some(item => item.name === name && item.name !== selected);
  const valid = /^[A-Z_][A-Z0-9_]{0,99}$/.test(name) && value.length <= 120_000 &&
    inventoryReady &&
    !renameAttempt && !existingName && confirmation === repository &&
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
      {environmentVariables.length === 0 && otherEnvironmentCount > 0 && (
        <div className="rounded-lg border border-emerald-500/30 p-3 text-sm text-emerald-300">
          Encontramos {otherEnvironmentCount} configuração(ões) no escopo {otherScope === 'environment' ? 'Environment' : 'Repositório'}.
          <Button size="sm" variant="secondary" onClick={() => setScope(otherScope)}>
            Abrir {otherScope === 'environment' ? 'Environment' : 'Repositório'}
          </Button>
        </div>
      )}
      {environmentVariables.length === 0 && otherVariables.isSuccess && otherEnvironmentCount === 0 && (
        <p className="text-xs text-carbon-400">Nenhuma configuração estruturada detectada nos escopos consultados. Variáveis simples permanecem disponíveis.</p>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de variável">
        <Button size="sm" variant={category === 'environment' ? 'secondary' : 'ghost'} onClick={() => { setCategory('environment'); setSelected(''); setName(''); setValue(''); setVersion(null); setEditing(false); setConfirmation(''); }}>
          Ambientes ({environmentVariables.length})
        </Button>
        <Button size="sm" variant={category === 'simple' ? 'secondary' : 'ghost'} onClick={() => { setCategory('simple'); setSelected(''); setName(''); setValue(''); setVersion(null); setEditing(false); setConfirmation(''); }}>
          Variáveis comuns ({simpleVariables.length})
        </Button>
      </div>
      <label className="block space-y-1 text-xs text-carbon-400">Variável
        <select aria-label="Selecionar variável GitHub" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base"
          value={selected} onChange={event => {
            const item = variables.data?.items.find(entry => entry.name === event.target.value);
            setSelected(item?.name ?? ''); setName(item?.name ?? '');
            setValue(item?.value ?? ''); setVersion(item?.version ?? null); setConfirmation(''); setEditing(false); setSavedMessage('');
          }}>
          <option value="">Criar nova variável</option>
          {shownVariables.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-xs text-carbon-400">Nome
        <input aria-label="Nome da variável" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 font-mono text-base"
          placeholder="NOME_DA_VARIAVEL" value={name}
          onChange={event => { setEditing(true); setSavedMessage(''); setName(event.target.value.toUpperCase()); }} />
      </label>
      {useCodeEditor ? <>
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
      </> : <label className="block space-y-1 text-xs text-carbon-400">Valor
        <input aria-label="Valor da variável" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base" value={value}
          onChange={event => { setEditing(true); setValue(event.target.value); }} />
      </label>}
      <p className="text-xs text-amber-300">⚠️ GitHub Actions Variables não são secrets. Revise o repositório e o valor antes de salvar.</p>
      <label className="block space-y-1 text-xs text-carbon-400">Confirmar repositório · {repository}
        <input aria-label="Confirmar repositório" className="w-full rounded-lg border border-carbon-700 bg-carbon-900 p-3 text-base"
          value={confirmation} placeholder={repository} onChange={event => setConfirmation(event.target.value)} />
      </label>
      {renameAttempt && <p role="alert" className="text-sm text-amber-300">Para criar outra variável, selecione “Criar nova variável”. Renomear uma variável existente não é suportado.</p>}
      {existingName && <p role="alert" className="text-sm text-amber-300">Já existe uma variável com esse nome. Selecione-a na lista para editar.</p>}
      {staleSelection && <p role="alert" className="text-sm text-amber-300">A variável selecionada não está mais disponível. Atualize a lista antes de salvar.</p>}
      {staleVersion && <p role="alert" className="text-sm text-amber-300">A variável foi atualizada no servidor. Selecione-a novamente antes de salvar.</p>}
      {variables.isFetching && !variables.isPending && <p role="status" className="text-xs text-carbon-400">Atualizando variáveis do GitHub…</p>}
      {save.error && <IssueBanner error={save.error} />}
      {savedMessage && <p role="status" className="text-sm text-emerald-400">{savedMessage}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!valid} onClick={() => save.mutate({ name, value, version, confirm: confirmation })}>Salvar variável</Button>
        <Button variant="secondary" disabled={!selected || !original || !inventoryReady || dirty}
          onClick={() => { setCopyOpen(open => !open); setCopyMessage(''); setCopyConfirm(''); }}>
          Copiar para outro projeto
        </Button>
      </div>
      {copyMessage && <p role="status" className="text-sm text-emerald-400">{copyMessage}</p>}
      {copyOpen && original && <div className="space-y-3 rounded-xl border border-carbon-700 bg-carbon-900/60 p-4">
        <h3 className="text-sm font-semibold">Copiar {original.name}</h3>
        <p className="text-xs text-carbon-400">A origem permanece intacta. A cópia usa o valor salvo no GitHub, não alterações locais.</p>
        <label className="block space-y-1 text-xs">Projeto de destino
          <select aria-label="Projeto de destino" className="w-full rounded-lg border border-carbon-700 bg-carbon-950 p-3 text-base"
            value={copyTarget} onChange={event => { setCopyTarget(event.target.value); setCopyConfirm(''); }}>
            <option value="">Selecione um projeto</option>
            {(projectCatalog.data?.items ?? []).filter(item => item.repository !== repository).map(item =>
              <option key={item.repository} value={item.repository}>{item.repository}</option>)}
          </select>
        </label>
        {projectCatalog.isError && <IssueBanner error={projectCatalog.error} />}
        <label className="block space-y-1 text-xs">Escopo de destino
          <select className="w-full rounded-lg border border-carbon-700 bg-carbon-950 p-3 text-base"
            value={copyScope} onChange={event => { setCopyScope(event.target.value as Scope); setCopyConfirm(''); }}>
            <option value="repository">Repositório</option><option value="environment">Environment</option>
          </select>
        </label>
        {copyScope === 'environment' && <label className="block space-y-1 text-xs">Environment de destino
          <input className="w-full rounded-lg border border-carbon-700 bg-carbon-950 p-3 text-base"
            value={copyEnvironment} onChange={event => setCopyEnvironment(event.target.value)} />
        </label>}
        {destinationVariables.isFetching && <p className="text-xs text-carbon-400">Verificando destino…</p>}
        {destinationVariables.isError && <IssueBanner error={destinationVariables.error} />}
        {destinationExisting && <p role="alert" className="text-sm text-amber-300">Já existe {original.name} no destino. A cópia foi bloqueada para evitar sobrescrita.</p>}
        <label className="block space-y-1 text-xs">Confirme digitando o repositório de destino
          <input aria-label="Confirmar projeto de destino" className="w-full rounded-lg border border-carbon-700 bg-carbon-950 p-3 text-base"
            value={copyConfirm} placeholder={copyTarget} onChange={event => setCopyConfirm(event.target.value)} />
        </label>
        {copy.error && <IssueBanner error={copy.error} />}
        <Button disabled={!copyTarget || copyTarget === repository || !destinationVariables.isSuccess ||
          destinationVariables.isFetching || Boolean(destinationExisting) || copyConfirm !== copyTarget || copy.isPending}
          onClick={() => copy.mutate()}>{copy.isPending ? 'Copiando…' : 'Confirmar cópia'}</Button>
      </div>}
    </Card>
  </Section>;
}
