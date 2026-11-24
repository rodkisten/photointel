import { redact } from './auth';

// Constantes centralizadas (Eliminando variáveis mágicas)
export const PATTERNS = {
  ID: /^[1-9][0-9]{0,15}$/,
  REPOSITORY: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  GCP_JOB_NAME: /^photointel-[a-z0-9-]{1,48}$/,
  VARIABLE_NAME: /^[A-Z_][A-Z0-9_]{0,99}$/,
  SENTRY_ORG: /^[a-z0-9-]{1,64}$/,
  SECRET_SENSITIVE: /(?:github_pat_|ghp_|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,
};

export const LIMITS = {
  LOG_MAX_BYTES: 400_000,
  LOG_SLICE_LENGTH: 100_000,
  LOG_FINAL_LENGTH: 65_000,
  CONFIG_MAX_LENGTH: 120_000,
  SENTRY_ISSUES_LIMIT: 100,
  TIMEOUT_DEFAULT: 10_000,
  TIMEOUT_PREVIEW: 15_000,
};

export const DEFAULTS = {
  PROJECT_ID: 'photointel',
  REGION: 'us-central1',
  GITHUB_REPO: 'rodkisten/photointel',
};

export type Item = Record<string, unknown>;

export interface GitHubActor extends Item { login?: string }

export interface GitHubWorkflowRun extends Item {
  id?: number; name?: string; display_title?: string; status?: string;
  conclusion?: string | null; run_number?: number; created_at?: string;
  updated_at?: string; html_url?: string; actor?: GitHubActor;
  head_sha?: string; event?: string;
}

export interface CloudflareLogEvent extends Item {
  timestamp?: string; source?: unknown;
  $metadata?: { id?: string; service?: string; level?: string; message?: unknown; error?: unknown };
  $workers?: { scriptName?: string; outcome?: string };
}

export interface CloudRunService extends Item {
  name?: string; uri?: string; latestReadyRevision?: string; latestCreatedRevision?: string;
  updateTime?: string; terminalCondition?: { state?: string }; reconciling?: boolean;
}

export interface CloudRunJob extends Item {
  name?: string; updateTime?: string; latestCreatedExecution?: { name?: string }; executionCount?: number;
}

export interface CloudRunExecution extends Item {
  name?: string; createTime?: string; startTime?: string; completionTime?: string;
  runningCount?: number; succeededCount?: number; failedCount?: number; cancelledCount?: number;
  taskCount?: number; conditions?: Array<{ state?: string }>; logUri?: string;
}

export interface CloudSchedulerJob extends Item {
  name?: string; state?: string; schedule?: string; timeZone?: string;
  lastAttemptTime?: string; status?: { code?: number };
}

export interface CloudflareWorkerScript extends Item { id?: string; modified_on?: string }
export interface CloudflareWorkerDomain extends Item { hostname?: string; service?: string }

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeArray<T extends Item = Item>(data: unknown): T[] {
  return Array.isArray(data) ? data.filter(isRecord) as T[] : [];
}

export function safeList<T extends Item = Item>(data: unknown, key: string): T[] {
  if (!isRecord(data)) return [];
  return safeArray<T>(data[key]);
}

export function sanitizeLog(message: unknown, maxLength: number = 450): string {
  return redact(String(message || '')).slice(0, maxLength);
}
