import { describe, expect, it } from 'vitest';
import { checkPaths, matchRules, pathMatch, validatePatterns, validateTarget } from './matching';
import type { DeployRule } from './matching';

const rule: DeployRule = {
  id: 'a', name: 'backend', enabled: true, provider: 'gcp', target: 'release',
  patterns: ['apps/api/', 'infra/gcp/**/*.py'], created_at: '', updated_at: '',
};
describe('Deploy Router path rules', () => {
  it('accepts directories, globstars, blobs and validates traversal', () => {
    expect(validatePatterns(['apps/api/', 'infra/gcp/**/*.py'])).toEqual(['apps/api/', 'infra/gcp/**/*.py']);
    expect(() => validatePatterns(['../secret'])).toThrow();
    expect(() => validatePatterns(['/absolute'])).toThrow();
    expect(() => validatePatterns(['apps//bad'])).toThrow();
  });
  it('matches recursive folders and globstar correctly', () => {
    expect(pathMatch('apps/api/', 'apps/api/src/main.py')).toBe(true);
    expect(pathMatch('apps/api', 'apps/api/src/main.py')).toBe(true);
    expect(pathMatch('infra/gcp/**/*.py', 'infra/gcp/manage.py')).toBe(true);
    expect(pathMatch('infra/gcp/**/*.py', 'infra/gcp/tests/test_manage.py')).toBe(true);
    expect(pathMatch('apps/api/', 'apps/web/main.ts')).toBe(false);
  });
  it('matches only enabled policies and gives paths per rule', () => {
    expect(matchRules([rule, { ...rule, id: 'b', enabled: false }],
      ['apps/api/main.py', 'apps/web/index.html'])).toEqual([
        { rule, files: ['apps/api/main.py'] },
      ]);
  });
  it('confirms paths exist as blobs or trees', () => {
    const tree = [
      { path: 'apps/api', type: 'tree' as const },
      { path: 'apps/api/main.py', type: 'blob' as const },
      { path: 'infra/gcp/manage.py', type: 'blob' as const },
    ];
    expect(checkPaths(['apps/api/', 'infra/gcp/**/*.py'], tree).every((x) => x.exists)).toBe(true);
    expect(checkPaths(['missing/file.py'], tree)[0].exists).toBe(false);
  });
  it('never permits arbitrary GCP targets or Cloudflare scripts', () => {
    expect(validateTarget('gcp', 'release')).toEqual({ provider: 'gcp', target: 'release' });
    expect(() => validateTarget('gcp', 'any-command')).toThrow();
    expect(() => validateTarget('cloudflare', 'my-worker')).toThrow();
  });
});
