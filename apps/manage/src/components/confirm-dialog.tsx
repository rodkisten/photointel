import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { Button, Input } from '../components/ui';
import { Spinner } from './shared';

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  label: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) setTyped('');
      onOpenChange(nextOpen);
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed inset-x-3 top-1/2 z-50 mx-auto max-w-md -translate-y-1/2 rounded-2xl border border-[#34363b] bg-[#191b1e] p-5 shadow-2xl">
          <div className="flex justify-between gap-2">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-carbon-400">
              <X size={20} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm leading-6 text-carbon-400">
            {description}
          </Dialog.Description>
          <p className="mt-4 text-xs text-carbon-400">
            Digite <strong className="text-white">CONFIRMAR</strong> para continuar.
          </p>
          <Input
            className="mt-2"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            placeholder="CONFIRMAR"
            aria-label="Confirmar operação"
          />
          <div className="mt-5 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              className="flex-1"
              disabled={typed !== 'CONFIRMAR' || busy}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {busy ? <Spinner /> : <Check size={15} />} {label}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
