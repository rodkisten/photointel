import { describe, expect, it } from 'vitest';
import { moduleContentSecurityPolicy } from './security';
describe('module CSP', () => {
  it('permits only reviewed artifact paths for remote scripts, workers and frames', () => {
    const csp = moduleContentSecurityPolicy(true);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://sandbox.migos.club/modules/sandbox/");
    expect(csp).toContain("worker-src 'self' blob: https://sandbox.migos.club/modules/sandbox/");
    expect(csp).toContain('frame-src https://sandbox.migos.club/modules/sandbox/');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain('pr14.');
    expect(csp).not.toContain('localhost');
  });
  it('does not enable telemetry connections in the isolated preview policy', () => {
    expect(moduleContentSecurityPolicy(false)).not.toContain('sentry.io');
    expect(moduleContentSecurityPolicy(false)).toContain('https://pr14.sandbox.migos.club/modules/sandbox/');
  });
});
