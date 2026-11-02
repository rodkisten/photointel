import { describe, expect, it } from 'vitest';
import { safeSentryMessage } from '../lib/sentry';

describe('Sentry exception details', () => {
  it('retains useful exception messages instead of replacing them with the class name', () => {
    expect(safeSentryMessage('Cannot read properties of undefined (reading "id")')).toBe(
      'Cannot read properties of undefined (reading "id")',
    );
    expect(safeSentryMessage('Falha no carregamento do script do aplicativo')).toContain('script');
  });

  it('redacts signed provider URLs, credentials, private paths and media filenames', () => {
    const result = safeSentryMessage(
      'Request https://example.com/photo?token=PRIVATE password=SECRET ' +
        'for someone@example.com in /home/rod/photos/my-photo.heic failed',
    );
    expect(result).toContain('failed');
    for (const secret of [
      'token=PRIVATE',
      'password=SECRET',
      'someone@example.com',
      '/home/rod',
      'my-photo.heic',
    ]) {
      expect(result).not.toContain(secret);
    }
  });
});
