import { describe, expect, it } from 'vitest';
import { estimateWorkflowJobs } from './cost-model';

const at = '2026-11-04T10:00:00.000Z';

describe('GitHub Actions cost estimates', () => {
  it('rounds each GitHub-hosted job up to the next minute at the runner rate', () => {
    const result = estimateWorkflowJobs([
      { id: 1, name: 'Linux', labels: ['ubuntu-latest'], started_at: at,
        completed_at: '2026-11-04T10:01:01.000Z' },
      { id: 2, name: 'Windows', labels: ['windows-2025'], started_at: at,
        completed_at: '2026-11-04T10:00:59.000Z' },
    ]);
    expect(result.cost_usd).toBe(0.022);
    expect(result.runner_minutes).toBe(3);
    expect(result.duration_seconds).toBe(61);
    expect(result.incomplete).toBe(false);
  });

  it('never turns unknown runners or self-hosted compute into a fictitious invoice', () => {
    const result = estimateWorkflowJobs([
      { id: 1, name: 'Custom', labels: ['some-special-runner'], started_at: at,
        completed_at: '2026-11-04T10:02:00.000Z' },
      { id: 2, name: 'Self', labels: ['self-hosted', 'linux'], started_at: at,
        completed_at: '2026-11-04T10:02:00.000Z' },
    ]);
    expect(result.cost_usd).toBeNull();
    expect(result.incomplete).toBe(true);
    expect(result.jobs[1].kind).toBe('self_hosted');
  });

  it('does not claim a cost for a job without timing information', () => {
    const result = estimateWorkflowJobs([{ id: 3, name: 'Queued', labels: ['ubuntu-latest'] }]);
    expect(result.cost_usd).toBeNull();
    expect(result.incomplete).toBe(true);
    expect(result.duration_seconds).toBeNull();
  });

  it('reports a partial subtotal if only some runner types are known', () => {
    const result = estimateWorkflowJobs([
      { id: 1, name: 'Known', labels: ['ubuntu-24.04'], started_at: at,
        completed_at: '2026-11-04T10:00:30.000Z' },
      { id: 2, name: 'Unknown', labels: ['private-pool'], started_at: at,
        completed_at: '2026-11-04T10:00:30.000Z' },
    ]);
    expect(result.incomplete).toBe(true);
    expect(result.cost_usd).toBe(0.006);
  });
});
