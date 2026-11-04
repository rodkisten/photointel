import { describe, expect, it } from 'vitest';
import { parseVm, safeSerial } from './infrastructure';

const terminal = {
  name: 'photointel-terminal',
  id: '1234567890',
  machineType: 'zones/us-central1-a/machineTypes/e2-micro',
  labels: { app: 'photointel', purpose: 'terminal' },
  status: 'RUNNING',
  lastStartTimestamp: '2026-11-04T12:00:00Z',
  resourceStatus: { scheduling: { terminationTimestamp: '2026-11-04T13:00:00Z' } },
  scheduling: {
    maxRunDuration: { seconds: '3600' },
    instanceTerminationAction: 'STOP',
    automaticRestart: false,
  },
};

describe('Manage terminal safety', () => {
  it('uses the Compute Engine termination deadline, rather than a client timer', () => {
    const vm = parseVm(terminal);
    expect(vm.status).toBe('RUNNING');
    expect(vm.duration_minutes).toBe(60);
    expect(vm.expiration_at).toBe('2026-11-04T13:00:00Z');
    expect(vm.max_duration_enforced).toBe(true);
  });

  it('never adopts another VM or an unlabelled resource', () => {
    expect(() => parseVm({ ...terminal, name: 'unrelated' })).toThrow('instância terminal');
    expect(() => parseVm({ ...terminal, labels: { app: 'photointel' } })).toThrow('instância terminal');
  });

  it('recognizes that a VM without enforced expiry is unsafe', () => {
    const vm = parseVm({ ...terminal, scheduling: { automaticRestart: true } });
    expect(vm.max_duration_enforced).toBe(false);
  });
});

describe('Terminal serial diagnostics', () => {
  it('forwards allowlisted startup stages only after latest boot', () => {
    const raw = [
      '2026-11-04T11:59:00 google_metadata_script_runner terminal-startup: old',
      '2026-11-04T12:00:10 google_metadata_script_runner terminal-startup: Downloading image',
      '2026-11-04T12:00:11 google_metadata_script_runner session_key=PRIVATE',
      '2026-11-04T12:01:00 kernel: private boot diagnostics',
    ].join('\n');
    const lines = safeSerial(raw, '2026-11-04T12:00:00Z');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe('terminal-startup: Downloading image');
    expect(JSON.stringify(lines)).not.toContain('PRIVATE');
  });
});
