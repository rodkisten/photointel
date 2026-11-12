import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {parseEnvironment, previewEnvironment} from '../src/index.ts';

test('parses aliases, references and secret inventory', () => {
  const parsed = parseEnvironment([
    'PROJECT_ID=photointel',
    'ENV__PROJECT=${PROJECT_ID}',
    'CF__DOMAIN=photointel-api.migos.club',
    'WF__DEPLOY__REGION=us-central1',
    'WORKFLOW_SECRET__TOKEN=photointel-ci-token@4',
  ].join('\n'));
  assert.equal(parsed.runtime.PROJECT, 'photointel');
  assert.equal(parsed.cloudflare.DOMAIN, 'photointel-api.migos.club');
  assert.equal((parsed.workflows.DEPLOY as Record<string, string>).REGION, 'us-central1');
  assert.deepEqual(parsed.secrets[0], {scope: 'workflow', key: 'TOKEN', name: 'photointel-ci-token', version: '4'});
});
test('rejects circular and missing references', () => {
  assert.throws(() => parseEnvironment('A=${B}\nB=${A}'), /Circular/);
  assert.throws(() => parseEnvironment('A=${MISSING}'), /Unknown/);
});
test('redacts secret values but keeps non-secret values', () => {
  const parsed = previewEnvironment('API_TOKEN=verysecretcredential\nREGION=us-central1');
  assert.equal(parsed.entries.REGION, 'us-central1');
  assert.ok(!JSON.stringify(parsed).includes('verysecretcredential'));
});
