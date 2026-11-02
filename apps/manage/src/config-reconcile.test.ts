import { describe, expect, it } from 'vitest';
import { findDuplicateConfigKeys, planConfigChange } from './config-reconcile';

const BASE = [
  'PROJECT_ID=photointel',
  'REGION=us-central1',
  'EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_CHAT_ID=-100123456',
].join('\n');

describe('automatic configuration impact planner', () => {
  it('preserves harmless repeated dotenv values and their comment lines', () => {
    const before = BASE + '\n# Sentry for UI\nEXTRA_ENVIRONMENT__SENTRY_ORG=migos-club\n' +
      '# Sentry for Manage\nEXTRA_ENVIRONMENT__SENTRY_ORG=migos-club';
    const next = before + '\nMANAGE_SENTRY_DSN=https://0123456789abcdef@o1.ingest.sentry.io/456';
    const repeated = findDuplicateConfigKeys(before);
    expect(repeated).toEqual([{ key: 'EXTRA_ENVIRONMENT__SENTRY_ORG', lines: [5, 7] }]);
    const plan = planConfigChange(before, next);
    expect(plan.targets).toEqual(['manage']);
    expect(plan.blocked).toBe(false);
    expect(before).toContain('# Sentry for UI');
    expect(before).toContain('# Sentry for Manage');
  });

  it('rejects conflicting duplicate values rather than silently overwriting', () => {
    const conflicted = BASE + '\nEXTRA_ENVIRONMENT__SENTRY_ORG=migos-club\n' +
      'EXTRA_ENVIRONMENT__SENTRY_ORG=other-org';
    expect(() => planConfigChange(BASE, conflicted)).toThrow(/duplicada/);
  });

  it('dispatches config-only sync for top-level Telegram .env values', () => {
    const next = BASE + '\nTELEGRAM_NOTIFICATION_API_TOKEN=fake_test_token_1234567890';
    const plan = planConfigChange(BASE, next);
    expect(plan.blocked).toBe(false);
    expect(plan.targets).toEqual(['jobs', 'api']);
    expect(plan.workflows.map((item) => item.file)).toEqual(['config-sync.yml']);
  });
  it('reconfigures Cloud Run without building Docker for Telegram env changes', () => {
    const changed = BASE.replace('-100123456', '-100987654');
    const plan = planConfigChange(BASE, changed);
    expect(plan.changed).toEqual(['EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_CHAT_ID']);
    expect(plan.targets).toEqual(['jobs', 'api']);
    expect(plan.workflows).toEqual([
      {
        file: 'config-sync.yml',
        label: 'Cloud Run · configuração sem Docker',
        inputs: { targets: 'jobs,api' },
      },
    ]);
  });

  it('rebuilds only the frontend when a public Worker name is edited', () => {
    const before = { project_id: 'photointel', workflows: { worker: { name: 'photointel' } } };
    const after = { ...before, workflows: { worker: { name: 'photointel-new' } } };
    const plan = planConfigChange(JSON.stringify(before), JSON.stringify(after));
    expect(plan.targets).toEqual(['worker']);
    expect(plan.workflows.map((x) => x.file)).toEqual(['deploy-worker.yml']);
  });

  it('does not run workflows for whitespace and JSON formatting changes', () => {
    const previous = '{"project_id":"photointel","region":"us-central1"}';
    const next = JSON.stringify(JSON.parse(previous), null, 2);
    const plan = planConfigChange(previous, next);
    expect(plan.changed).toEqual([]);
    expect(plan.workflows).toEqual([]);
  });

  it('does not automatically run migrations or bootstrap for secret name changes', () => {
    const before = { project_id: 'photointel', secrets: { DATABASE_URL: { name: 'db-prod', version: '1' } } };
    const after = { project_id: 'photointel', secrets: { DATABASE_URL: { name: 'db-next', version: '1' } } };
    const plan = planConfigChange(JSON.stringify(before), JSON.stringify(after));
    expect(plan.workflows.map((x) => x.file)).toEqual(['config-sync.yml']);
    expect(plan.manual.some((x) => x.includes('Novo nome de segredo'))).toBe(true);
    expect(plan.workflows.every((x) => x.file !== 'gcp-bootstrap.yml')).toBe(true);
  });

  it('only flags schedule changes for review rather than pausing production jobs', () => {
    const before = BASE + '\nWORKER_SCHEDULE=*/10 * * * *';
    const after = BASE + '\nWORKER_SCHEDULE=*/15 * * * *';
    const plan = planConfigChange(before, after);
    expect(plan.workflows).toEqual([]);
    expect(plan.manual.some((x) => x.includes('Scheduler'))).toBe(true);
  });

  it('supports protected auth metadata and detects malformed dotenv', () => {
    expect(planConfigChange(BASE, BASE + '\nGCP_WORKLOAD_IDENTITY_PROVIDER=projects/1').manual)
      .toContain('Identidade GitHub/GCP: requer revisão do Workload Identity Federation.');
    expect(() => planConfigChange(BASE, BASE + '\nBROKEN LINE')).toThrow();
  });

  it('deploys only Manage when its new public Sentry DSN changes', () => {
    const dsn = 'https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/456';
    for (const key of ['MANAGE_SENTRY_DSN', 'EXTRA_ENVIRONMENT__MANAGE_SENTRY_DSN']) {
      const plan = planConfigChange(BASE, BASE + '\n' + key + '=' + dsn);
      expect(plan.blocked).toBe(false);
      expect(plan.targets).toEqual(['manage']);
      expect(plan.workflows.map((item) => item.file)).toEqual(['manage-deploy.yml']);
    }
  });

  it('selects an isolated Manage publish for Manage workflow secrets', () => {
    const a = { project_id: 'photointel', workflow_secrets: { MANAGE_GITHUB_API_TOKEN: { name: 'pat', version: '1' } } };
    const b = { ...a, workflow_secrets: { MANAGE_GITHUB_API_TOKEN: { name: 'pat', version: '2' } } };
    expect(planConfigChange(JSON.stringify(a), JSON.stringify(b)).targets).toEqual(['manage']);
  });
});
