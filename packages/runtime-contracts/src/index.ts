import { z } from 'zod';
export const runtimeVersion = z.literal(1);
export const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const repository = z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/);
export const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
export const imageRepository = z
  .string()
  .regex(/^ghcr\.io\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._/-]{0,180}$/)
  .refine((v) => !v.includes('..') && !v.includes('//') && !v.endsWith('/'), 'Invalid GHCR path');
export const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const workflowFile = z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/);
export const buildRequestSchema = z
  .object({
    schemaVersion: runtimeVersion,
    workspaceId,
    targetId: identifier,
    sourceSha: gitSha,
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const buildResultSchema = z
  .object({
    schemaVersion: runtimeVersion,
    requestId: z.string().uuid(),
    workspaceId,
    targetId: identifier,
    repository,
    sourceSha: gitSha,
    workflowSha: gitSha,
    workflowFile,
    runId: z.number().int().positive().safe(),
    runAttempt: z.number().int().positive().max(1000),
    imageRepository,
    digest: imageDigest,
    platforms: z
      .array(z.enum(['linux/amd64', 'linux/arm64']))
      .min(1)
      .max(2),
  })
  .strict();
export const buildTargetSchema = z
  .object({
    id: identifier,
    workspaceId,
    repository,
    workflowFile,
    workflowRef: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,99}$/)
      .refine((v) => !v.includes('..') && !v.endsWith('/')),
    workflowBlobSha: gitSha,
    imageRepository,
    subjects: z.array(z.string().min(1).max(255)).min(1).max(100),
    platforms: z
      .array(z.enum(['linux/amd64', 'linux/arm64']))
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (v) => v.imageRepository.startsWith('ghcr.io/' + v.repository.split('/')[0] + '/'),
    'Image owner must match source repository owner',
  );
export const brokerPolicySchema = z
  .object({ schemaVersion: runtimeVersion, targets: z.array(buildTargetSchema).max(100) })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    for (const target of v.targets) {
      const key = target.workspaceId + ':' + target.id;
      if (ids.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate target' });
      ids.add(key);
    }
  });
export const buildStatusSchema = z.enum([
  'dispatching',
  'accepted',
  'running',
  'succeeded',
  'failed',
  'dispatch_unknown',
]);
export const publicTargetSchema = z
  .object({ id: identifier, workspaceId, repository, imageRepository, platforms: z.array(z.string()) })
  .strict();
export const publicBuildSchema = z
  .object({
    schemaVersion: runtimeVersion,
    id: z.string().uuid(),
    workspaceId,
    targetId: identifier,
    sourceSha: gitSha,
    status: buildStatusSchema,
    runId: z.number().int().positive().safe().nullable(),
    runUrl: z.string().url().nullable(),
    runsUrl: z.string().url(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    error: z.string().max(500).nullable(),
    result: buildResultSchema.nullable(),
  })
  .strict();
export const deployRequestSchema = z
  .object({ schemaVersion: runtimeVersion, idempotencyKey: z.string().uuid(), release: buildResultSchema })
  .strict();
export const rollbackRequestSchema = z
  .object({ schemaVersion: runtimeVersion, idempotencyKey: z.string().uuid() })
  .strict();
export const runtimeTargetSchema = z
  .object({
    id: identifier,
    workspaceId,
    repository,
    imageRepository,
    port: z.number().int().min(1024).max(65535),
    containerPort: z.number().int().min(1024).max(65535),
    cpu: z.number().min(0.1).max(4),
    memoryMb: z.number().int().min(64).max(8192),
    pids: z.number().int().min(16).max(1024),
    user: z.string().regex(/^[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/),
    healthCommand: z.array(z.string().min(1).max(500)).min(1).max(20),
    healthTimeoutSeconds: z.number().int().min(10).max(180),
    volume: z.enum(['none', 'data', 'workspace']),
    platform: z.enum(['linux/amd64', 'linux/arm64']),
  })
  .strict();
export const agentPolicySchema = z
  .object({ schemaVersion: runtimeVersion, targets: z.array(runtimeTargetSchema).max(100) })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set(),
      ports = new Set();
    for (const t of v.targets) {
      const id = t.workspaceId + ':' + t.id;
      if (ids.has(id) || ports.has(t.port))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate target or host port' });
      ids.add(id);
      ports.add(t.port);
    }
  });
export const operationPhaseSchema = z.enum([
  'queued',
  'pulling',
  'applying',
  'rolling_back',
  'succeeded',
  'failed',
]);
export const operationSchema = z
  .object({
    schemaVersion: runtimeVersion,
    id: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    workspaceId,
    targetId: identifier,
    kind: z.enum(['deploy', 'rollback']),
    release: buildResultSchema,
    previous: buildResultSchema.nullable(),
    phase: operationPhaseSchema,
    error: z.string().max(500).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export function assertReleaseForTarget(release: BuildResult, target: RuntimeTarget) {
  if (
    release.workspaceId !== target.workspaceId ||
    release.targetId !== target.id ||
    release.repository !== target.repository ||
    release.imageRepository !== target.imageRepository ||
    !release.platforms.includes(target.platform)
  )
    throw Error('Release does not match approved runtime target');
  return release;
}
export function imageReference(release: BuildResult) {
  return release.imageRepository + '@' + release.digest;
}
export type BuildRequest = z.infer<typeof buildRequestSchema>;
export type BuildResult = z.infer<typeof buildResultSchema>;
export type BuildTarget = z.infer<typeof buildTargetSchema>;
export type PublicBuild = z.infer<typeof publicBuildSchema>;
export type RuntimeTarget = z.infer<typeof runtimeTargetSchema>;
export type RuntimeOperation = z.infer<typeof operationSchema>;
