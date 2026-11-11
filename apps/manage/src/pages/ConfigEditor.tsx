import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  CloudCog,
  Code2,
  Copy,
  ExternalLink,
  GitBranch,
  History,
  LoaderCircle,
  Logs,
  Menu,
  Play,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  Shield,
  Terminal,
  Workflow,
  X,
} from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select, Textarea } from '../components/ui';
import { api, send } from '../lib/client';
import { sentryIssueSearch } from '../lib/sentry';
import { findDuplicateConfigKeys, optimizeDotenv, parseConfiguration, planConfigChange } from '../config-reconcile';
import type { ConfigPlan } from '../config-reconcile';
import { cn, date, human, state } from '../lib/utils';
import type { Meta, Run, WF, Job, CloudLog, CfLog, Issue } from '../types';
import { External, Spinner, Empty, IssueBanner } from '../components/shared';
import { RunRow, RunDetail } from '../components/runs';
import { ConfirmDialog } from '../components/confirm-dialog';
import { CodeMirrorEnvEditor, detectEnvironmentFormat } from '../components/codemirror-env-editor';
import { DotenvFields } from '../components/dotenv-fields';
import { RepositoryVariables } from './RepositoryVariables';
export function ConfigEditor() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['config'],
    queryFn: () => api<{ value: string; version: string; updated_at: string }>('/config'),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const [editor, setEditor] = useState('');
  const [editorMode, setEditorMode] = useState<'code' | 'fields'>('code');
  const [version, setVersion] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [autoApply, setAutoApply] = useState(true);
  const [lastSave, setLastSave] = useState<{
    plan: ConfigPlan;
    dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }>;
    blocked?: boolean;
    auto_apply?: boolean;
  } | null>(null);
  useEffect(() => {
    if (q.data) {
      setEditor(q.data.value);
      setVersion(q.data.version);
    }
  }, [q.data]);
  const update = useMutation({
    mutationFn: () =>
      send<{
        version: string;
        plan: ConfigPlan;
        dispatches: Array<{ file: string; label: string; status: 'queued' | 'failed'; error?: string }>;
        blocked?: boolean;
        auto_apply?: boolean;
      }>('/config', { value: editor, version, auto_apply: autoApply }, 'PUT'),
    onSuccess: (r) => {
      setVersion(r.version);
      setLastSave(r);
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const optimization = useMemo(() => optimizeDotenv(editor), [editor]);
  const [optimizationPreview, setOptimizationPreview] = useState(false);
  const duplicates = useMemo(() => findDuplicateConfigKeys(editor), [editor]);
  const resolvedPreview = useMemo(() => {
    if (!editor.trim() || editor.trimStart().startsWith('{')) return null;
    try {
      const entries = parseConfiguration(editor);
      return { entries: Object.entries(entries).filter(([key]) =>
        !/SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|KEY|AUTH|SESSION/i.test(key)), error: '' };
    } catch (error) {
      return { entries: [] as Array<[string, string]>,
        error: error instanceof Error ? error.message : 'Referência inválida' };
    }
  }, [editor]);
  const dirty = Boolean(q.data && editor !== q.data.value);
  const preview = useMemo(() => {
    if (!q.data || !dirty) return null;
    try {
      return { plan: planConfigChange(q.data.value, editor), error: '' };
    } catch {
      return { plan: null, error: 'Não foi possível calcular o plano: confira o formato do .env.' };
    }
  }, [q.data, dirty, editor]);
  const validation = useMemo(() => {
    if (!editor.trim()) return 'Configuração vazia';
    if (editor.trim().startsWith('{'))
      try {
        JSON.parse(editor);
        return null;
      } catch {
        return 'JSON inválido';
      }
    try {
      parseConfiguration(editor);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Configuração inválida';
    }
  }, [editor]);
  return (
    <div className="space-y-4">
      <Section title="GCP_CONFIG_ENV" detail="GitHub · Environment production · Variável versionada por hash">
        {q.isPending ? (
          <Spinner />
        ) : q.error ? (
          <IssueBanner error={q.error} />
        ) : (
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <Badge tone={dirty ? 'warning' : 'success'}>{dirty ? 'Não salvo' : 'Sincronizado'}</Badge>
              <span className="text-xs text-carbon-500">Editado {date(q.data?.updated_at)}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-carbon-400">
              <span>CodeMirror 6 · {detectEnvironmentFormat(editor) === 'json' ? 'JSON' : 'dotenv'}</span>
              <span>{editor.split(/\r?\n/).length} linhas · comentários preservados</span>
            </div>
            <div
              className="inline-flex flex-wrap gap-1 rounded-lg border border-carbon-800 p-1"
              role="group"
              aria-label="Modo do editor"
            >
              <Button
                type="button"
                size="sm"
                variant={editorMode === 'code' ? 'secondary' : 'ghost'}
                onClick={() => setEditorMode('code')}
              >
                Código
              </Button>
              <Button
                type="button"
                size="sm"
                variant={editorMode === 'fields' ? 'secondary' : 'ghost'}
                onClick={() => setEditorMode('fields')}
                disabled={detectEnvironmentFormat(editor) === 'json'}
              >
                Chave e valor
              </Button>
            </div>
            {editorMode === 'fields' && detectEnvironmentFormat(editor) === 'dotenv' ? (
              <DotenvFields value={editor} onChange={setEditor} />
            ) : (
              <CodeMirrorEnvEditor
                value={editor}
                onChange={setEditor}
                format={detectEnvironmentFormat(editor)}
                ariaLabel="Editar GCP_CONFIG_ENV"
              />
            )}
            {detectEnvironmentFormat(editor) === 'dotenv' && (
              <div className="space-y-2 rounded-lg border border-carbon-800 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-carbon-200">Otimização segura do .env</span>
                  <Button type="button" size="sm" variant="secondary"
                    onClick={() => setOptimizationPreview((current) => !current)}>
                    {optimizationPreview ? 'Ocultar prévia' : 'Otimizar configuração'}
                  </Button>
                </div>
                {optimizationPreview && (
                  <div className="space-y-2">
                    <p className="text-carbon-400">
                      {optimization.changes.length} referências podem ser compactadas.
                      Nada será salvo automaticamente.
                    </p>
                    {optimization.changes.map((change) => (
                      <p key={change} className="text-carbon-300">{change}</p>
                    ))}
                    {optimization.warnings.map((warning, index) => (
                      <p key={index} className="text-amber-300">{warning}</p>
                    ))}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border
                      border-carbon-800 p-2 text-carbon-300">{optimization.value}</pre>
                    <Button type="button" size="sm" disabled={!optimization.changes.length}
                      onClick={() => { setEditor(optimization.value); setOptimizationPreview(false); }}>
                      Aplicar no editor (sem salvar)
                    </Button>
                  </div>
                )}
              </div>
            )}
            {resolvedPreview && (
              <details className="rounded-lg border border-carbon-800 p-3 text-xs">
                <summary className="cursor-pointer text-carbon-200">
                  Prévia de referências resolvidas (somente campos públicos)
                </summary>
                {resolvedPreview.error && <p className="mt-2 text-red-300">{resolvedPreview.error}</p>}
                <div className="mt-2 max-h-64 space-y-1 overflow-auto font-mono">
                  {resolvedPreview.entries.map(([key, value]) => (
                    <div key={key} className="break-all text-carbon-400">
                      <span className="text-carbon-200">{key}</span> = {value}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-carbon-500">
                  Campos potencialmente sensíveis são ocultados. Nenhum valor é publicado nesta prévia.
                </p>
              </details>
            )}
            {duplicates.length > 0 && (
              <p className="text-xs leading-5 text-amber-300">
                Chaves repetidas:{' '}
                {duplicates.map((item) => item.key + ' (linhas ' + item.lines.join(', ') + ')').join('; ')}.
                Valores idênticos são preservados; valores conflitantes impedem o salvamento. Nenhum
                comentário ou linha será excluído automaticamente.
              </p>
            )}
            {validation && <p className="text-xs text-red-300">{validation}</p>}
            {preview?.error && <p className="text-xs text-red-300">{preview.error}</p>}
            {preview?.plan && (
              <div className="rounded-lg border border-[#34363b] bg-white/[.025] p-3 text-xs">
                <p className="font-semibold text-carbon-200">
                  {preview.plan.changed.length} variáveis alteradas
                </p>
                <p className="mt-1 text-carbon-400">
                  {preview.plan.workflows.length
                    ? 'Ao salvar: ' + preview.plan.workflows.map((item) => item.label).join(' · ')
                    : 'Nenhuma publicação automática necessária.'}
                </p>
                {preview.plan.manual.map((reason) => (
                  <p key={reason} className="mt-2 text-amber-300">
                    Atenção: {reason}
                  </p>
                ))}
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-carbon-300">
              <input
                type="checkbox"
                checked={autoApply}
                onChange={(event) => setAutoApply(event.target.checked)}
                className="h-4 w-4 accent-white"
              />
              Aplicar automaticamente as alterações ao salvar
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (q.data) setEditor(q.data.value);
                  }}
                  disabled={!dirty}
                >
                  <RotateCcw size={14} />
                  Reverter
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    try {
                      setEditor(JSON.stringify(JSON.parse(editor), null, 2));
                    } catch {}
                  }}
                >
                  <Code2 size={14} />
                  Formatar JSON
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(editor)}>
                  <Copy size={14} />
                </Button>
              </div>
              <Button
                size="sm"
                onClick={() => setConfirm(true)}
                disabled={!dirty || !!validation || !!preview?.error || update.isPending}
              >
                <Save size={15} />
                Salvar variável
              </Button>
            </div>
            <p className="text-xs leading-5 text-carbon-500">
              O painel edita uma variável do GitHub, não um secret. O Telegram aceita token diretamente no
              .env, mas o valor poderá ser visto por quem tem acesso às variáveis do repositório e à
              configuração do Cloud Run. Prefira um GitHub Environment Secret ou Secret Manager se precisar de
              sigilo forte. Alterações de runtime sincronizam sem reconstruir Docker.
            </p>
            {update.error && <IssueBanner error={update.error} />}
            {lastSave && (
              <div className="space-y-2 rounded-lg border border-[#32353b] p-3 text-xs">
                <Badge tone="success">Configuração salva no GitHub</Badge>
                {lastSave.blocked && (
                  <p className="text-amber-300">
                    Publicação suspensa: é necessário revisar IAM ou infraestrutura antes de executar.
                  </p>
                )}
                {!lastSave.auto_apply && (
                  <p className="text-carbon-400">Aplicação automática desativada neste salvamento.</p>
                )}
                {lastSave.dispatches.map((item) => (
                  <p key={item.file} className={item.status === 'failed' ? 'text-red-300' : 'text-carbon-300'}>
                    {item.status === 'queued' ? '✓ Solicitado' : '✕ Falha ao solicitar'}: {item.label}
                    {item.error ? ' · ' + item.error : ''}{' '}
                    <a
                      href={'https://github.com/rodkisten/photointel/actions/workflows/' + item.file}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      Abrir Actions
                    </a>
                  </p>
                ))}
                {lastSave.plan.manual.map((reason) => (
                  <p key={reason} className="text-amber-300">
                    Revisão manual: {reason}
                  </p>
                ))}
                {lastSave.plan.changed.length === 0 && (
                  <p className="text-carbon-400">Somente formatação alterada; nenhum workflow necessário.</p>
                )}
              </div>
            )}
          </Card>
        )}
      </Section>
      <RepositoryVariables />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Salvar configuração de produção?"
        description={
          autoApply
            ? 'O GitHub Environment será salvo e os workflows necessários serão solicitados automaticamente. Alterações que exigem IAM ou migração permanecerão pendentes de revisão.'
            : 'Isso salva GCP_CONFIG_ENV sem disparar workflows. Será necessário aplicar as alterações manualmente.'
        }
        label="Salvar"
        onConfirm={() => update.mutate()}
        busy={update.isPending}
      />
    </div>
  );
}
