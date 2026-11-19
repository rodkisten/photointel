import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployBindings, normalizeDeployConfig, validateTerminal, validateWorkloadIdentity, normalizeSecretInventory, resolveConfigValue, resolveConfigInventory, validateRequiredConfigValues, renderDeployConfiguration } from '../src/deploy.ts';

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

test('R2 legacy aliases normalize to canonical storage secrets', () => {
  const inventory = normalizeSecretInventory({
    secrets: {
      R2_ACCESS_KEY_ID: {name: 'storage-access', version: 'latest'},
      R2_SECRET_ACCESS_KEY: {name: 'storage-secret', version: '3'},
    },
    workflowSecrets: {},
  });
  assert.equal(inventory.secrets.STORAGE_ACCESS_KEY.name, 'storage-access');
  assert.equal(inventory.secrets.STORAGE_SECRET_KEY.version, '3');
  assert.equal(inventory.secrets.R2_ACCESS_KEY_ID, undefined);
});

test('canonical storage secrets take precedence over legacy R2 aliases', () => {
  const inventory = normalizeSecretInventory({
    secrets: {
      STORAGE_ACCESS_KEY: {name: 'canonical-key', version: 'latest'},
      R2_ACCESS_KEY_ID: {name: 'legacy-key', version: 'latest'},
    },
    workflowSecrets: {},
  });
  assert.equal(inventory.secrets.STORAGE_ACCESS_KEY.name, 'canonical-key');
});

test('rejects secret R2 endpoint, missing required secrets and unknown keys', () => {
  assert.throws(() => normalizeSecretInventory({
    secrets: {R2_ENDPOINT: {name: 'bad-endpoint', version: 'latest'}}, workflowSecrets: {},
  }), /STORAGE_ENDPOINT/);
  assert.throws(() => normalizeSecretInventory({secrets: {}, workflowSecrets: {}}, {requireAll: true}), /Missing required/);
  assert.throws(() => normalizeSecretInventory({
    secrets: {UNKNOWN: {name: 'unknown', version: 'latest'}}, workflowSecrets: {},
  }), /Unknown runtime/);
});

test('GitHub secret overrides GCP reference without consulting GCP', () => {
  const actual = resolveConfigValue('DATABASE_URL', {
    secrets: {DATABASE_URL: 'github-secret'},
    gcpReferences: {DATABASE_URL: {name: 'old-gcp-database', version: 'latest'}},
  });
  assert.deepEqual(actual, {source: 'github-secret', value: 'github-secret'});
});

test('prefixed GitHub secret is accepted and preferred over GCP', () => {
  const actual = resolveConfigValue('DATABASE_URL', {
    secrets: {PHOTOINTEL_DATABASE_URL: 'prefixed-secret'},
    gcpReferences: {DATABASE_URL: {name: 'old-gcp-database', version: 'latest'}},
  });
  assert.equal(actual.value, 'prefixed-secret');
});

test('GitHub secret takes precedence over GitHub variable', () => {
  const actual = resolveConfigValue('API_TOKEN', {
    secrets: {PHOTOINTEL_API_TOKEN: 'secret'},
    variables: {API_TOKEN: 'variable'},
  });
  assert.deepEqual(actual, {source: 'github-secret', value: 'secret'});
});

test('unprefixed name takes precedence within the same GitHub source', () => {
  const actual = resolveConfigValue('REGION', {
    variables: {REGION: 'us-east1', PHOTOINTEL_REGION: 'us-central1'},
  });
  assert.equal(actual.value, 'us-east1');
});

test('legacy GCP reference is used only as fallback', () => {
  const inventory = resolveConfigInventory(['DATABASE_URL', 'STORAGE_SECRET_KEY'], {
    variables: {DATABASE_URL: 'github-value'},
    gcpReferences: {STORAGE_SECRET_KEY: {name: 'old-storage-secret', version: '3'}},
  });
  assert.equal(inventory.DATABASE_URL.source, 'github-variable');
  assert.equal(inventory.STORAGE_SECRET_KEY.source, 'gcp-secret-manager');
  assert.equal(inventory.STORAGE_SECRET_KEY.reference?.version, '3');
});

test('empty GitHub values do not shadow GCP references', () => {
  assert.equal(resolveConfigValue('DATABASE_URL', {
    secrets: {DATABASE_URL: ''},
    gcpReferences: {DATABASE_URL: {name: 'old-database', version: 'latest'}},
  }).source, 'gcp-secret-manager');
});

test('direct GitHub secrets satisfy required configuration without GCP references', () => {
  const resolved = validateRequiredConfigValues({
    secrets: {DATABASE_URL: 'github-database', PHOTOINTEL_STORAGE_SECRET_KEY: 'github-storage'},
  }, ['DATABASE_URL', 'STORAGE_SECRET_KEY']);
  assert.equal(resolved.DATABASE_URL.source, 'github-secret');
  assert.equal(resolved.STORAGE_SECRET_KEY.source, 'github-secret');
});

test('required configuration accepts mixed GitHub values and GCP fallback', () => {
  const resolved = validateRequiredConfigValues({
    variables: {PHOTOINTEL_REGION: 'us-central1'},
    gcpReferences: {DATABASE_URL: {name: 'legacy-db', version: 'latest'}},
  }, ['REGION', 'DATABASE_URL']);
  assert.equal(resolved.REGION.source, 'github-variable');
  assert.equal(resolved.DATABASE_URL.source, 'gcp-secret-manager');
});

test('required configuration rejects keys absent from both sources', () => {
  assert.throws(() => validateRequiredConfigValues({secrets: {DATABASE_URL: 'present'}}, [
    'DATABASE_URL', 'STORAGE_SECRET_KEY',
  ]), /Missing required configuration: STORAGE_SECRET_KEY/);
});

test('renderer omits GCP reference when a required GitHub secret exists', () => {
  const raw = JSON.stringify({
    project_id: 'photointel', region: 'us-central1', repository: 'photointel',
    ...identity,
    secrets: {DATABASE_URL: {name: 'legacy-db', version: 'latest'}},
  });
  const githubSecrets = Object.fromEntries([
    'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY', 'BRIDGE_TOKEN_PEPPER', 'BRIDGE_ENROLLMENT_SECRET',
    'ICLOUD_SESSION_KEY',
  ].map(key => [key, 'github-' + key]));
  const result = renderDeployConfiguration(raw, {
    project: 'photointel', releaseSha: 'a'.repeat(40), githubSecrets,
  });
  assert.equal((result.extra_environment as Record<string, string>).DATABASE_URL, 'github-DATABASE_URL');
  assert.deepEqual(result.secrets, {});
});

test('runtime optional GitHub secrets are resolved even when absent from dotenv', () => {
  const raw = JSON.stringify({
    project_id: 'photointel', region: 'us-central1', repository: 'photointel',
    ...identity,
    secrets: Object.fromEntries([
      ...['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY',
        'BRIDGE_TOKEN_PEPPER', 'BRIDGE_ENROLLMENT_SECRET', 'ICLOUD_SESSION_KEY'],
      'MODAL_TOKEN',
    ].map(key => [key, {name: 'photointel-' + key.toLowerCase().replaceAll('_', '-'), version: 'latest'}])),
  });
  const result = renderDeployConfiguration(raw, {
    project: 'photointel', releaseSha: 'b'.repeat(40),
    githubSecrets: {
      ...Object.fromEntries([
        'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY',
        'BRIDGE_TOKEN_PEPPER', 'BRIDGE_ENROLLMENT_SECRET', 'ICLOUD_SESSION_KEY',
      ].map(key => [key, 'github-' + key])),
      MODAL_TOKEN: 'github-modal-token',
    },
  });
  assert.equal((result.extra_environment as Record<string, string>).MODAL_TOKEN, 'github-modal-token');
  assert.deepEqual(result.secrets, {});
});

test('GitHub-provided terminal values cannot override the approved production gateway', () => {
  const raw = JSON.stringify({
    project_id: 'photointel', region: 'us-central1', repository: 'photointel',
    ...identity, extra_environment: runtime,
  });
  assert.throws(() => renderDeployConfiguration(raw, {
    project: 'photointel', releaseSha: 'c'.repeat(40),
    githubVariables: {MANAGE_TERMINAL_GATEWAY_URL: 'https://attacker.example.com'},
  }), /approved Access-protected hostname/);
});

test('legacy R2 endpoint reference accepts normalized runtime STORAGE_ENDPOINT', () => {
  const raw = [
    'PROJECT_ID=photointel',
    'REGION=us-central1',
    'REPOSITORY=photointel',
    ...Object.entries(identity).map(([key, value]) => key + '=' + value),
    'ENV__STORAGE_ENDPOINT=https://storage.example.com',
    'SECRET__R2_ENDPOINT=legacy-endpoint@latest',
  ].join('\\n');
  assert.doesNotThrow(() => renderDeployConfiguration(raw, {
    project: 'photointel', releaseSha: 'd'.repeat(40),
    githubSecrets: Object.fromEntries([
      'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY',
      'BRIDGE_TOKEN_PEPPER', 'BRIDGE_ENROLLMENT_SECRET', 'ICLOUD_SESSION_KEY',
    ].map(key => [key, 'github-' + key])),
  }));
});

test('preview removes known production credentials even without token-like names', () => {
  const source = JSON.stringify({extra_environment: {
    DATABASE_URL: 'postgres://private',
    STORAGE_ACCESS_KEY: 'private-key',
    ICLOUD_SESSION_KEY: 'private-session',
    PUBLIC_FEATURE: 'enabled',
  }});
  const result = deployBindings(source, 'preview');
  assert.equal(result.runtime.DATABASE_URL, undefined);
  assert.equal(result.runtime.STORAGE_ACCESS_KEY, undefined);
  assert.equal(result.runtime.ICLOUD_SESSION_KEY, undefined);
  assert.equal(result.runtime.PUBLIC_FEATURE, 'enabled');
});
