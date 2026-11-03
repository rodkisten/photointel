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
  const [mode, setMode] = useState<'code' | 'fields'>('code');
  const variables = useQuery({
    queryKey: ['github-variables', scope],
    queryFn: () => api<{ scope: Scope; items: Variable[] }>('/github/variables?scope=' + scope),
    retry: false,
  });

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
    mutationFn: () => send('/github/variables?scope=' + scope, { name, value, version }, 'PUT'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['github-variables', scope] });
    },
  });
  const unchanged = Boolean(existing && name === existing.name && value === (existing.value ?? ''));
  const valid = /^[A-Z_][A-Z0-9_]{0,99}$/.test(name) && name !== 'GCP_CONFIG_ENV' && value.length <= 120_000;
  return (
    <Section
      title="Variáveis do GitHub"
      detail="Variáveis adicionais do repositório e do environment, além de GCP_CONFIG_ENV"
    >
      <Card className="space-y-4 p-4">
        <p className="flex items-start gap-2 text-xs leading-5 text-amber-300">
          <AlertTriangle size={16} className="shrink-0" />
          GitHub Actions Variables não são secrets. Para senha Apple, tokens e credenciais, use Secret
          Manager. Alterar estas variáveis não dispara deploy automaticamente; GCP_CONFIG_ENV mantém seu fluxo
          próprio.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-400">
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
          <label className="space-y-1 text-xs text-slate-400">
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
        <label className="space-y-1 text-xs text-slate-400">
          Chave
          <Input
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase())}
            placeholder="NOME_DA_VARIAVEL"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge tone={unchanged ? 'success' : 'warning'}>{unchanged ? 'Sincronizado' : 'Não salvo'}</Badge>
          <Button
            disabled={!valid || unchanged || variables.isPending || save.isPending}
            onClick={() => save.mutate()}
          >
            {selected ? <Save size={15} /> : <Plus size={15} />}
            {save.isPending ? 'Salvando…' : selected ? 'Salvar variável' : 'Criar variável'}
          </Button>
        </div>
        {save.isSuccess && (
          <p className="text-xs text-emerald-300">
            Variável salva. Reabra a lista para conferir a versão atual.
          </p>
        )}
        {save.error && <IssueBanner error={save.error} />}
      </Card>
    </Section>
  );
}
