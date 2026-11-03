import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, Card, Input } from '../../components/ui';
import { ConfirmDialog } from '../../components/confirm-dialog';

export function CreateSecretForm({
  suggestedName,
  busy,
  onCreate,
}: {
  suggestedName?: string;
  busy: boolean;
  onCreate(name: string): void;
}) {
  const [name, setName] = useState(suggestedName || '');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (suggestedName) setName(suggestedName);
  }, [suggestedName]);
  const valid = /^photointel-[a-z0-9-]{1,90}$/.test(name);
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Criar secret no GCP</h3>
      <p className="text-xs leading-5 text-carbon-400">
        Cria um container novo, sem valor e sem apagar outros secrets. Use somente se ele
        realmente não existir. Depois adicione a primeira versão.
      </p>
      <Input
        aria-label="Nome do novo secret"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="photointel-nome-do-secret"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
      <Button disabled={!valid || busy} onClick={() => setConfirm(true)} className="w-full">
        <Plus size={16} /> Criar container
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={'Criar ' + name + '?'}
        description="O Google Cloud criará um Secret Manager vazio. As permissões IAM e as referências de produção devem estar corretas antes de usá-lo."
        label="Criar secret"
        busy={busy}
        onConfirm={() => onCreate(name)}
      />
    </Card>
  );
}
