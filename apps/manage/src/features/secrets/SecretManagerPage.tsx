import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCcw, Search, RotateCcw, ShieldCheck } from 'lucide-react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { Badge, Button, Card, Input, Section } from '../../components/ui';
import { Empty, IssueBanner, Spinner } from '../../components/shared';
import { api, send } from '../../lib/client';
import { CreateSecretForm } from './CreateSecretForm';
import { SecretList } from './SecretList';
import { SecretVersionCard } from './SecretVersionCard';
import { SecretVersionForm } from './SecretVersionForm';
import { SecretVersionHistory } from './SecretVersionHistory';
import type {
  SecretActivation, SecretPreview, SecretResult, SecretsList, SecretVersions,
} from './types';

export function SecretManagerPage() {
  const qc = useQueryClient();
  const [name, setName] = useState(() => new URLSearchParams(window.location.search).get('secret') || '');
  const [search, setSearch] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const [pageToken, setPageToken] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [result, setResult] = useState<SecretResult | null>(null);
  const [createdName, setCreatedName] = useState('');
  const [activateConfirm, setActivateConfirm] = useState(false);
  const [activated, setActivated] = useState<SecretActivation | null>(null);
  const [permissionsConfirm, setPermissionsConfirm] = useState(false);

  const list = useQuery({
    queryKey: ['manage-secret-references'],
    queryFn: () => api<SecretsList>('/secrets'),
    retry: false,
    staleTime: 0,
  });
  const items = list.data?.items || [];
  const filtered = items.filter((item) =>
    (item.name + ' ' + item.references.map((ref) => ref.key).join(' '))
      .toLowerCase().includes(search.toLowerCase().trim()));
  const selected = filtered.find((item) => item.name === name || item.references.some((ref) => ref.key === name)) || filtered[0] || (search.trim() ? undefined : items[0]);

  const versions = useQuery({
    queryKey: ['manage-secret-versions', selected?.name, pageToken],
    queryFn: () => api<SecretVersions>(
      '/secrets/' + selected!.name + '/versions' +
      (pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '')),
    enabled: Boolean(selected && selected.exists === true),
    retry: false,
    staleTime: 0,
  });
  const pinnedVersions = selected?.references.map((ref) => ref.version).filter(Boolean) || [];
  const activeVersion = selectedVersion || pinnedVersions[0] || versions.data?.items[0]?.version || '';
  const preview = useQuery({
    queryKey: ['manage-secret-preview', selected?.name, activeVersion],
    queryFn: () => api<SecretPreview>(
      '/secrets/' + selected!.name + '/versions/' + activeVersion + '/preview'),
    enabled: false,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  const mutation = useMutation({
    mutationFn: (params: { value: string; autoApply: boolean; updateReferences: boolean }) =>
      send<SecretResult>('/secrets/' + selected!.name + '/versions', {
        value: params.value,
        config_version: list.data!.config_version,
        confirm: 'ROTACIONAR ' + selected!.name,
        auto_apply: params.autoApply,
        update_references: params.updateReferences,
      }),
    onSuccess: (response) => {
      setResult(response);
      setSelectedVersion(response.created_version);
      setPageToken('');
      void qc.invalidateQueries({ queryKey: ['manage-secret-references'] });
      void qc.invalidateQueries({ queryKey: ['manage-secret-versions', response.name] });
      void qc.removeQueries({ queryKey: ['manage-secret-preview'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const creation = useMutation({
    mutationFn: (newName: string) =>
      send<{ ok: true; name: string }>('/secrets', {
        name: newName,
        confirm: 'CRIAR ' + newName,
      }),
    onSuccess: (response) => {
      setCreatedName(response.name);
      setName(response.name);
      setNewOpen(false);
      setPageToken('');
      setSelectedVersion('');
      void qc.invalidateQueries({ queryKey: ['manage-secret-references'] });
    },
  });
  const activation = useMutation({
    mutationFn: (version: string) => send<SecretActivation>('/secrets/' + selected!.name + '/activate', {
      version,
      config_version: list.data!.config_version,
      confirm: 'ATIVAR ' + selected!.name + ' v' + version,
      auto_apply: true,
    }),
    onSuccess: (response) => {
      setActivated(response);
      setResult(null);
      void qc.invalidateQueries({ queryKey: ['manage-secret-references'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const permissions = useMutation({
    mutationFn: () => send<{ queued: true; workflow_url: string }>('/secrets/permissions', {
      confirm: 'SINCRONIZAR IAM PHOTOINTEL',
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const choose = (next: string) => {
    setName(next);
    setSelectedVersion('');
    setPageToken('');
    setResult(null);
    setActivated(null);
    mutation.reset();
    activation.reset();
  };

  return (
    <div className="space-y-5">
      <Section title="Google Secret Manager" detail="Todos os segredos do projeto photointel, inclusive os não referenciados no .env">
        <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <KeyRound size={17} className="text-carbon-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Segredos de produção</p>
              <p className="text-xs text-carbon-500">
                {items.length} encontrados ou referenciados · GCP: photointel
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
              <RefreshCcw size={15} className={list.isFetching ? 'animate-spin' : ''} /> Atualizar
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPermissionsConfirm(true)}>
              <ShieldCheck size={15} /> Sincronizar IAM
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNewOpen((value) => !value)}>
              <Plus size={15} /> Novo secret
            </Button>
          </div>
        </Card>
        <ConfirmDialog
          open={permissionsConfirm}
          onOpenChange={setPermissionsConfirm}
          title="Conceder acesso a todos os secrets?"
          description="Solicita Setup GCP → permissions. A identidade administrativa do Manage poderá listar todos os segredos, consultar trechos dos valores e adicionar versões no projeto photointel. Não concede exclusão nem alteração do IAM pelo Worker."
          label="Solicitar permissões"
          busy={permissions.isPending}
          onConfirm={() => permissions.mutate()}
        />
        {permissions.error && <IssueBanner error={permissions.error} />}
        {permissions.data?.queued && (
          <Card className="p-3 text-xs text-carbon-300">
            Sincronização IAM solicitada, ainda não concluída.{' '}
            <a className="underline" href={permissions.data.workflow_url} target="_blank" rel="noreferrer">
              Acompanhar no GitHub Actions
            </a>
          </Card>
        )}
        {newOpen && (
          <CreateSecretForm busy={creation.isPending} onCreate={(value) => creation.mutate(value)} />
        )}
        {creation.error && <IssueBanner error={creation.error} />}
        {createdName && (
          <Card className="p-3 text-xs text-carbon-300">
            Container <strong>{createdName}</strong> criado no GCP. Agora selecione-o e adicione a primeira versão.
          </Card>
        )}
        {list.data?.warning && (
          <Card className="border-amber-900/60 p-3 text-sm text-amber-200">{list.data.warning}</Card>
        )}
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <IssueBanner error={list.error} />
        ) : !items.length ? (
          <Empty title="Nenhum secret encontrado" detail="Confira as permissões do projeto GCP e a configuração de produção." />
        ) : (
          <>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-3 text-carbon-500" />
              <Input
                aria-label="Buscar secrets"
                className="pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar ICLOUD_SESSION_KEY, nome, token..."
              />
            </div>
            {!filtered.length ? (
              <Empty title="Nenhum resultado" detail="Tente pesquisar pelo nome do segredo no Google Cloud." />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(230px,1fr)_minmax(0,1.4fr)]">
                <SecretList items={filtered} selected={selected?.name || ''} onSelect={choose} />
                {selected && (
                  <div className="min-w-0 space-y-4" key={selected.name}>
                    <SecretVersionCard
                      secret={selected}
                      version={activeVersion}
                      preview={preview.data}
                      loading={preview.isFetching}
                      onPreview={() => void preview.refetch()}
                    />
                    {preview.error && <IssueBanner error={preview.error} />}
                    {selected.exists === false && (
                      <CreateSecretForm
                        suggestedName={selected.name}
                        busy={creation.isPending}
                        onCreate={(value) => creation.mutate(value)}
                      />
                    )}
                    {selected.exists === true && (
                      <>
                        {versions.isPending ? <Spinner /> : versions.error ? (
                          <IssueBanner error={versions.error} />
                        ) : (
                          <SecretVersionHistory
                            items={versions.data?.items || []}
                            current={pinnedVersions}
                            selected={activeVersion}
                            nextPage={Boolean(versions.data?.next_page_token)}
                            loading={versions.isFetching}
                            onSelect={setSelectedVersion}
                            onNext={() => setPageToken(versions.data?.next_page_token || '')}
                            onFirst={() => setPageToken('')}
                          />
                        )}
                        {activeVersion &&
                          versions.data?.items.some((item) =>
                            item.version === activeVersion && item.state === 'ENABLED') &&
                          pinnedVersions.length > 0 &&
                          pinnedVersions.some((version) => version !== activeVersion) && (
                            <Button
                              variant="outline"
                              className="w-full"
                              disabled={activation.isPending}
                              onClick={() => setActivateConfirm(true)}
                            >
                              <RotateCcw size={15} /> Ativar versão v{activeVersion} na produção
                            </Button>
                          )}
                        <ConfirmDialog
                          open={activateConfirm}
                          onOpenChange={setActivateConfirm}
                          title={'Ativar v' + activeVersion + ' de ' + selected.name + '?'}
                          description={
                            'Atualiza as referências no .env para usar a versão existente e ' +
                            'solicita os deploys necessários. Não apaga versões antigas.' +
                            (selected.name === 'photointel-session-aead-key'
                              ? ' O iCloud só conseguirá ler dados criptografados com a chave dessa versão.'
                              : '')
                          }
                          label="Ativar versão"
                          busy={activation.isPending}
                          onConfirm={() => activation.mutate(activeVersion)}
                        />
                        {activation.error && <IssueBanner error={activation.error} />}
                        {activated?.name === selected.name && (
                          <Card className="space-y-2 p-4 text-xs text-carbon-300">
                            <Badge tone="success">Versão v{activated.activated_version} referenciada</Badge>
                            {activated.dispatches.map((job) => (
                              <p key={job.file}>{job.file}: {job.status === 'queued'
                                ? 'deploy solicitado' : 'falha ao solicitar deploy'}</p>
                            ))}
                            {activated.manual.map((note) => <p key={note} className="text-amber-200">{note}</p>)}
                          </Card>
                        )}
                        <SecretVersionForm
                          key={selected.name + ':' + (result?.created_version || pinnedVersions[0] || '')}
                          secret={selected}
                          busy={mutation.isPending}
                          onSave={(value, autoApply, updateReferences) =>
                            mutation.mutate({ value, autoApply, updateReferences })}
                        />
                      </>
                    )}
                    {mutation.error && <IssueBanner error={mutation.error} />}
                    {result?.name === selected.name && (
                      <Card className="space-y-2 p-4">
                        <Badge tone="success">
                          Versão v{result.created_version} criada
                        </Badge>
                        <p className="text-xs text-carbon-400">
                          {result.config_updated
                            ? 'As referências do .env foram atualizadas.'
                            : 'Nenhuma referência de produção foi atualizada.'}
                        </p>
                        {result.dispatches.map((job) => (
                          <p key={job.file} className="text-xs text-carbon-400">
                            {job.file}: {job.status === 'queued' ? 'deploy solicitado' : 'falha ao solicitar deploy'}
                          </p>
                        ))}
                        {result.manual.map((note) =>
                          <p key={note} className="text-xs text-amber-200">{note}</p>)}
                      </Card>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Section>
      <p className="text-xs leading-5 text-carbon-500">
        Acesso exclusivo pela sessão administrativa do Cloudflare Access. Valores antigos aparecem apenas
        mascarados; versões nunca são sobrescritas ou excluídas. Criar uma versão no Google Cloud
        não significa que a aplicação já está usando essa versão.
      </p>
    </div>
  );
}
