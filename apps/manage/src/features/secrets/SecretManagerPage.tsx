import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCcw, Search } from 'lucide-react';
import { Badge, Button, Card, Input, Section } from '../../components/ui';
import { Empty, IssueBanner, Spinner } from '../../components/shared';
import { api, send } from '../../lib/client';
import { CreateSecretForm } from './CreateSecretForm';
import { SecretList } from './SecretList';
import { SecretVersionCard } from './SecretVersionCard';
import { SecretVersionForm } from './SecretVersionForm';
import { SecretVersionHistory } from './SecretVersionHistory';
import type {
  SecretPreview, SecretResult, SecretsList, SecretVersions,
} from './types';

export function SecretManagerPage() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const [pageToken, setPageToken] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [result, setResult] = useState<SecretResult | null>(null);
  const [createdName, setCreatedName] = useState('');

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
  const selected = items.find((item) => item.name === name) || filtered[0] || items[0];

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
  const choose = (next: string) => {
    setName(next);
    setSelectedVersion('');
    setPageToken('');
    setResult(null);
    mutation.reset();
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
            <Button size="sm" variant="outline" onClick={() => setNewOpen((value) => !value)}>
              <Plus size={15} /> Novo secret
            </Button>
          </div>
        </Card>
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
