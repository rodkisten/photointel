import { describe, expect, it } from 'vitest';
import { classifyBrowserError } from '../lib/browser-errors';

describe('privacy-preserving Safari error classification', () => {
  it('ignores optional Google typography failures with system font fallback', () => {
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Geist';
    expect(classifyBrowserError(new Event('error'))).toBeNull();
    const event = new Event('error');
    Object.defineProperty(event, 'target', { value: font });
    expect(classifyBrowserError(event)).toBeNull();
  });
  it('keeps application bundle failures distinct and never copies their URL', () => {
    const script = document.createElement('script');
    script.src = '/private?token=DO_NOT_UPLOAD';
    const event = new Event('error');
    Object.defineProperty(event, 'target', { value: script });
    const error = classifyBrowserError(event);
    expect(error?.name).toBe('ApplicationScriptLoadError');
    expect(JSON.stringify(error?.message)).not.toContain('DO_NOT_UPLOAD');
  });
  it('labels Safari opaque script errors and preserves real exceptions', () => {
    const opaque = new Event('error');
    Object.defineProperty(opaque, 'target', { value: window });
    expect(classifyBrowserError(opaque)?.name).toBe('OpaqueBrowserRuntimeError');
    const actual = new TypeError('Unexpected UI state');
    const event = new ErrorEvent('error', { error: actual });
    Object.defineProperty(event, 'target', { value: window });
    expect(classifyBrowserError(event)).toBe(actual);
    expect(classifyBrowserError(new Event('error'))).toBeNull();
  });
});
