import { useState } from 'react';
import { Eye, EyeOff, Save, ShieldCheck } from 'lucide-react';
import { Button, Card, Input } from '../../components/ui';
import { ConfirmDialog } from '../../components/confirm-dialog';
import type { SecretRef } from './types';

export function SecretVersionForm({ secret, busy, onSave }: {
  secret: SecretRef;
  busy: boolean;
  onSave(value: string, autoApply: boolean): void;
}) {
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [autoApply, setAutoApply] = useState(true);
  const [confirm, setConfirm] = useState(false);
  return <Card className="space-y-3 p-4">
    <div className="flex items-center gap-2">
      <ShieldCheck size={17} className="text-slate-400" />
      <h3 className="text-sm font-semibold">Criar nova versão</h3>
    </div>
    <p className="text-xs leading-5 text-slate-400">
      A versão atual permanece no Google Cloud. O novo valor será enviado ao servidor
      somente ao confirmar. Não é necessário copiar a versão anterior.
    </p>
    <label htmlFor="manage-secret-new" className="block text-xs text-slate-400">
      Novo valor para {secret.key}
    </label>
    <div className="flex gap-2">
      <Input id="manage-secret-new" type={visible ? 'text' : 'password'}
        value={draft} onChange={e => setDraft(e.target.value)}
        placeholder="Cole o novo token ou chave"
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        className="min-w-0 flex-1 font-mono"
      />
      <Button type="button" variant="outline" size="icon" aria-label={visible ? 'Ocultar valor' : 'Mostrar valor'}
        onClick={() => setVisible(!visible)}>
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </Button>
    </div>
    <label className="flex items-start gap-2 text-xs leading-5 text-slate-400">
      <input type="checkbox" checked={autoApply} onChange={e => setAutoApply(e.target.checked)}
        className="mt-1 accent-white" />
      Atualizar o .env e solicitar o deploy necessário automaticamente
    </label>
    <Button disabled={busy || !draft || draft.length > 4096 || /[\r\n\0]/.test(draft)}
      className="w-full" onClick={() => setConfirm(true)}>
      <Save size={16} /> Criar versão e atualizar referência
    </Button>
    <p className="text-xs text-slate-600">Para trocar o secret, o servidor deve ter as permissões
      de leitura e adição de versões concedidas pelo bootstrap GCP.</p>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm}
      title={`Criar nova versão de ${secret.key}?`}
      description={`O Google Secret Manager criará uma nova versão de ${secret.name}. A referência no GitHub será alterada de v${secret.version} para a nova versão. A alteração pode exigir uma nova publicação.`}
      label="Criar versão" busy={busy}
      onConfirm={() => { onSave(draft, autoApply); setDraft(''); setVisible(false); }}
    />
  </Card>;
}
