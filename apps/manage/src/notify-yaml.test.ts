import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './notification-settings';
type SettingsRetention = typeof DEFAULT_SETTINGS.retentionMinutes;
import { parseNotifyYaml, resolveNotifySettings } from './notify-yaml';

describe('repository notify.yml', () => {
  it('parses a versioned partial configuration with the installed YAML parser', () => {
    const config = parseNotifyYaml('version: 1\nnotifications:\n  windowSeconds: 10\n  retentionMinutes:\n    error: 60\n  template: "❌ {{workflow}}"\n');
    expect(config.windowSeconds).toBe(10);
    expect(config.retentionMinutes?.error).toBe(60);
  });

  it('merges nonconflicting fields and preserves defaults', () => {
    const resolved = resolveNotifySettings(DEFAULT_SETTINGS, { windowSeconds: 10 },
      { template: 'Manage: {{workflow}}' });
    expect(resolved.settings.windowSeconds).toBe(10);
    expect(resolved.settings.template).toBe('Manage: {{workflow}}');
    expect(resolved.conflicts).toHaveLength(0);
  });

  it('reports conflicting values without silently overriding repository settings', () => {
    const unresolved = resolveNotifySettings(DEFAULT_SETTINGS, { windowSeconds: 10 }, { windowSeconds: 5 });
    expect(unresolved.conflicts).toEqual([{ path: 'windowSeconds', repository: 10, manage: 5, resolvedBy: null }]);
    expect(unresolved.settings.windowSeconds).toBe(10);
    const resolved = resolveNotifySettings(DEFAULT_SETTINGS, { windowSeconds: 10 }, { windowSeconds: 5 },
      { windowSeconds: 'manage' });
    expect(resolved.settings.windowSeconds).toBe(5);
    expect(resolved.conflicts[0]?.resolvedBy).toBe('manage');
  });

  it('merges nested retention fields individually', () => {
    const result = resolveNotifySettings(DEFAULT_SETTINGS,
      { retentionMinutes: { error: 60 } as SettingsRetention },
      { retentionMinutes: { running: 10 } as SettingsRetention });
    expect(result.settings.retentionMinutes.error).toBe(60);
    expect(result.settings.retentionMinutes.running).toBe(10);
  });

  it('rejects unsafe, unknown, malformed and unsupported YAML', () => {
    for (const source of [
      'version: 2\nnotifications: {}',
      'version: 1\nnotifications:\n  arbitrary: true',
      'version: 1\nnotifications:\n  retentionMinutes:\n    unknown: 1',
      'version: 1\nnotifications: [1, 2]',
      'version: 1\nnotifications:\n  template: one\n  template: two',
    ]) expect(() => parseNotifyYaml(source)).toThrow();
  });
});
