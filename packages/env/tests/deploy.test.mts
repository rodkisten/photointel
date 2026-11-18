import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployBindings, normalizeDeployConfig, validateTerminal, validateWorkloadIdentity } from '../src/deploy.ts';

const vm = { id: 'debian', label: 'Debian VM', host: 'vm.example.com', port: 22, username: 'root', hostKeySha256: 'SHA256:' + 'A'.repeat(43) };
const runtime = { MANAGE_TERMINAL_VMS: JSON.stringify([vm]), MANAGE_TERMINAL_GATEWAY_URL: 'https://photointel-ssh.migos.club' };

test('legacy JSON extra_environment is normalized to Worker bindings', () => {
  const result = normalizeDeployConfig(JSON.stringify({ extra_environment: runtime }));
  assert.equal(result.runtime.MANAGE_TERMINAL_VMS, runtime.MANAGE_TERMINAL_VMS);
});

test('structured JSON VM catalog is serialized for Worker runtime', () => {
  const result = normalizeDeployConfig(JSON.stringify({ extra_environment: { ...runtime, MANAGE_TERMINAL_VMS: [vm] } }));
  assert.deepEqual(JSON.parse(result.runtime.MANAGE_TERMINAL_VMS), [vm]);
});

test('dotenv compact ENV__ keys produce identical runtime bindings', () => {
  const result = normalizeDeployConfig('ENV__MANAGE_TERMINAL_VMS=json:' + JSON.stringify([vm]) + '\nENV__MANAGE_TERMINAL_GATEWAY_URL=https://photointel-ssh.migos.club');
  assert.deepEqual(JSON.parse(result.runtime.MANAGE_TERMINAL_VMS), [vm]);
});

test('invalid or duplicated VM target is rejected', () => {
  assert.throws(() => validateTerminal({ ...runtime, MANAGE_TERMINAL_VMS: JSON.stringify([vm, vm]) }), /Invalid VM/);
  assert.throws(() => validateTerminal({ ...runtime, MANAGE_TERMINAL_VMS: '[]' }), /nonempty/);
});

test('preview never receives private VM configuration', () => {
  const result = deployBindings(JSON.stringify({ extra_environment: runtime }), 'preview');
  assert.equal(result.runtime.MANAGE_TERMINAL_VMS, undefined);
  assert.equal(result.runtime.PHOTOINTEL_PREVIEW, 'true');
});

test('production preserves approved terminal catalog', () => {
  const result = deployBindings(JSON.stringify({ extra_environment: runtime }), 'production');
  assert.deepEqual(JSON.parse(result.runtime.MANAGE_TERMINAL_VMS), [vm]);
});

test('preview ignores malformed production-only terminal catalog', () => {
  const result = deployBindings(JSON.stringify({ extra_environment: { MANAGE_TERMINAL_VMS: 'invalid', PUBLIC_FEATURE: 'yes' } }), 'preview');
  assert.equal(result.runtime.MANAGE_TERMINAL_VMS, undefined);
  assert.equal(result.runtime.PUBLIC_FEATURE, 'yes');
});

test('preview strips private tokens and Cloudflare production bindings', () => {
  const result = deployBindings(JSON.stringify({ extra_environment: {
    API_TOKEN: 'private', MANAGE_CODESPACES_USER_TOKEN: 'private',
    PUBLIC_FEATURE: 'enabled'
  }, cloudflare_environment: { SECRET_BINDING: 'private' }, workflows: { deploy: true } }), 'preview');
  assert.equal(result.runtime.API_TOKEN, undefined);
  assert.equal(result.runtime.MANAGE_CODESPACES_USER_TOKEN, undefined);
  assert.equal(result.runtime.PUBLIC_FEATURE, 'enabled');
  assert.deepEqual(result.cloudflare, {});
  assert.deepEqual(result.workflows, {});
});

test('legacy extra alias remains compatible with terminal catalog', () => {
  const result = normalizeDeployConfig(JSON.stringify({ extra: runtime, project_id: 'photointel' }));
  assert.deepEqual(result.runtime, runtime);
});

test('invalid gateway is rejected in production but not preview', () => {
  const source = JSON.stringify({ extra_environment: { ...runtime, MANAGE_TERMINAL_GATEWAY_URL: 'https://unsafe.example.com' } });
  assert.throws(() => deployBindings(source, 'production'), /approved/);
  assert.equal(deployBindings(source, 'preview').runtime.MANAGE_TERMINAL_GATEWAY_URL, undefined);
});

const identity = {
  GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/799387180206/locations/global/workloadIdentityPools/github-actions/providers/photo-intelligence',
  GCP_DEPLOY_SERVICE_ACCOUNT: 'deployer@photointel.iam.gserviceaccount.com',
};

test('validates production Workload Identity metadata without fetching credentials', () => {
  assert.deepEqual(validateWorkloadIdentity(identity), {
    provider: identity.GCP_WORKLOAD_IDENTITY_PROVIDER,
    serviceAccount: identity.GCP_DEPLOY_SERVICE_ACCOUNT,
  });
});

test('rejects missing and malformed WIF metadata', () => {
  assert.throws(() => validateWorkloadIdentity({}), /Missing Workload Identity/);
  assert.throws(() => validateWorkloadIdentity({...identity, GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/bad'}), /Invalid GCP_WORKLOAD/);
  assert.throws(() => validateWorkloadIdentity({...identity, GCP_DEPLOY_SERVICE_ACCOUNT: 'not-an-email'}), /Invalid GCP_DEPLOY/);
});

test('bootstrap WIF requires a complete, distinct identity', () => {
  assert.throws(() => validateWorkloadIdentity({...identity, GCP_BOOTSTRAP_SERVICE_ACCOUNT: 'admin@photointel.iam.gserviceaccount.com'}), /configured together/);
  assert.throws(() => validateWorkloadIdentity({...identity,
    GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER: identity.GCP_WORKLOAD_IDENTITY_PROVIDER,
    GCP_BOOTSTRAP_SERVICE_ACCOUNT: identity.GCP_DEPLOY_SERVICE_ACCOUNT,
  }), /insufficiently separated/);
  const actual = validateWorkloadIdentity({...identity,
    GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER: 'projects/799387180206/locations/global/workloadIdentityPools/github-actions/providers/bootstrap',
    GCP_BOOTSTRAP_SERVICE_ACCOUNT: 'bootstrap@photointel.iam.gserviceaccount.com',
  });
  assert.equal(actual.bootstrapServiceAccount, 'bootstrap@photointel.iam.gserviceaccount.com');
});
