import { ChevronRight, KeyRound } from 'lucide-react';
import { Badge, Card } from '../../components/ui';
import type { SecretItem } from './types';

export function SecretList({
  items,
  selected,
  onSelect,
}: {
  items: SecretItem[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  return (
    <Card className="max-h-[min(65vh,660px)] divide-y divide-[#282a2e] overflow-y-auto">
      {items.map((item) => {
        const primary = item.references[0];
        return (
          <button
            key={item.name}
            type="button"
            onClick={() => onSelect(item.name)}
            aria-pressed={selected === item.name}
            className={'flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors ' +
              (selected === item.name ? 'bg-white/[.07]' : 'hover:bg-white/[.03]')}
          >
            <KeyRound size={16} className="shrink-0 text-carbon-400" />
            <span className="min-w-0 flex-1">
              <span className="block break-all text-sm font-medium">{primary?.key || item.name}</span>
              <span className="mt-1 block break-all text-xs text-carbon-500">{item.name}</span>
              {item.references.length > 1 &&
                <span className="mt-1 block text-[11px] text-carbon-500">
                  {item.references.length} referências
                </span>}
            </span>
            {item.exists === false ? (
              <Badge tone="danger">Ausente</Badge>
            ) : item.exists === 'unknown' ? (
              <Badge tone="warning">Não verificado</Badge>
            ) : primary?.version ? (
              <Badge tone="neutral">v{primary.version}</Badge>
            ) : (
              <Badge tone="neutral">No GCP</Badge>
            )}
            <ChevronRight size={15} className="shrink-0 text-carbon-500" />
          </button>
        );
      })}
    </Card>
  );
}
