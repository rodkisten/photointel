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

test('accepts legacy GCP Secret Manager NAME/VERSION syntax', () => {
  const parsed = parseEnvironment([
    'SECRETS__STORAGE_ACCESS_KEY__NAME=photointel-storage-key',
    'SECRETS__STORAGE_ACCESS_KEY__VERSION=7',
    'WORKFLOW_SECRETS__DEPLOY_TOKEN__NAME=photointel-deploy-token',
    'WORKFLOW_SECRETS__DEPLOY_TOKEN__VERSION=latest',
  ].join('\n'));
  assert.deepEqual(parsed.secrets, [
    {scope: 'runtime', key: 'STORAGE_ACCESS_KEY', name: 'photointel-storage-key', version: '7'},
    {scope: 'workflow', key: 'DEPLOY_TOKEN', name: 'photointel-deploy-token', version: 'latest'},
  ]);
});

test('supports secret:// references and JSON runtime bindings without exposing secret values', () => {
  const parsed = parseEnvironment([
    'ENV__MANAGE_TERMINAL_VMS=json:[{"id":"debian"}]',
    'SECRET__STORAGE_SECRET_KEY=secret://photointel-storage-secret@3',
  ].join('\n'));
  assert.deepEqual(JSON.parse(parsed.runtime.MANAGE_TERMINAL_VMS), [{id: 'debian'}]);
  assert.deepEqual(parsed.secrets[0], {
    scope: 'runtime', key: 'STORAGE_SECRET_KEY', name: 'photointel-storage-secret', version: '3',
  });
});

test('rejects malformed Secret Manager identifiers', () => {
  assert.throws(() => parseEnvironment('SECRET__KEY=Invalid/Resource@latest'), /Invalid Secret Manager/);
  assert.throws(() => parseEnvironment('SECRET__KEY=valid-name@zero'), /Invalid Secret Manager/);
});

test('preserves ordinary strings beginning with brackets or braces', () => {
  const parsed = parseEnvironment([
    'ENV__REGEX=[a-z]+',
    'CF__TEMPLATE={literal-template}',
    'ENV__JSON=json:{"enabled":true}',
  ].join('\\n'));
  assert.equal(parsed.runtime.REGEX, '[a-z]+');
  assert.equal(parsed.cloudflare.TEMPLATE, '{literal-template}');
  assert.equal(parsed.runtime.JSON, '{"enabled":true}');
});
