/** GitHub-hosted runner gross usage estimate. Never represents an invoice or free-tier deductions.
 * Rates: https://docs.github.com/en/billing/reference/actions-runner-pricing (2026-11).
 */
export const RUNNER_USD_PER_MINUTE: Record<string, number> = {
  actions_linux_slim: 0.002,
  actions_linux: 0.006,
  actions_linux_arm: 0.005,
  actions_windows: 0.010,
  actions_windows_arm: 0.010,
  actions_macos: 0.062,
  linux_4_core: 0.012,
  linux_8_core: 0.022,
  linux_16_core: 0.042,
  linux_32_core: 0.082,
  linux_64_core: 0.162,
};

export type WorkflowJobCostInput = {
  id: number;
  name: string;
  labels?: string[];
  started_at?: string | null;
  completed_at?: string | null;
  status?: string;
};

export type JobCost = {
  id: number;
  name: string;
  duration_seconds: number | null;
  billed_minutes: number | null;
  rate_usd: number | null;
  cost_usd: number | null;
  runner: string;
  kind: 'estimate' | 'self_hosted' | 'unknown';
};

function rateFor(labels: string[]): { runner: string; rate: number | null; kind: JobCost['kind'] } {
  const normalized = labels.map((label) => label.toLowerCase());
  if (normalized.includes('self-hosted')) return { runner: 'self-hosted', rate: null, kind: 'self_hosted' };
  const exact = [
    ['ubuntu-slim', 'actions_linux_slim'],
    ['ubuntu-24.04-arm', 'actions_linux_arm'],
    ['ubuntu-22.04-arm', 'actions_linux_arm'],
    ['windows-11-arm', 'actions_windows_arm'],
  ] as const;
  for (const [label, sku] of exact) {
    if (normalized.includes(label)) return { runner: sku, rate: RUNNER_USD_PER_MINUTE[sku], kind: 'estimate' };
  }
  const larger = normalized.find((value) => /^ubuntu-(4|8|16|32|64)-core$/.test(value));
  if (larger) {
    const sku = 'linux_' + larger.match(/(4|8|16|32|64)/)?.[1] + '_core';
    return { runner: sku, rate: RUNNER_USD_PER_MINUTE[sku], kind: 'estimate' };
  }
  if (normalized.some((label) => label.startsWith('macos-') || label === 'macos-latest'))
    return { runner: 'actions_macos', rate: RUNNER_USD_PER_MINUTE.actions_macos, kind: 'estimate' };
  if (normalized.some((label) => label.startsWith('windows-') || label === 'windows-latest'))
    return { runner: 'actions_windows', rate: RUNNER_USD_PER_MINUTE.actions_windows, kind: 'estimate' };
  if (normalized.some((label) => label.startsWith('ubuntu-') || label === 'ubuntu-latest'))
    return { runner: 'actions_linux', rate: RUNNER_USD_PER_MINUTE.actions_linux, kind: 'estimate' };
  return { runner: normalized.join(', ') || 'não informado', rate: null, kind: 'unknown' };
}

export function estimateWorkflowJobs(jobs: WorkflowJobCostInput[], now = Date.now()) {
  const entries: JobCost[] = jobs.map((job) => {
    const { runner, rate, kind } = rateFor(Array.isArray(job.labels) ? job.labels : []);
    const start = job.started_at ? Date.parse(job.started_at) : NaN;
    const end = job.completed_at ? Date.parse(job.completed_at) : now;
    const seconds = Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? Math.ceil((end - start) / 1000)
      : null;
    const minutes = seconds === null ? null : Math.ceil(seconds / 60);
    return {
      id: job.id,
      name: job.name,
      duration_seconds: seconds,
      billed_minutes: minutes,
      rate_usd: rate,
      cost_usd: kind === 'estimate' && rate !== null && minutes !== null ? minutes * rate : null,
      runner,
      kind,
    };
  });
  const known = entries.filter((x) => x.cost_usd !== null);
  const unknown = entries.filter((x) => x.kind === 'unknown' || (x.kind === 'estimate' && x.cost_usd === null));
  const starts = jobs.map((x) => Date.parse(x.started_at || '')).filter(Number.isFinite);
  const ends = jobs.map((x) => x.completed_at ? Date.parse(x.completed_at) : now).filter(Number.isFinite);
  return {
    cost_usd: known.length ? Number(known.reduce((sum, x) => sum + (x.cost_usd || 0), 0).toFixed(6)) : null,
    duration_seconds: starts.length && ends.length
      ? Math.max(0, Math.ceil((Math.max(...ends) - Math.min(...starts)) / 1000))
      : null,
    runner_minutes: entries.reduce((sum, x) => sum + (x.billed_minutes || 0), 0),
    incomplete: unknown.length > 0 || jobs.length === 0,
    jobs: entries,
    basis: 'github_runner_list_price_2026_11',
  };
}
