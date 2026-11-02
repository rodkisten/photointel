import { describe, it, expect } from 'vitest';
import { validateConfig, WORKFLOW_INPUTS } from './providers';
import { ApiError, redact, requireOrigin } from './auth';

describe('control plane restrictions', () => {
  it('limits dispatch to explicit audited workflows', () => {
    expect(WORKFLOW_INPUTS['gcp-deploy.yml'].action).toContain('release');
    expect(WORKFLOW_INPUTS['arbitrary.yml']).toBeUndefined();
  });
  it('prevents cross-project environment updates', () => {
    expect(() =>
      validateConfig(
        JSON.stringify({
          project_id: 'other',
          region: 'us-central1',
          secrets: { DATABASE_URL: { name: 'db', version: '1' } },
        }),
      ),
    ).toThrow(ApiError);
    expect(() => validateConfig('PROJECT_ID=photointel\nREGION=us-central1\n')).not.toThrow();
    expect(() =>
      validateConfig(
        JSON.stringify({
          project_id: 'photointel',
          region: 'us-central1',
          secrets: { DATABASE_URL: { name: 'db', version: '1' } },
        }),
      ),
    ).not.toThrow();
    expect(() => validateConfig('PROJECT_ID=photointel\n')).toThrow();
    expect(() => validateConfig('PROJECT_ID=photointel\nREGION=us-central1\nghp_FAKE')).toThrow();
  });
  it('redacts secrets, bearer headers and private URLs', () => {
    const v = redact('Authorization=SECRET123 token=abc bearer 123 https://host/path?X-Amz-Signature=abc');
    expect(v).not.toContain('SECRET123');
    expect(v).not.toContain('token=abc');
    expect(v).not.toContain('bearer 123');
    expect(v).not.toContain('X-Amz-Signature');
  });
  it('enforces same-origin on mutating requests', () => {
    expect(() =>
      requireOrigin(
        new Request('https://photos-manage.migos.club/api/config', {
          method: 'PUT',
          headers: { Origin: 'https://attacker.invalid' },
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      requireOrigin(
        new Request('https://photos-manage.migos.club/api/config', {
          method: 'PUT',
          headers: { Origin: 'https://photos-manage.migos.club' },
        }),
      ),
    ).not.toThrow();
  });
});
