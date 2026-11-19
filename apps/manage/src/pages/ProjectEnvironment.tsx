import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Input, Section } from '../components/ui';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
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

type MenuOption = { value: string; label: string };
function ChoiceMenu({ label, value, options, onChange }: {
  label: string; value: string; options: MenuOption[]; onChange: (value: string) => void;
}) {
  const current = options.find(option => option.value === value)?.label ?? 'Selecione…';
  return <div className="space-y-1">
    <span className="block text-xs text-carbon-400">{label}</span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button type="button" variant="outline" aria-label={label}
          className="w-full min-w-0 justify-between text-left text-sm">
          <span className="min-w-0 truncate">{current}</span><ChevronDown size={16} className="shrink-0" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align="start"
          className="z-[100] max-h-[min(55dvh,380px)] min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[90vw] overflow-y-auto overscroll-contain rounded-xl border border-carbon-700 bg-carbon-950 p-1 text-carbon-200 shadow-2xl">
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map(option => <DropdownMenu.RadioItem key={option.value} value={option.value}
              className="relative flex min-h-11 cursor-pointer select-none items-center rounded-lg py-2 pl-9 pr-3 text-sm outline-none focus:bg-carbon-800 data-[state=checked]:text-white">
              <DropdownMenu.ItemIndicator className="absolute left-3"><Check size={15} /></DropdownMenu.ItemIndicator>
              <span className="truncate">{option.label}</span>
            </DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
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
  const [copyRepositorySearch, setCopyRepositorySearch] = useState('');
  const [copyCatalogPage, setCopyCatalogPage] = useState(1);
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
    queryKey: ['github-copy-catalog', copyCatalogPage],
    queryFn: () => api<{ items: { id: string; repository: string; archived: boolean }[]; has_more: boolean; page: number }>(
      '/projects/catalog?page=' + copyCatalogPage),
    retry: false,
    enabled: copyOpen,
  });
  const exactRepositorySearch = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(copyRepositorySearch.trim())
    ? copyRepositorySearch.trim() : '';
  const resolvedDestination = useQuery({
    queryKey: ['github-copy-resolve', exactRepositorySearch],
    queryFn: () => api<{ repository: string; status: string }>(
      '/projects/resolve?repository=' + encodeURIComponent(exactRepositorySearch)),
    enabled: copyOpen && Boolean(exactRepositorySearch) &&
      exactRepositorySearch.toLowerCase() !== repository.toLowerCase(),
    retry: false,
  });
  const destinationOptions = (projectCatalog.data?.items ?? [])
    .filter(item => !item.archived && item.repository !== repository &&
      item.repository.toLowerCase().includes(copyRepositorySearch.toLowerCase()))
    .map(item => ({ value: item.repository, label: item.repository }));
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
      name: originalNameForCopy(), sourceRepository: repository,
      sourceScope: scope, sourceEnvironment: environment,
      sourceVersion: original?.version, confirm: copyTarget,
    }, 'POST'),
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
        <ChoiceMenu label="Escopo GitHub" value={scope}
          options={[{ value: 'repository', label: 'Repositório' }, { value: 'environment', label: 'Environment' }]}
          onChange={next => setScope(next as Scope)} />
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
      <ChoiceMenu label="Selecionar variável GitHub" value={selected}
        options={[{ value: '', label: 'Criar nova variável' }, ...shownVariables.map(item => ({ value: item.name, label: item.name }))]}
        onChange={next => {
          const item = variables.data?.items.find(entry => entry.name === next);
          setSelected(item?.name ?? ''); setName(item?.name ?? '');
          setValue(item?.value ?? ''); setVersion(item?.version ?? null);
          setConfirmation(''); setEditing(false); setSavedMessage('');
        }} />
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
      <Dialog.Root open={copyOpen && Boolean(original)} onOpenChange={setCopyOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[80] bg-black/70" /><Dialog.Content className="fixed inset-x-3 top-1/2 z-[81] mx-auto max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-lg -translate-y-1/2 overflow-y-auto rounded-xl border border-carbon-700 bg-carbon-950 p-5 shadow-2xl space-y-3">
        <div className="flex items-center justify-between gap-2"><Dialog.Title className="text-sm font-semibold">Copiar {original?.name}</Dialog.Title><Dialog.Close aria-label="Fechar" className="rounded-lg px-3 py-2 text-carbon-400">✕</Dialog.Close></div><Dialog.Description className="text-xs text-carbon-400">Copiar variável entre repositórios sem alterar a origem.</Dialog.Description>
        <p className="text-xs text-carbon-400">O servidor lê o valor diretamente no GitHub e verifica se a origem não mudou. Nada é sobrescrito.</p>
        <label className="block space-y-1 text-xs text-carbon-400">Buscar projeto de destino
          <Input aria-label="Buscar projeto de destino" value={copyRepositorySearch}
            placeholder="Filtrar ou digitar owner/repo…" onChange={event => setCopyRepositorySearch(event.target.value)} />
        </label>
        {resolvedDestination.isSuccess && resolvedDestination.data.status !== 'archived' && (
          <Button type="button" size="sm" variant="secondary"
            onClick={() => { setCopyTarget(resolvedDestination.data.repository); setCopyConfirm(''); }}>
            Selecionar {resolvedDestination.data.repository}
          </Button>
        )}
        {resolvedDestination.isError && <p role="alert" className="text-xs text-amber-300">
          Não foi possível acessar esse repositório pela integração GitHub.
        </p>}
        <ChoiceMenu label="Projeto de destino" value={copyTarget}
          options={[{ value: '', label: 'Selecione um projeto' },
            ...destinationOptions, ...(copyTarget && !destinationOptions.some(item => item.value === copyTarget)
              ? [{ value: copyTarget, label: copyTarget }] : [])]}
          onChange={next => { setCopyTarget(next); setCopyConfirm(''); }} />
        {projectCatalog.isPending && <p role="status" className="text-xs text-carbon-400">Carregando projetos…</p>}
        {!projectCatalog.isPending && !destinationOptions.length &&
          <p className="text-xs text-amber-300">Nenhum projeto nesta página. Navegue pelas páginas do catálogo.</p>}
        <div className="flex items-center justify-between gap-2 text-xs text-carbon-400">
          <Button size="sm" variant="outline" disabled={copyCatalogPage === 1 || projectCatalog.isFetching}
            onClick={() => setCopyCatalogPage(page => Math.max(1, page - 1))}>Anterior</Button>
          <span>Página {copyCatalogPage}</span>
          <Button size="sm" variant="outline" disabled={!projectCatalog.data?.has_more || projectCatalog.isFetching}
            onClick={() => setCopyCatalogPage(page => page + 1)}>Próxima</Button>
        </div>
        {projectCatalog.isError && <IssueBanner error={projectCatalog.error} />}
        <ChoiceMenu label="Escopo de destino" value={copyScope}
          options={[{ value: 'repository', label: 'Repositório' }, { value: 'environment', label: 'Environment' }]}
          onChange={next => { setCopyScope(next as Scope); setCopyConfirm(''); }} />
        {copyScope === 'environment' && <label className="block space-y-1 text-xs">Environment de destino
          <Input className="w-full rounded-lg border border-carbon-700 bg-carbon-950 p-3 text-base"
            value={copyEnvironment} onChange={event => setCopyEnvironment(event.target.value)} />
        </label>}
        {destinationVariables.isFetching && <p className="text-xs text-carbon-400">Verificando destino…</p>}
        {destinationVariables.isError && <IssueBanner error={destinationVariables.error} />}
        {destinationExisting && <p role="alert" className="text-sm text-amber-300">Já existe {original?.name ?? selected} no destino. A cópia foi bloqueada para evitar sobrescrita.</p>}
        <label className="block space-y-1 text-xs">Confirme digitando o repositório de destino
          <Input aria-label="Confirmar projeto de destino" className="w-full rounded-lg border border-carbon-700 bg-carbon-950 p-3 text-base"
            value={copyConfirm} placeholder={copyTarget} onChange={event => setCopyConfirm(event.target.value)} />
        </label>
        {copy.error && <IssueBanner error={copy.error} />}
        <Button disabled={!original || !inventoryReady || dirty || staleVersion || !copyTarget || copyTarget === repository || !destinationVariables.isSuccess ||
          destinationVariables.isFetching || Boolean(destinationExisting) || copyConfirm !== copyTarget || copy.isPending}
          onClick={() => copy.mutate()}>{copy.isPending ? 'Copiando…' : 'Confirmar cópia'}</Button>
      </Dialog.Content></Dialog.Portal></Dialog.Root>
    </Card>
  </Section>;
}
