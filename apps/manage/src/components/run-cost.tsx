import { Clock3, Coins } from 'lucide-react';
import { money } from '../pages/Costs';

export type RunEstimate = {
  cost_usd: number | null;
  duration_seconds: number | null;
  runner_minutes: number;
  incomplete: boolean;
  basis: string;
  jobs: Array<{
    id: number;
    name: string;
    duration_seconds: number | null;
    billed_minutes: number | null;
    cost_usd: number | null;
    rate_usd: number | null;
    runner: string;
    kind: 'estimate' | 'self_hosted' | 'unknown';
  }>;
};
export type RunCostsResponse = {
  items: Record<string, RunEstimate | { error: string }>;
  basis: string;
};
export function secondsLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Tempo indisponível';
  if (value < 60) return value + 's';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return [hours ? hours + 'h' : '', minutes ? minutes + 'min' : '', !hours && seconds ? seconds + 's' : ''].filter(Boolean).join(' ') || '0s';
}
export function costEntry(value: RunEstimate | { error: string } | undefined): RunEstimate | null {
  return value && 'jobs' in value ? value : null;
}
export function RunCostInline({ estimate }: { estimate?: RunEstimate | { error: string } }) {
  const value = costEntry(estimate);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-carbon-400">
      <span className="inline-flex items-center gap-1"><Clock3 size={12} />
        {value ? secondsLabel(value.duration_seconds) : 'Tempo a apurar'}
      </span>
      <span className="inline-flex items-center gap-1" title="Custo bruto estimado do GitHub, sem descontos de cota">
        <Coins size={12} />
        {value?.cost_usd === null || value?.cost_usd === undefined ? 'Custo a apurar' :
          (value.incomplete ? '≥ ' : '≈ ') + money(value.cost_usd)}
      </span>
    </div>
  );
}
