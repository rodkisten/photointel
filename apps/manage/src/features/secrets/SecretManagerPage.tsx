import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCcw } from 'lucide-react';
import { Badge, Button, Card, Section } from '../../components/ui';
import { Empty, IssueBanner, Spinner } from '../../components/shared';
import { api, send } from '../../lib/client';
import { SecretList } from './SecretList';
import { SecretVersionCard } from './SecretVersionCard';
import { SecretVersionForm } from './SecretVersionForm';
import type { SecretPreview, SecretResult, SecretsList } from './types';

export function SecretManagerPage() {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [result, setResult] = useState<SecretResult | null>(null);
  const list = useQuery({
    queryKey: ['manage-secret-references'],
    queryFn: () => api<SecretsList>('/secrets'),
    retry: false,
    staleTime: 0,
  });
  const selected = list.data?.items.find((s) => s.key === key) ?? list.data?.items[0];
  const preview = useQuery({
    queryKey: ['manage-secret-preview', selected?.key, selected?.version],
    queryFn: () => api<SecretPreview>('/secrets/' + selected!.key + '/preview'),
    enabled: false,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const mutation = useMutation({
    mutationFn: (params: { value: string; autoApply: boolean }) =>
      send<SecretResult>('/secrets/' + selected!.key + '/versions', {
        key: selected!.key,
        value: params.value,
        current_version: selected!.version,
        config_version: list.data!.config_version,
        confirm: 'ROTACIONAR ' + selected!.key,
        auto_apply: params.autoApply,
      }),
    onSuccess: (result) => {
      setResult(result);
      void qc.invalidateQueries({ queryKey: ['manage-secret-references'] });
      void qc.removeQueries({ queryKey: ['manage-secret-preview'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const choose = (next: string) => {
    setKey(next);
    setResult(null);
    mutation.reset();
  };
  return (
    <div className="space-y-5">
      <Section title="Secrets de integração" detail="Somente os MANAGE_* referenciados no GCP_CONFIG_ENV">
        <Card className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Google Secret Manager</p>
            <p className="text-xs text-carbon-500">Projeto photointel · credenciais do Manage</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <RefreshCcw size={15} className={list.isFetching ? 'animate-spin' : ''} /> Atualizar
          </Button>
        </Card>
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <IssueBanner error={list.error} />
        ) : !list.data?.items.length ? (
          <Empty
            title="Nenhum secret MANAGE_* referenciado"
            detail="Cadastre as referências em GCP_CONFIG_ENV e execute Setup GCP → permissions."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(230px,1fr)_minmax(0,1.4fr)]">
            <SecretList items={list.data.items} selected={selected?.key || ''} onSelect={choose} />
            {selected && (
              <div className="min-w-0 space-y-4" key={selected.key}>
                <SecretVersionCard
                  secret={selected}
                  preview={preview.data}
                  loading={preview.isFetching}
                  onPreview={() => void preview.refetch()}
                />
                {preview.error && <IssueBanner error={preview.error} />}
                <SecretVersionForm
                  key={selected.key + ':' + (result?.created_version || selected.version)}
                  secret={selected}
                  busy={mutation.isPending}
                  onSave={(value, autoApply) => mutation.mutate({ value, autoApply })}
                />
                {mutation.error && <IssueBanner error={mutation.error} />}
                {result?.key === selected.key && (
                  <Card className="space-y-2 p-4">
                    <Badge tone="success">
                      Versão v{result.created_version} criada e referência atualizada
                    </Badge>
                    <p className="text-xs text-carbon-400">
                      {result.dispatches.length
                        ? result.dispatches
                            .map(
                              (x) =>
                                x.file +
                                ': ' +
                                (x.status === 'queued' ? 'deploy solicitado' : 'falha ao solicitar deploy'),
                            )
                            .join(' · ')
                        : 'Nenhum deploy solicitado. A aplicação pode continuar usando a versão anterior até ser publicada.'}
                    </p>
                  </Card>
                )}
              </div>
            )}
          </div>
        )}
      </Section>
      <p className="text-xs leading-5 text-carbon-500">
        Somente uma nova versão é criada, sem apagar versões anteriores. O painel não aceita arquivos ou
        valores com múltiplas linhas. Em caso de erro após criar uma versão, consulte a mensagem antes de
        tentar novamente para evitar duplicações.
      </p>
    </div>
  );
}
