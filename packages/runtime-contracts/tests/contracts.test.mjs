import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestSchema,
  buildResultSchema,
  brokerPolicySchema,
  agentPolicySchema,
  assertReleaseForTarget,
  imageReference,
} from '../dist/index.js';
const sha = 'a'.repeat(40),
  digest = 'sha256:' + 'b'.repeat(64),
  id = '12345678-1234-4234-8234-123456789abc';
const request = {
  schemaVersion: 1,
  workspaceId: 'workspace_1',
  targetId: 'app',
  sourceSha: sha,
  idempotencyKey: id,
};
const release = {
  schemaVersion: 1,
  requestId: id,
  workspaceId: 'workspace_1',
  targetId: 'app',
  repository: 'rodkisten/rodsandbox',
  sourceSha: sha,
  workflowSha: sha,
  workflowFile: '.github/workflows/runtime-build.yml',
  runId: 1,
  runAttempt: 1,
  imageRepository: 'ghcr.io/rodkisten/rodsandbox/app',
  digest,
  platforms: ['linux/amd64'],
};
const target = {
  id: 'app',
  workspaceId: 'workspace_1',
  repository: release.repository,
  imageRepository: release.imageRepository,
  port: 18080,
  containerPort: 3000,
  cpu: 0.25,
  memoryMb: 128,
  pids: 64,
  user: '10001:10001',
  healthCommand: ['node', 'health.mjs'],
  healthTimeoutSeconds: 30,
  volume: 'data',
  platform: 'linux/amd64',
};
test('build requests allow immutable sources only and reject privileged fields', () => {
  assert.deepEqual(buildRequestSchema.parse(request), request);
  for (const fields of [
    { sourceSha: 'main' },
    { dockerfile: '../../secret' },
    { command: 'docker build' },
    { credentials: 'secret' },
    { schemaVersion: 2 },
  ])
    assert.equal(buildRequestSchema.safeParse({ ...request, ...fields }).success, false);
});
test('release target binding rejects cross-workspace/repository/platform and tag substitution', () => {
  const result = buildResultSchema.parse(release);
  assert.equal(imageReference(result), release.imageRepository + '@' + digest);
  assert.equal(assertReleaseForTarget(result, target), result);
  for (const fields of [
    { workspaceId: 'other' },
    { repository: 'attacker/repo' },
    { imageRepository: 'ghcr.io/attacker/repo' },
    { platforms: ['linux/arm64'] },
  ])
    assert.throws(() => assertReleaseForTarget({ ...result, ...fields }, target));
  assert.equal(buildResultSchema.safeParse({ ...release, digest: 'latest' }).success, false);
});
test('agent policy rejects public port collisions, privileged users and host mounts', () => {
  assert.equal(agentPolicySchema.safeParse({ schemaVersion: 1, targets: [target] }).success, true);
  for (const fields of [
    { user: '0:0' },
    { port: 22 },
    { volume: '/var/run/docker.sock' },
    { privileged: true },
  ])
    assert.equal(
      agentPolicySchema.safeParse({ schemaVersion: 1, targets: [{ ...target, ...fields }] }).success,
      false,
    );
  assert.equal(
    agentPolicySchema.safeParse({ schemaVersion: 1, targets: [target, { ...target, id: 'other' }] }).success,
    false,
  );
});
test('broker policy fixes image owner and rejects duplicate workspace targets', () => {
  const t = {
    id: target.id,
    workspaceId: target.workspaceId,
    repository: target.repository,
    imageRepository: target.imageRepository,
    workflowFile: release.workflowFile,
    workflowRef: 'main',
    workflowBlobSha: sha,
    subjects: ['owner@example.test'],
    platforms: release.platforms,
  };
  assert.equal(brokerPolicySchema.safeParse({ schemaVersion: 1, targets: [t] }).success, true);
  assert.equal(
    brokerPolicySchema.safeParse({
      schemaVersion: 1,
      targets: [{ ...t, imageRepository: 'ghcr.io/attacker/app' }],
    }).success,
    false,
  );
  assert.equal(brokerPolicySchema.safeParse({ schemaVersion: 1, targets: [t, t] }).success, false);
});
