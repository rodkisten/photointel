import { Eye, EyeOff, RefreshCcw } from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import type { SecretRef, SecretPreview } from './types';

export function SecretVersionCard({
  secret,
  preview,
  loading,
  onPreview,
}: {
  secret: SecretRef;
  preview?: SecretPreview;
  loading: boolean;
  onPreview(): void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs text-carbon-400">Versão referenciada em produção</p>
          <p className="mt-1 text-xl font-semibold">v{secret.version}</p>
        </div>
        <Badge tone="info">Google Secret Manager</Badge>
      </div>
      <div className="rounded-lg border border-[#34363b] bg-[#101112] p-3">
        <p className="text-xs text-carbon-500">Início e final do valor atual</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <code className="break-all font-mono text-sm tracking-wide text-carbon-200">
            {preview?.version === secret.version ? preview.fragment : '••• •••••••• •••'}
          </code>
          <Button variant="outline" size="sm" onClick={onPreview} disabled={loading}>
            {loading ? <RefreshCcw size={14} className="animate-spin" /> : <Eye size={14} />}
            {preview ? 'Atualizar trecho' : 'Ver trecho'}
          </Button>
        </div>
      </div>
      <p className="text-xs leading-5 text-carbon-500">
        Mostra somente 3 caracteres do início e do fim após solicitar. O valor integral nunca é enviado ao
        navegador.
      </p>
    </Card>
  );
}
