import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateNotificationSettings } from './notification-settings';

describe('notification settings', () => {
  it('defaults to five-second repository grouping', () => {
    expect(DEFAULT_SETTINGS.grouping).toBe('window');
    expect(DEFAULT_SETTINGS.windowSeconds).toBe(5);
  });

  it('accepts supported second-based windows', () => {
    for (const windowSeconds of [5, 10, 15, 30]) {
      expect(validateNotificationSettings({ ...DEFAULT_SETTINGS, windowSeconds }).windowSeconds)
        .toBe(windowSeconds);
    }
  });

  it('rejects unsupported windows and invalid event types', () => {
    expect(() => validateNotificationSettings({ ...DEFAULT_SETTINGS, windowSeconds: 120 })).toThrow();
    expect(() => validateNotificationSettings({ ...DEFAULT_SETTINGS, events: ['cancelled'] })).toThrow();
  });

  it('deduplicates event settings', () => {
    const settings = validateNotificationSettings({
      ...DEFAULT_SETTINGS, events: ['workflow_failure', 'workflow_failure'],
    });
    expect(settings.events).toEqual(['workflow_failure']);
  });
});
