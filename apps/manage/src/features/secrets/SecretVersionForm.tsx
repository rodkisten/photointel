import { useState } from 'react';
import { Eye, EyeOff, Save, ShieldCheck, WandSparkles } from 'lucide-react';
import { Button, Card, Input, Textarea } from '../../components/ui';
import { ConfirmDialog } from '../../components/confirm-dialog';
import type { SecretItem } from './types';

function validIcloudKey(value: string): boolean {
  try {
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
      atob(value).length === 32;
  } catch {
    return false;
  }
}

export function SecretVersionForm({
  secret,
  busy,
  onSave,
}: {
  secret: SecretItem;
  busy: boolean;
  onSave(value: string, autoApply: boolean, updateReferences: boolean): void;
}) {
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [autoApply, setAutoApply] = useState(true);
  const [updateReferences, setUpdateReferences] = useState(secret.name !== 'photointel-session-aead-key');
  const [confirm, setConfirm] = useState(false);
  const isIcloud = secret.name === 'photointel-session-aead-key';
  const pinned = secret.references.filter((ref) => ref.scope !== 'expected' && ref.version);
  const hasRefs = pinned.length > 0;
  const valid = Boolean(draft) && !draft.includes('\0') &&
    new TextEncoder().encode(draft).length <= 65536 &&
    (!isIcloud || validIcloudKey(draft));

  const generateKey = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setDraft(btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')));
    setMultiline(false);
    setVisible(true);
  };

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={17} className="text-carbon-400" />
        <h3 className="text-sm font-semibold">Adicionar uma versão</h3>
      </div>
      <p className="text-xs leading-5 text-carbon-400">
        Substituir o conteúdo de um secret no Google Cloud significa adicionar uma versão. As anteriores
        continuam preservadas. O novo valor só é enviado na confirmação.
      </p>
      {isIcloud && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 text-xs leading-5 text-amber-200">
          ICLOUD_SESSION_KEY usa AES-256: 32 bytes em base64 (geralmente 44 caracteres).
          <strong> Trocar essa chave impede ler sessões e manifests criptografados com a chave anterior.</strong>
          Recupere a original se ainda existir. A senha Apple NÃO é esta chave.
        </div>
      )}
      <label htmlFor="manage-secret-new" className="block text-xs text-carbon-400">
        Novo valor para {secret.name}
      </label>
      <div className="flex gap-2">
        {multiline ? (
          <Textarea
            id="manage-secret-new"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Cole aqui o conteúdo (até 64 KiB)"
            rows={5}
            spellCheck={false}
            className="min-w-0 flex-1 text-base md:text-sm"
          />
        ) : (
          <Input
            id="manage-secret-new"
            type={visible ? 'text' : 'password'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Cole o novo token ou chave"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
          />
        )}
        {!multiline && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={visible ? 'Ocultar valor' : 'Mostrar valor'}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        )}
      </div>
      {!isIcloud && (
        <label className="flex items-center gap-2 text-xs text-carbon-400">
          <input
            type="checkbox"
            checked={multiline}
            onChange={(event) => setMultiline(event.target.checked)}
            className="accent-white"
          />
          Valor multilinha (certificados, JSON e arquivos de texto)
        </label>
      )}
      {isIcloud && (
        <Button type="button" variant="outline" size="sm" onClick={generateKey}>
          <WandSparkles size={15} /> Gerar nova chave AES-256
        </Button>
      )}
      <label className="flex items-start gap-2 text-xs leading-5 text-carbon-400">
        <input
          type="checkbox"
          checked={updateReferences}
          onChange={(event) => setUpdateReferences(event.target.checked)}
          disabled={!hasRefs}
          className="mt-1 accent-white"
        />
        Atualizar as {pinned.length} referências existentes em GCP_CONFIG_ENV
      </label>
      <label className="flex items-start gap-2 text-xs leading-5 text-carbon-400">
        <input
          type="checkbox"
          checked={autoApply}
          onChange={(event) => setAutoApply(event.target.checked)}
          disabled={!hasRefs || !updateReferences}
          className="mt-1 accent-white"
        />
        Solicitar automaticamente os deploys necessários após atualizar o .env
      </label>
      {!hasRefs && (
        <p className="text-xs leading-5 text-amber-300">
          Nenhuma referência de produção válida foi encontrada para este secret.
          A nova versão será criada, mas não será aplicada automaticamente.
          Vincule o nome e a versão na aba Ambiente.
        </p>
      )}
      <Button disabled={busy || secret.exists !== true || !valid} className="w-full"
        onClick={() => setConfirm(true)}>
        <Save size={16} /> Criar nova versão
      </Button>
      <p className="text-xs text-carbon-600">
        Limite de 64 KiB. Não existe edição destrutiva de versões antigas.
        Esta operação exige IAM de Secret Version Adder no GCP.
      </p>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={'Adicionar versão a ' + secret.name + '?'}
        description={
          'Uma nova versão será criada no Secret Manager.' +
          (hasRefs && updateReferences
            ? ' Todas as referências desse secret no .env serão atualizadas e podem exigir publicação.'
            : ' Nenhuma referência de produção será modificada.') +
          (isIcloud
            ? ' Atenção: a troca da chave pode invalidar sessões criptografadas existentes.'
            : '')
        }
        label="Criar versão"
        busy={busy}
        onConfirm={() => {
          onSave(draft, autoApply && updateReferences, hasRefs && updateReferences);
          setDraft('');
        }}
      />
    </Card>
  );
}
