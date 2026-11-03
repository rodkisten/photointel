import { KeyRound, ChevronRight } from 'lucide-react';
import { Badge, Card } from '../../components/ui';
import type { SecretRef } from './types';

export function SecretList({
  items,
  selected,
  onSelect,
}: {
  items: SecretRef[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  return (
    <Card className="divide-y divide-[#282a2e] overflow-hidden">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.key)}
          aria-pressed={selected === item.key}
          className={`flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors ${selected === item.key ? 'bg-white/[.07]' : 'hover:bg-white/[.03]'}`}
        >
          <KeyRound size={16} className="shrink-0 text-slate-400" />
          <span className="min-w-0 flex-1">
            <span className="block break-all text-sm font-medium">
              {item.key.replace('MANAGE_', '').replaceAll('_', ' ')}
            </span>
            <span className="mt-1 block break-all text-xs text-slate-500">{item.name}</span>
          </span>
          <Badge tone="neutral">v{item.version}</Badge>
          <ChevronRight size={15} className="shrink-0 text-slate-500" />
        </button>
      ))}
    </Card>
  );
}
