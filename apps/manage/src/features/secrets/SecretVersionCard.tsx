import { Eye, RefreshCcw } from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import type { SecretItem, SecretPreview } from './types';

export function SecretVersionCard({
  secret,
  version,
  preview,
  loading,
  onPreview,
}: {
  secret: SecretItem;
  version: string;
  preview?: SecretPreview;
  loading: boolean;
  onPreview(): void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs text-carbon-400">Google Secret Manager</p>
          <h3 className="mt-1 break-all text-base font-semibold">{secret.name}</h3>
        </div>
        {secret.exists === false ? <Badge tone="danger">Não existe no GCP</Badge> : null}
      </div>
      {secret.references.length ? (
        <div className="space-y-1">
          <p className="text-xs text-carbon-400">Referências configuradas</p>
          {secret.references.map((ref) => (
            <p key={ref.scope + ref.key} className="break-all font-mono text-xs text-carbon-300">
              {ref.key} {ref.version ? '(v' + ref.version + ')' : '(sem versão)'}
              <span className="ml-2 text-carbon-600">{ref.scope === 'expected' ? 'esperada' : ref.scope}</span>
            </p>
          ))}
        </div>
      ) : (
        <p className="text-xs text-amber-300">
          Secret existe no GCP, mas não possui referência em GCP_CONFIG_ENV. Novas versões não serão
          ativadas automaticamente.
        </p>
      )}
      {secret.exists === false && (
        <p className="text-sm text-amber-300">
          Há uma referência ou nome esperado, mas o container ainda não existe no Secret Manager.
          Crie-o pelo formulário abaixo antes de adicionar versões.
        </p>
      )}
      {version && secret.exists === true && (
        <div className="rounded-lg border border-[#34363b] bg-[#101112] p-3">
          <p className="text-xs text-carbon-500">Trecho mascarado da versão v{version}</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <code className="break-all font-mono text-sm tracking-wide text-carbon-200">
              {preview?.version === version && preview.name === secret.name
                ? preview.fragment : '••• •••••••• •••'}
            </code>
            <Button variant="outline" size="sm" onClick={onPreview} disabled={loading}>
              {loading ? <RefreshCcw size={14} className="animate-spin" /> : <Eye size={14} />}
              {preview?.version === version ? 'Atualizar trecho' : 'Ver trecho'}
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs leading-5 text-carbon-500">
        O painel revela apenas três caracteres do início e três do fim quando possível. Valores
        completos existentes nunca são enviados ao navegador.
      </p>
    </Card>
  );
}
