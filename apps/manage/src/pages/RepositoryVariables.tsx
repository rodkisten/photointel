import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Save } from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select } from '../components/ui';
import { CodeMirrorEnvEditor, detectEnvironmentFormat } from '../components/codemirror-env-editor';
import { DotenvFields } from '../components/dotenv-fields';
import { IssueBanner, Spinner } from '../components/shared';
import { api, send } from '../lib/client';

type Scope = 'repository' | 'environment';
type Variable = { name: string; value: string | null; version: string; updated_at?: string };

export function RepositoryVariables() {
  const client = useQueryClient();
  const [scope, setScope] = useState<Scope>('environment');
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [dispatch, setDispatch] = useState<'queued' | 'failed' | 'none'>('none');
  const [triggerResults, setTriggerResults] = useState<Array<{ target: string; status: string }>>([]);
  const [mode, setMode] = useState<'code' | 'fields'>('code');
  const [triggerMode, setTriggerMode] = useState<'none' | 'workflows' | 'webhook'>('none');
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [tab, setTab] = useState<'variables' | 'triggers'>('variables');
  const triggerRules = useQuery({
    queryKey: ['variable-triggers'],
    queryFn: () => api<{ rules: Record<string, { mode: 'none' | 'workflows' | 'webhook'; workflows?: string[]; webhook?: string }>; version: string }>('/github/variable-triggers'),
    retry: false,
  });
  const [rulesConfirm, setRulesConfirm] = useState('');
  const saveRules = useMutation({
    mutationFn: () => send('/github/variable-triggers', {
      rules: { ...(triggerRules.data?.rules || {}), [name]: { mode: triggerMode, workflows: selectedWorkflows, webhook: webhookUrl } },
      version: triggerRules.data?.version, confirm: rulesConfirm,
    }, 'PUT'),
    onSuccess: () => { setRulesConfirm(''); void client.invalidateQueries({ queryKey: ['variable-triggers'] }); },
  });
  const workflows = useQuery({
    queryKey: ['workflow-catalog'],
    queryFn: () => api<{ workflows: Array<{ name: string; path: string }> }>('/github/workflow-catalog'),
    retry: false,
  });
  const variables = useQuery({
    queryKey: ['github-variables', scope],
    queryFn: () => api<{ scope: Scope; items: Variable[] }>('/github/variables?scope=' + scope),
    retry: false,
  });

  const activeRule = triggerRules.data?.rules[name];
  useEffect(() => { setTriggerMode(activeRule?.mode || 'none'); setSelectedWorkflows(activeRule?.workflows || []); setWebhookUrl(activeRule?.webhook || ''); }, [name, activeRule?.mode, triggerRules.data?.version]);
  const existing = useMemo(
    () => variables.data?.items.find((item) => item.name === selected),
    [variables.data, selected],
  );
  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setValue(existing.value ?? '');
    setVersion(existing.version);
  }, [existing]);
  const save = useMutation({
    mutationFn: () => send<{ dispatch: 'queued' | 'failed' | 'none'; triggered?: Array<{ target: string; status: string }> }>('/github/variables?scope=' + scope, { name, value, version, confirm: confirmation }, 'PUT'),
    onSuccess: (result) => {
      setDispatch(result.dispatch);
      setTriggerResults(result.triggered || []);
      setConfirmation('');
      void client.invalidateQueries({ queryKey: ['github-variables', scope] });
    },
  });
  const isGcpEnvVars = name === 'GCP_ENV_VARS';
  const triggersManage = (name === 'GCP_COST_ALERT_USD' && scope === 'environment') || isGcpEnvVars || activeRule?.mode === 'workflows' || activeRule?.mode === 'webhook';
  const unchanged = Boolean(existing && name === existing.name && value === (existing.value ?? ''));
  const valid = /^[A-Z_][A-Z0-9_]{0,99}$/.test(name) && name !== 'GCP_CONFIG_ENV' && value.length <= 120_000;
  return (
    <Section
      title="Variáveis do GitHub"
      detail="Variáveis adicionais do repositório e do environment, além de GCP_CONFIG_ENV"
    >
      <div className="flex gap-2 border-b border-carbon-800 pb-2">
        <Button size="sm" variant={tab === 'variables' ? 'secondary' : 'ghost'} onClick={() => setTab('variables')}>Variáveis</Button>
        <Button size="sm" variant={tab === 'triggers' ? 'secondary' : 'ghost'} onClick={() => setTab('triggers')}>Triggers</Button>
      </div>
      <Card className="space-y-4 p-4">
        <p className="flex items-start gap-2 text-xs leading-5 text-amber-300">
          <AlertTriangle size={16} className="shrink-0" />
          GitHub Actions Variables não são secrets. Para senha Apple, tokens e credenciais, use Secret
          Manager. Alterações comuns não disparam deploy. GCP_COST_ALERT_USD aciona Manage Deploy somente após confirmação.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-carbon-400">
            Local
            <Select
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as Scope);
                setSelected('');
                setName('');
                setValue('');
                setVersion(null);
              }}
            >
              <option value="environment">Environment · production</option>
              <option value="repository">Repositório</option>
            </Select>
          </label>
          <label className="space-y-1 text-xs text-carbon-400">
            Variável
            <Select
              value={selected}
              onChange={(event) => {
                const next = variables.data?.items.find((item) => item.name === event.target.value);
                setSelected(event.target.value);
                setName(next?.name ?? '');
                setValue(next?.value ?? '');
                setVersion(next?.version ?? null);
              }}
            >
              <option value="">Criar nova variável</option>
              {(variables.data?.items ?? [])
                .filter((item) => item.name !== 'GCP_CONFIG_ENV')
                .map((item) => (
                  <option value={item.name} key={item.name}>
                    {item.name}
                  </option>
                ))}
            </Select>
          </label>
        </div>
        {variables.isPending && <Spinner />}
        {variables.error && <IssueBanner error={variables.error} />}
        <label className="space-y-1 text-xs text-carbon-400">
          Chave
          <Input
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase())}
            placeholder="NOME_DA_VARIAVEL"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-carbon-400">
          <span>Valor · {value.split('\n').length} linhas</span>
          <div className="flex gap-1">
            <Button
              variant={mode === 'code' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMode('code')}
            >
              Código
            </Button>
            <Button
              variant={mode === 'fields' ? 'secondary' : 'ghost'}
              size="sm"
              disabled={detectEnvironmentFormat(value) === 'json'}
              onClick={() => setMode('fields')}
            >
              Chave + valor
            </Button>
          </div>
        </div>
        {mode === 'fields' && detectEnvironmentFormat(value) === 'dotenv' ? (
          <DotenvFields value={value} onChange={setValue} />
        ) : (
          <CodeMirrorEnvEditor
            ariaLabel={'Valor da variável ' + name}
            value={value}
            onChange={setValue}
            format={detectEnvironmentFormat(value)}
          />
        )}
        {triggersManage && <div className="space-y-2 rounded-lg border border-amber-700 p-3 text-xs text-amber-200">
          <p role="alert" className="font-semibold">{isGcpEnvVars
            ? '⚠️ ALTERAÇÃO CRÍTICA: GCP_ENV_VARS pode afetar serviços em produção. Confira as alterações e os workflows abaixo antes de confirmar.'
            : name === 'GCP_COST_ALERT_USD'
              ? 'Atenção: mudar esta variável acionará Manage Deploy. Digite confirma.'
              : 'Atenção: mudar esta variável acionará os gatilhos configurados. Digite confirma.'}</p>
          {isGcpEnvVars && <p>Gatilhos: {activeRule?.mode === 'workflows'
            ? (activeRule.workflows?.join(', ') || 'nenhum workflow selecionado')
            : activeRule?.mode === 'webhook' ? 'Webhook Relay' : 'nenhum configurado'}. A variável será salva mesmo sem gatilhos.</p>}
          <Input aria-label="Confirmação de workflow" value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)} placeholder="confirma" />
        </div>}
        {tab === 'triggers' && <div className="space-y-3 rounded-xl border border-carbon-800 p-3 text-xs">
          <p className="font-semibold">Ações ao alterar {name || 'a variável selecionada'}</p>
          {isGcpEnvVars && <p role="alert" className="rounded-lg border border-amber-600 bg-amber-950/40 p-3 font-semibold text-amber-200">⚠️ GCP_ENV_VARS: alterações podem modificar o ambiente de produção. Configure apenas workflows apropriados e revise antes de salvar.</p>
          <Select value={triggerMode} onChange={event => setTriggerMode(event.target.value as typeof triggerMode)}>
            <option value="none">Sem gatilho adicional</option>
            <option value="workflows">Workflows do GitHub</option>
            <option value="webhook">Webhook</option>
          </Select>
          {triggerMode === 'workflows' && <div className="max-h-64 space-y-2 overflow-y-auto">
            {workflows.isPending && <Spinner />}
            {workflows.error && <IssueBanner error={workflows.error} />}
            {(workflows.data?.workflows || []).map(w => <label key={w.path} className="flex items-center gap-2">
              <input type="checkbox" checked={selectedWorkflows.includes(w.path)}
                onChange={event => setSelectedWorkflows(current => event.target.checked ? [...current, w.path] : current.filter(x => x !== w.path))} />
              <span>{w.name} <span className="text-carbon-500">({w.path})</span></span>
            </label>)}
          </div>}
          {triggerMode === 'webhook' && <Input value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} placeholder="https://..." aria-label="URL do webhook" />}
          <p className="text-carbon-500">As regras são salvas no GitHub Environment. Somente workflows com workflow_dispatch podem ser iniciados. Webhooks aceitam apenas o Relay autorizado e nunca recebem valores de variáveis.</p>
          <Input value={rulesConfirm} onChange={event => setRulesConfirm(event.target.value)} placeholder="confirma" aria-label="Confirmar salvamento de gatilhos" />
          <Button size="sm" disabled={!name || rulesConfirm !== 'confirma' || saveRules.isPending || triggerRules.isPending}
            onClick={() => saveRules.mutate()}>Salvar gatilhos</Button>
          {saveRules.isSuccess && <p className="text-emerald-300">Regras salvas.</p>}
          {saveRules.error && <IssueBanner error={saveRules.error} />}
        </div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge tone={unchanged ? 'success' : 'warning'}>{unchanged ? 'Sincronizado' : 'Não salvo'}</Badge>
          <Button
            disabled={!valid || unchanged || variables.isPending || save.isPending || (triggersManage && confirmation !== 'confirma')}
            onClick={() => save.mutate()}
          >
            {selected ? <Save size={15} /> : <Plus size={15} />}
            {save.isPending ? 'Salvando…' : selected ? 'Salvar variável' : 'Criar variável'}
          </Button>
        </div>
        {triggerResults.map((result, index) => <p key={index} className="text-xs text-carbon-300">
          {result.target}: {result.status === 'queued' ? 'Solicitado' : 'Falhou'}
        </p>)}
        {save.isSuccess && (
          <p className="text-xs text-emerald-300">
            Variável salva. {dispatch === 'queued' ? 'Manage Deploy solicitado.' : dispatch === 'failed' ? 'Atenção: falhou o disparo do Manage Deploy; execute manualmente.' : 'Reabra a lista para conferir a versão atual.'}
          </p>
        )}
        {save.error && <IssueBanner error={save.error} />}
      </Card>
    </Section>
  );
}
