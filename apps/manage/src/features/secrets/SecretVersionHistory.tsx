import { History, ChevronRight } from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import type { SecretVersion } from './types';

export function SecretVersionHistory({
  items,
  current,
  selected,
  nextPage,
  loading,
  onSelect,
  onNext,
  onFirst,
}: {
  items: SecretVersion[];
  current: string[];
  selected: string;
  nextPage: boolean;
  loading: boolean;
  onSelect(version: string): void;
  onNext(): void;
  onFirst(): void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <History size={16} className="text-carbon-400" />
        <h3 className="text-sm font-semibold">Histórico de versões</h3>
      </div>
      {!items.length ? (
        <p className="text-xs text-carbon-400">Nenhuma versão encontrada. Adicione a primeira abaixo.</p>
      ) : (
        <div className="max-h-64 divide-y divide-carbon-800 overflow-y-auto">
          {items.map((item) => (
            <button
              type="button"
              key={item.version}
              className={'flex w-full items-center gap-3 py-2.5 text-left ' +
                (selected === item.version ? 'text-white' : 'text-carbon-400')}
              onClick={() => onSelect(item.version)}
              aria-pressed={selected === item.version}
            >
              <span className="flex-1 text-sm font-medium">v{item.version}
                {current.includes(item.version) && <span className="ml-2 text-xs text-carbon-500">Referenciada</span>}
              </span>
              <Badge tone={item.state === 'ENABLED' ? 'success' : 'neutral'}>{item.state}</Badge>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onFirst} disabled={loading}>
          Primeira página
        </Button>
        {nextPage &&
          <Button size="sm" variant="outline" onClick={onNext} disabled={loading}>
            Mais antigas
          </Button>}
      </div>
    </Card>
  );
}
