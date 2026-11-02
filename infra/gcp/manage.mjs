#!/usr/bin/env node
/**
 * Reproducible Google Cloud operations; default is an offline, reviewable plan.
 *
 * No shell interpolation and no account/resource mutation without two explicit flags.
 * Configuration contains secret references, never secret values.
 *
 * Place this file in infra/gcp/ so ROOT resolves to the repository root.
 * Requires Node.js 20+ and the Google Cloud CLI for --apply operations.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES = ['discover', 'backfill', 'worker', 'maintenance', 'migrate'];
const SCHEDULED = ['discover', 'worker', 'maintenance'];
const SCOPES = 'https://www.googleapis.com/auth/cloud-platform';

const SECRET_FIELDS = new Set([
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'BRIDGE_TOKEN_PEPPER',
  'BRIDGE_ENROLLMENT_SECRET',
  'ICLOUD_SESSION_KEY',
  'MODAL_TOKEN',
  'MODAL_PROXY_KEY',
  'MODAL_PROXY_SECRET',
  'TELEGRAM_NOTIFICATION_API_TOKEN',
]);
const API_SECRETS = difference(SECRET_FIELDS, new Set([
  'MIGRATION_DATABASE_URL', 'ICLOUD_SESSION_KEY',
]));
const REQUIRED_SECRETS = difference(SECRET_FIELDS, new Set([
  'MODAL_TOKEN', 'MODAL_PROXY_KEY', 'MODAL_PROXY_SECRET',
  'TELEGRAM_NOTIFICATION_API_TOKEN',
]));
const SERVICES = [
  'run.googleapis.com',
  'cloudscheduler.googleapis.com',
  'secretmanager.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
];
const ROLES = ['api', 'jobs', 'migrate', 'scheduler', 'builder', 'deployer'];
const PROTECTED_ENV = new Set([
  'APP_ENV',
  'AUTH_MODE',
  'GPU_ENABLED',
  'ICLOUD_ENABLED',
  'INFERENCE_BACKEND',
  'APPLE_NATIVE_WRITE_ENABLED',
  'AUTO_DELETE_ENABLED',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'ACCESS_ALLOWED_EMAILS',
  'INITIAL_IMPORT_LIMIT',
  'INGESTION_IMPORT_LIMIT',
  'STORAGE_BACKEND',
  'GCP_PROJECT_ID',
  'GCP_REGION',
  'GCP_JOB_DISPATCH_ENABLED',
  'TELEGRAM_JOB_EVENTS_ENABLED',
  'EXECUTION_PLATFORM',
  'VERIFICATION_GATES_ENFORCED',
  'TEMP_DIRECTORY',
  'ICLOUD_SESSION_DIRECTORY',
  'ICLOUD_DOWNLOAD_DIRECTORY',
  'RELEASE_GIT_SHA',
  'RELEASE_BRANCH',
]);

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fullmatch(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

function requireField(config, name) {
  if (!Object.hasOwn(config, name)) {
    throw new ConfigurationError(`Missing configuration field: ${name}`);
  }
  return config[name];
}

function httpsOrigin(value, { pathAllowed = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError('Expected an HTTPS origin without credentials');
  }
  if (
    typeof value !== 'string' ||
    !value.startsWith('https://') ||
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (!pathAllowed && !['', '/'].includes(parsed.pathname))
  ) {
    throw new ConfigurationError('Expected an HTTPS origin without credentials');
  }
  return value.replace(/\/+$/, '');
}

function validate(config, { production = false } = {}) {
  if (!isObject(config)) {
    throw new ConfigurationError('Configuration must be a JSON object');
  }
  if (!fullmatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, requireField(config, 'project_id'))) {
    throw new ConfigurationError('Invalid Google Cloud project ID');
  }
  if (!fullmatch(/^[a-z]+-[a-z]+[0-9]$/, requireField(config, 'region'))) {
    throw new ConfigurationError('Invalid Google Cloud region');
  }
  if (!fullmatch(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/, requireField(config, 'repository'))) {
    throw new ConfigurationError('Invalid Artifact Registry repository');
  }
  const prefix = `${config.region}-docker.pkg.dev/${config.project_id}/${config.repository}/api`;
  const image = requireField(config, 'image');
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(?:@sha256:[a-f0-9]{64}|:[a-f0-9]{40})$`);
  if (
    typeof image !== 'string' ||
    (!pattern.test(image) && (production || !image.includes('REPLACE_GIT_SHA')))
  ) {
    throw new ConfigurationError('Image must use a SHA-256 digest or full Git commit tag');
  }
  const imageTag = image.slice(image.lastIndexOf(':') + 1);
  const releaseSha = config.release_git_sha || imageTag;
  if (/^[a-f0-9]{40}$/.test(imageTag) && releaseSha !== imageTag) {
    throw new ConfigurationError('Release SHA must match the image commit tag');
  }
  if (production && !fullmatch(/^[a-f0-9]{40}$/, releaseSha)) {
    throw new ConfigurationError('Digest images require release_git_sha with source commit');
  }
  if (!fullmatch(/^[A-Za-z0-9_./-]{1,100}$/, config.release_branch ?? 'main')) {
    throw new ConfigurationError('Invalid release branch');
  }
  for (const name of ['frontend_origin', 'api_origin', 'storage_endpoint']) {
    httpsOrigin(requireField(config, name));
  }
  if (!fullmatch(/^[a-z0-9-]+\.cloudflareaccess\.com$/, requireField(config, 'access_team_domain'))) {
    throw new ConfigurationError('Invalid Access team domain');
  }
  if (
    typeof requireField(config, 'access_audience') !== 'string' ||
    config.access_audience.length === 0 ||
    config.access_audience.length > 256
  ) {
    throw new ConfigurationError('Invalid Access audience');
  }
  const emails = requireField(config, 'access_allowed_emails');
  if (!Array.isArray(emails) || emails.length < 1 || emails.length > 100) {
    throw new ConfigurationError('Configure a bounded trusted email allowlist');
  }
  if (emails.some((email) => !fullmatch(/^[^\s@]+@[^\s@]+$/, email))) {
    throw new ConfigurationError('Invalid allowlisted email');
  }
  if (!fullmatch(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, requireField(config, 'storage_bucket'))) {
    throw new ConfigurationError('Invalid private storage bucket');
  }
  for (const [name, low, high] of [
    ['api_max_instances', 1, 30],
    ['api_concurrency', 1, 80],
    ['api_timeout_seconds', 10, 3600],
    ['job_task_count', 1, 32],
    ['job_parallelism', 1, 32],
    ['job_max_jobs', 1, 10000],
    ['job_deadline_seconds', 30, 82800],
    ['job_timeout_seconds', 60, 86400],
    ['database_catalog_limit', 100, 10000000],
  ]) {
    const value = requireField(config, name);
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new ConfigurationError(`${name} must be an integer from ${low} to ${high}`);
    }
  }
  if (config.job_deadline_seconds + 60 > config.job_timeout_seconds) {
    throw new ConfigurationError('Reserve at least 60 seconds for graceful shutdown');
  }
  if (config.job_parallelism > config.job_task_count) {
    throw new ConfigurationError('Job parallelism must not exceed task count');
  }
  if (!['limited', 'full'].includes(requireField(config, 'database_profile'))) {
    throw new ConfigurationError('Unknown database profile');
  }
  if (config.database_profile === 'limited' && config.database_catalog_limit > 10000) {
    throw new ConfigurationError('Limited database profile is capped at 10000 assets');
  }

  const secrets = requireField(config, 'secrets');
  if (
    !isObject(secrets) ||
    [...REQUIRED_SECRETS].some((name) => !Object.hasOwn(secrets, name)) ||
    Object.keys(secrets).some((name) => !SECRET_FIELDS.has(name))
  ) {
    throw new ConfigurationError('Missing required or unrecognized Secret Manager reference');
  }
  for (const reference of Object.values(secrets)) {
    if (
      !isObject(reference) ||
      Object.keys(reference).sort().join(',') !== 'name,version' ||
      !fullmatch(/^[a-z][a-z0-9-]{0,254}$/, reference.name)
    ) {
      throw new ConfigurationError('Invalid Secret Manager reference');
    }
    if (!fullmatch(/^[1-9][0-9]{0,9}$/, reference.version)) {
      throw new ConfigurationError('Pin a numeric secret version; latest is not reproducible');
    }
  }

  const extra = config.extra_environment ?? {};
  if (
    !isObject(extra) ||
    Object.entries(extra).some(([key, value]) =>
      !fullmatch(/^[A-Z][A-Z0-9_]{0,99}$/, key) ||
      PROTECTED_ENV.has(key) ||
      SECRET_FIELDS.has(key) ||
      typeof value !== 'string' ||
      value.length > 8192
    )
  ) {
    throw new ConfigurationError('Invalid extra environment; credentials require secrets');
  }
  if (Object.keys(extra).some((key) =>
    /PASSWORD|CREDENTIAL|SECRET|TOKEN|PRIVATE_KEY/.test(key) &&
    key !== 'ACCESS_BRIDGE_SERVICE_TOKENS'
  )) {
    throw new ConfigurationError('Secret-looking environment values must use Secret Manager');
  }
  if (Object.hasOwn(extra, 'ACCESS_BRIDGE_SERVICE_TOKENS')) {
    let identifiers;
    try {
      identifiers = JSON.parse(extra.ACCESS_BRIDGE_SERVICE_TOKENS);
    } catch {
      throw new ConfigurationError('Bridge service identities must be a JSON list');
    }
    if (
      !Array.isArray(identifiers) ||
      identifiers.length < 1 || identifiers.length > 100 ||
      identifiers.some((value) => !fullmatch(/^[A-Za-z0-9_.-]{1,255}$/, value))
    ) {
      throw new ConfigurationError('Invalid public Bridge service client identifiers');
    }
  }
  for (const name of ['enable_gpu', 'enable_icloud']) {
    if (typeof (config[name] ?? false) !== 'boolean') {
      throw new ConfigurationError(`${name} must be an explicit boolean`);
    }
  }
  if (config.enable_icloud && (!config.icloud_account || !config.icloud_library)) {
    throw new ConfigurationError('Enabled iCloud requires account and selected library');
  }
  if (
    config.enable_gpu &&
    (
      ['MODAL_TOKEN', 'MODAL_PROXY_KEY', 'MODAL_PROXY_SECRET'].some((key) => !Object.hasOwn(secrets, key)) ||
      typeof extra.MODAL_ENDPOINT !== 'string' ||
      !extra.MODAL_ENDPOINT.startsWith('https://')
    )
  ) {
    throw new ConfigurationError('Enabled GPU requires Modal endpoint and secret references');
  }
  if (production && /REPLACE|replace|\.example\.com/.test(JSON.stringify(config))) {
    throw new ConfigurationError('Replace every example placeholder before deployment');
  }
  return config;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identity(config, role) {
  if (!ROLES.includes(role)) {
    throw new ConfigurationError('Unknown service-account role');
  }
  return `photointel-${role}@${config.project_id}.iam.gserviceaccount.com`;
}

function environment(config, mode) {
  const values = {
    APP_ENV: 'production',
    AUTH_MODE: 'cloudflare',
    EXECUTION_PLATFORM: 'cloud_run',
    VERIFICATION_GATES_ENFORCED: 'true',
    RELEASE_GIT_SHA: config.release_git_sha || config.image.slice(config.image.lastIndexOf(':') + 1),
    RELEASE_BRANCH: config.release_branch ?? 'main',
    FRONTEND_ORIGIN: config.frontend_origin,
    API_ORIGIN: config.api_origin,
    ACCESS_TEAM_DOMAIN: config.access_team_domain,
    ACCESS_AUDIENCE: config.access_audience,
    ACCESS_ALLOWED_EMAILS: JSON.stringify(config.access_allowed_emails),
    STORAGE_BACKEND: 'r2',
    STORAGE_ENDPOINT: config.storage_endpoint,
    STORAGE_BUCKET: config.storage_bucket,
    STORAGE_REGION: 'auto',
    GPU_ENABLED: String(config.enable_gpu ?? false),
    ICLOUD_ENABLED: String(config.enable_icloud ?? false),
    INFERENCE_BACKEND: 'modal',
    APPLE_NATIVE_WRITE_ENABLED: 'false',
    AUTO_DELETE_ENABLED: 'false',
    INITIAL_IMPORT_LIMIT: '100',
    INGESTION_IMPORT_LIMIT: '100',
    ICLOUD_ACCOUNT: config.icloud_account ?? '',
    ICLOUD_LIBRARY: config.icloud_library ?? '',
    TEMP_DIRECTORY: '/tmp/photointel/processing',
    ICLOUD_SESSION_DIRECTORY: '/tmp/photointel/session',
    ICLOUD_DOWNLOAD_DIRECTORY: '/tmp/photointel/downloads',
    DATABASE_POOL_SIZE: '2',
    DATABASE_MAX_OVERFLOW: '0',
    DATABASE_POOL_MODE: 'transaction',
    DATABASE_REQUIRE_TLS: 'true',
    DATABASE_PROFILE: config.database_profile,
    CATALOG_ASSET_LIMIT: String(config.database_catalog_limit),
    ICLOUD_SESSION_BACKEND: 'encrypted_object',
    GCP_PROJECT_ID: config.project_id,
    GCP_REGION: config.region,
    GCP_JOB_DISPATCH_ENABLED: mode === 'migrate' ? 'false' : 'true',
    TELEGRAM_JOB_EVENTS_ENABLED: String(
      mode !== 'migrate' && Object.hasOwn(config.secrets, 'TELEGRAM_NOTIFICATION_API_TOKEN') &&
      Boolean(config.extra_environment?.TELEGRAM_NOTIFICATION_URL) &&
      Boolean(config.extra_environment?.TELEGRAM_NOTIFICATION_CHAT_ID)
    ),
    ...config.extra_environment,
  };
  const entries = Object.entries(values)
    .sort(([left], [right]) => asciiCompare(left, right))
    .map(([name, value]) => ({ name, value }));
  let allowed = mode === 'api'
    ? API_SECRETS
    : difference(SECRET_FIELDS, new Set(['MIGRATION_DATABASE_URL']));
  if (mode === 'migrate') {
    allowed = new Set(['DATABASE_URL', 'MIGRATION_DATABASE_URL']);
  }
  for (const [key, reference] of Object.entries(config.secrets).sort(([a], [b]) => asciiCompare(a, b))) {
    if (allowed.has(key)) {
      entries.push({
        name: key,
        valueFrom: { secretKeyRef: { name: reference.name, key: reference.version } },
      });
    }
  }
  return entries;
}

function service(config) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: { name: 'photointel-api', namespace: config.project_id },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': String(config.api_max_instances),
            'run.googleapis.com/cpu-throttling': 'true',
            'run.googleapis.com/startup-cpu-boost': 'false',
          },
        },
        spec: {
          serviceAccountName: identity(config, 'api'),
          containerConcurrency: config.api_concurrency,
          timeoutSeconds: config.api_timeout_seconds,
          containers: [
            {
              image: config.image,
              command: ['python'],
              args: ['/app/infra/gcp/entrypoint.py'],
              ports: [{ containerPort: 8080 }],
              env: environment(config, 'api'),
              resources: { limits: { cpu: '1000m', memory: '1Gi' } },
              startupProbe: {
                httpGet: { path: '/health/live', port: 8080 },
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 12,
              },
              livenessProbe: {
                httpGet: { path: '/health/live', port: 8080 },
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
            },
          ],
        },
      },
    },
  };
}

function job(config, mode) {
  if (!MODES.includes(mode)) {
    throw new ConfigurationError('Unknown finite job mode');
  }
  const migration = mode === 'migrate';
  const taskCount = ['discover', 'backfill', 'maintenance', 'migrate'].includes(mode)
    ? 1 : config.job_task_count;
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Job',
    metadata: { name: `photointel-${mode}`, namespace: config.project_id },
    spec: {
      template: {
        spec: {
          taskCount,
          parallelism: Math.min(config.job_parallelism, taskCount),
          template: {
            spec: {
              serviceAccountName: identity(config, migration ? 'migrate' : 'jobs'),
              maxRetries: migration ? 0 : 1,
              timeoutSeconds: migration ? '1800' : String(config.job_timeout_seconds),
              containers: [
                {
                  image: config.image,
                  command: ['python'],
                  args: [
                    '-m', 'photointel.services.task_runner', mode,
                    '--max-jobs', String(config.job_max_jobs),
                    '--deadline-seconds', migration ? '1700' : String(config.job_deadline_seconds),
                  ],
                  env: environment(config, mode),
                  resources: { limits: { cpu: '1000m', memory: '2Gi' } },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function render(config, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const [name, document] of [
    ['api', service(config)],
    ...MODES.map((mode) => [mode, job(config, mode)]),
  ]) {
    const destination = path.join(directory, `photointel-${name}.json`);
    writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(destination, 0o600);
    paths.push(destination);
  }
  return paths;
}

function verifiedDockerDigest(listing, gitSha) {
  let images;
  try {
    images = JSON.parse(listing);
  } catch {
    throw new Error('Artifact Registry did not return a valid JSON image list');
  }
  if (!Array.isArray(images)) {
    throw new Error('Artifact Registry image list must be a JSON array');
  }
  const matches = [];
  for (const entry of images) {
    if (!isObject(entry) || !Array.isArray(entry.tags) || !entry.tags.includes(gitSha)) {
      continue;
    }
    if (!fullmatch(/^sha256:[a-f0-9]{64}$/, entry.version)) {
      throw new Error('Artifact Registry returned an invalid digest for the release tag');
    }
    matches.push(entry.version);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Artifact Registry image tagged with release SHA; got ${matches.length}`);
  }
  return matches[0];
}

function shellQuote(value) {
  const argument = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) {
    return argument;
  }
  return `'${argument.replace(/'/g, `'"'"'`)}'`;
}

function printCommand(binary, args) {
  console.log([binary, ...args].map(shellQuote).join(' '));
}

function runChecked(binary, args, { capture = false, cwd, timeout = 3_600_000, input } = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    timeout,
    input,
    encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024,
    stdio: input !== undefined
      ? ['pipe', capture ? 'pipe' : 'inherit', 'inherit']
      : capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) {
    throw new Error(`Command failed (${binary}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${binary} exited with status ${result.status ?? result.signal}`);
  }
  return capture ? String(result.stdout ?? '').trim() : '';
}

function runProbe(binary, args, { timeout = 60_000 } = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`Existence check failed (${binary}): ${result.error.message}`);
  }
  return result;
}

class Runner {
  constructor(config, apply) {
    this.config = config;
    this.apply = apply;
  }

  command(args, { capture = false } = {}) {
    const command = [
      ...args,
      '--project', this.config.project_id,
      '--quiet',
    ];
    printCommand('gcloud', command);
    if (!this.apply) {
      return '';
    }
    return runChecked('gcloud', command, { capture });
  }

  ensure(query, create) {
    if (this.apply) {
      const command = [
        ...query,
        '--project', this.config.project_id,
        '--quiet',
      ];
      const result = runProbe('gcloud', command);
      if (result.status === 0) {
        return;
      }
      const stderr = result.stderr ?? '';
      if (!stderr.includes('NOT_FOUND') && !stderr.includes('does not exist')) {
        throw new Error('Provider existence check failed; refusing ambiguous create');
      }
    }
    this.command(create);
  }
}

function bootstrap(runner) {
  const config = runner.config;
  // An already enabled API should not require serviceusage.services.enable again.
  if (runner.apply) {
    const enabled = new Set(runner.command(
      ['services', 'list', '--enabled', '--format=value(config.name)'],
      { capture: true },
    ).split(/\r?\n/));
    const missing = SERVICES.filter((serviceName) => !enabled.has(serviceName));
    if (missing.length > 0) {
      console.log(`APIs not enabled: ${missing.join(', ')}`);
      console.log('Enabling APIs requires serviceusage.services.enable; use a project administrator for initial bootstrap.');
      runner.command(['services', 'enable', ...missing]);
    } else {
      console.log('All required APIs already enabled; skipping services enable.');
    }
  } else {
    runner.command(['services', 'list', '--enabled', '--format=value(config.name)']);
    runner.command(['services', 'enable', ...SERVICES]);
  }
  const { repository, region } = config;
  runner.ensure(
    ['artifacts', 'repositories', 'describe', repository, '--location', region],
    ['artifacts', 'repositories', 'create', repository, '--location', region,
      '--repository-format', 'docker', '--description', 'Private PhotoIntel images'],
  );
  for (const role of ROLES) {
    runner.ensure(
      ['iam', 'service-accounts', 'describe', identity(config, role)],
      ['iam', 'service-accounts', 'create', `photointel-${role}`, '--display-name', `PhotoIntel ${role}`],
    );
  }
  for (const reference of Object.values(config.secrets)) {
    runner.ensure(
      ['secrets', 'describe', reference.name],
      ['secrets', 'create', reference.name, '--replication-policy', 'automatic'],
    );
  }
  for (const role of ['api', 'jobs', 'migrate']) {
    const permitted = role === 'api'
      ? API_SECRETS
      : role === 'migrate'
        ? new Set(['DATABASE_URL', 'MIGRATION_DATABASE_URL'])
        : difference(SECRET_FIELDS, new Set(['MIGRATION_DATABASE_URL']));
    for (const secretName of Object.keys(config.secrets).filter((name) => permitted.has(name))) {
      runner.command([
        'secrets', 'add-iam-policy-binding', config.secrets[secretName].name,
        '--member', `serviceAccount:${identity(config, role)}`,
        '--role', 'roles/secretmanager.secretAccessor',
      ]);
    }
  }
  const sourceBucket = `${config.project_id}-photointel-build-source`;
  runner.ensure(
    ['storage', 'buckets', 'describe', `gs://${sourceBucket}`],
    ['storage', 'buckets', 'create', `gs://${sourceBucket}`, '--location', region,
      '--uniform-bucket-level-access', '--public-access-prevention'],
  );
  runner.command([
    'storage', 'buckets', 'add-iam-policy-binding', `gs://${sourceBucket}`,
    '--member', `serviceAccount:${identity(config, 'builder')}`,
    '--role', 'roles/storage.objectViewer',
  ]);
  runner.command([
    'artifacts', 'repositories', 'add-iam-policy-binding', repository,
    '--location', region,
    '--member', `serviceAccount:${identity(config, 'builder')}`,
    '--role', 'roles/artifactregistry.writer',
  ]);
  runner.command([
    'projects', 'add-iam-policy-binding', config.project_id,
    '--member', `serviceAccount:${identity(config, 'builder')}`,
    '--role', 'roles/logging.logWriter',
  ]);

  const deployer = `serviceAccount:${identity(config, 'deployer')}`;
  for (const role of [
    'roles/run.admin',
    'roles/cloudscheduler.admin',
    'roles/cloudbuild.builds.editor',
    'roles/artifactregistry.reader',
    'roles/serviceusage.serviceUsageConsumer',
  ]) {
    runner.command([
      'projects', 'add-iam-policy-binding', config.project_id,
      '--member', deployer,
      '--role', role,
    ]);
  }
  runner.command([
    'storage', 'buckets', 'add-iam-policy-binding', `gs://${sourceBucket}`,
    '--member', deployer, '--role', 'roles/storage.objectAdmin',
  ]);
  for (const role of ['api', 'jobs', 'migrate', 'scheduler', 'builder']) {
    runner.command([
      'iam', 'service-accounts', 'add-iam-policy-binding', identity(config, role),
      '--member', deployer,
      '--role', 'roles/iam.serviceAccountUser',
    ]);
  }
}

function deployJobs(runner, directory) {
  const config = runner.config;
  for (const mode of MODES) {
    runner.command([
      'run', 'jobs', 'replace', path.join(directory, `photointel-${mode}.json`),
      '--region', config.region,
    ]);
    if (mode === 'migrate') {
      continue;
    }
    const accounts = [identity(config, 'api'), identity(config, 'jobs')];
    if (SCHEDULED.includes(mode)) {
      accounts.push(identity(config, 'scheduler'));
    }
    for (const account of accounts) {
      runner.command([
        'run', 'jobs', 'add-iam-policy-binding', `photointel-${mode}`,
        '--region', config.region,
        '--member', `serviceAccount:${account}`,
        '--role', 'roles/run.invoker',
      ]);
    }
  }
}

function scheduler(runner) {
  const config = runner.config;
  const schedules = {
    discover: requireField(config, 'discovery_schedule'),
    worker: requireField(config, 'worker_schedule'),
    maintenance: requireField(config, 'maintenance_schedule'),
  };
  for (const [mode, schedule] of Object.entries(schedules)) {
    const name = `photointel-${mode}`;
    const uri = `https://run.googleapis.com/v2/projects/${config.project_id}/locations/${config.region}/jobs/${name}:run`;
    let operation = 'create';
    if (runner.apply) {
      const result = runProbe('gcloud', [
        'scheduler', 'jobs', 'describe', name,
        '--location', config.region,
        '--project', config.project_id,
        '--format=json',
      ]);
      if (result.status === 0) {
        operation = 'update';
      } else if (!(result.stderr ?? '').includes('NOT_FOUND')) {
        throw new Error('Unable to verify scheduler job existence');
      }
    }
    runner.command([
      'scheduler', 'jobs', operation, 'http', name,
      '--location', config.region,
      '--schedule', schedule,
      '--time-zone', requireField(config, 'scheduler_timezone'),
      '--uri', uri,
      '--http-method', 'POST',
      '--headers', 'Content-Type=application/json',
      '--message-body', '{}',
      '--oauth-service-account-email', identity(config, 'scheduler'),
      '--oauth-token-scope', SCOPES,
      '--attempt-deadline', '60s',
      '--max-retry-attempts', '1',
    ]);
    runner.command([
      'scheduler', 'jobs', 'pause', name,
      '--location', config.region,
    ]);
  }
}

async function smoke(config, origin) {
  httpsOrigin(origin);
  const expectedHost = new URL(origin).hostname;
  if (!expectedHost.endsWith('.run.app')) {
    throw new ConfigurationError('Smoke origin must be the actual HTTPS run.app origin');
  }
  const checks = [];
  for (const route of [
    '/v1/assets',
    '/v1/search/facets',
    '/v1/system/status',
    '/v1/apple-sync/status',
    '/v1/assets/00000000-0000-0000-0000-000000000000/media/thumbnail_small',
  ]) {
    // Manual redirects mean a 3xx cannot masquerade as an authentication failure.
    const response = await fetch(origin.replace(/\/+$/, '') + route, {
      method: 'GET',
      headers: {
        'Cf-Access-Authenticated-User-Email': config.access_allowed_emails[0],
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const status = response.status;
    await response.body?.cancel();
    checks.push({ path: route, status, passed: status === 401 || status === 403 });
  }
  const result = { kind: 'anonymous_origin_authentication', checks };
  if (!checks.every((check) => check.passed)) {
    throw new Error('Direct Cloud Run origin authentication check failed');
  }
  return result;
}

function getLstat(filename) {
  try {
    return lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function verifyBackupReceipt(directory, receiptPath) {
  // Operator-controlled integrity attestation, not cryptographic authorization.
  if (getLstat(directory)?.isSymbolicLink() || getLstat(receiptPath)?.isSymbolicLink()) {
    throw new ConfigurationError('Backup references must not be symlinks');
  }
  const headerPath = path.join(directory, 'backup.json');
  const headerStat = getLstat(headerPath);
  if (!headerStat || headerStat.isSymbolicLink() || !headerStat.isFile() || headerStat.size > 65_536) {
    throw new ConfigurationError('Backup header is missing or too large');
  }
  const receiptStat = getLstat(receiptPath);
  if (!receiptStat?.isFile() || receiptStat.size > 65_536) {
    throw new ConfigurationError('Backup verification receipt is missing or too large');
  }
  const manifestPath = path.join(directory, 'manifest.enc');
  const manifestStat = getLstat(manifestPath);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new ConfigurationError('Encrypted backup manifest is missing');
  }
  if (manifestStat.size > 256 * 1024 * 1024 + 28) {
    throw new ConfigurationError('Encrypted backup manifest exceeds the backup format limit');
  }
  const manifestDigest = await sha256File(manifestPath);
  const header = readJson(headerPath);
  const receipt = readJson(receiptPath);
  if (
    !isObject(header) || !isObject(receipt) ||
    header.format !== 'photointel-application-backup-v2' ||
    !fullmatch(/^[a-f0-9]{32}$/, header.backup_id) ||
    !fullmatch(/^[a-f0-9]{64}$/, header.manifest_sha256) ||
    manifestDigest !== header.manifest_sha256 ||
    receipt.backup_id !== header.backup_id ||
    receipt.manifest_sha256 !== header.manifest_sha256 ||
    receipt.verification_kind !== 'database-and-object-restore' ||
    receipt.status !== 'passed' ||
    !Number.isInteger(receipt.files_verified) || receipt.files_verified < 1 ||
    receipt.database_fingerprints_match !== true ||
    !Array.isArray(receipt.migration_heads) || receipt.migration_heads.length === 0 ||
    !Number.isInteger(receipt.objects_restored_and_read_back) ||
    receipt.objects_restored_and_read_back < 0
  ) {
    throw new ConfigurationError('Backup requires a matching successful database-and-object restore receipt');
  }
  const verifiedAt = receipt.verified_at;
  if (
    typeof verifiedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(verifiedAt)
  ) {
    throw new ConfigurationError('Invalid backup verification timestamp');
  }
  const verified = Date.parse(verifiedAt);
  if (!Number.isFinite(verified)) {
    throw new ConfigurationError('Invalid backup verification timestamp');
  }
  const ageMs = Date.now() - verified;
  if (ageMs < -5 * 60_000 || ageMs > 24 * 3_600_000) {
    throw new ConfigurationError('Re-verify a backup created before this migration (24h limit)');
  }
}

function readJson(filename) {
  let content;
  try {
    content = readFileSync(filename, 'utf8');
  } catch (error) {
    throw new ConfigurationError(`Cannot read ${filename}: ${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ConfigurationError(`Invalid JSON in ${filename}: ${error.message}`);
  }
}

const ACTIONS = new Set([
  'doctor', 'bootstrap', 'build', 'render', 'deploy', 'jobs-deploy',
  'scheduler', 'migrate', 'smoke', 'rollback', 'cleanup', 'secret-add',
]);
const VALUE_FLAGS = new Map([
  ['--config', 'config'],
  ['--output', 'output'],
  ['--confirm-project', 'confirmProject'],
  ['--git-sha', 'gitSha'],
  ['--revision', 'revision'],
  ['--origin', 'origin'],
  ['--secret', 'secret'],
  ['--backup-directory', 'backupDirectory'],
  ['--backup-receipt', 'backupReceipt'],
]);
const BOOLEAN_FLAGS = new Map([
  ['--apply', 'apply'],
  ['--authorize-charges', 'authorizeCharges'],
  ['--initial-empty-database', 'initialEmptyDatabase'],
]);

function usage() {
  return [
    'Usage: node infra/gcp/photointel-gcp.mjs ACTION [OPTIONS]',
    '',
    `Actions: ${[...ACTIONS].join(', ')}`,
    '',
    'Options:',
    '  --config FILE                 infra/gcp/config.local.json by default',
    '  --output DIRECTORY            infra/gcp/rendered by default',
    '  --apply                       Execute operations (default: plan only)',
    '  --authorize-charges           Explicitly authorize cloud costs',
    '  --confirm-project PROJECT     Must exactly match the configured project',
    '  --git-sha SHA                 Full 40-character Git commit hash',
    '  --revision REVISION           Previously verified API revision (rollback)',
    '  --origin HTTPS_URL            Direct run.app origin for smoke probes',
    '  --secret FIELD                Configured secret field for secret-add',
    '  --backup-directory DIR        Backup directory for migration',
    '  --backup-receipt FILE         Restore verification receipt for migration',
    '  --initial-empty-database      Explicit fresh database migration exception',
    '  -h, --help                    Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    action: null,
    config: path.join(ROOT, 'infra/gcp/config.local.json'),
    output: path.join(ROOT, 'infra/gcp/rendered'),
    apply: false,
    authorizeCharges: false,
    initialEmptyDatabase: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (!raw.startsWith('--')) {
      if (args.action !== null || !ACTIONS.has(raw)) {
        throw new ConfigurationError(`Unknown or duplicate action: ${raw}\n${usage()}`);
      }
      args.action = raw;
      continue;
    }
    const equals = raw.indexOf('=');
    const name = equals < 0 ? raw : raw.slice(0, equals);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals >= 0) throw new ConfigurationError(`${name} does not accept a value`);
      args[BOOLEAN_FLAGS.get(name)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new ConfigurationError(`Unknown option: ${name}`);
    }
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) {
      throw new ConfigurationError(`Missing value for ${name}`);
    }
    args[VALUE_FLAGS.get(name)] = value;
  }
  if (args.action === null) {
    throw new ConfigurationError(`Missing action\n${usage()}`);
  }
  if (args.secret !== undefined && !SECRET_FIELDS.has(args.secret)) {
    throw new ConfigurationError(`--secret must be one of: ${[...SECRET_FIELDS].sort().join(', ')}`);
  }
  return args;
}

async function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new ConfigurationError('A TTY is required to enter a secret without echoing it');
  }
  const input = process.stdin;
  const output = process.stdout;
  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003' || character === '\u0004') {
          cleanup();
          output.write('\n');
          reject(new Error('Secret input interrupted'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          output.write('\n');
          resolve(secret);
          return;
        }
        if (character === '\b' || character === '\u007f') {
          secret = secret.slice(0, -1);
        } else if (character >= ' ') {
          secret += character;
        }
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = validate(readJson(path.resolve(args.config)), { production: args.apply });
  if (
    args.apply &&
    !['doctor', 'render', 'smoke'].includes(args.action) &&
    (!args.authorizeCharges || args.confirmProject !== config.project_id)
  ) {
    throw new ConfigurationError('Mutation requires --authorize-charges --confirm-project EXACT_PROJECT');
  }
  const runner = new Runner(config, args.apply);
  const directory = path.resolve(args.output);
  if (['render', 'deploy', 'jobs-deploy'].includes(args.action)) {
    render(config, directory);
  }

  switch (args.action) {
    case 'render':
      console.log(JSON.stringify({ directory, resources: 6 }));
      break;
    case 'doctor':
      runner.command(['version']);
      runner.command(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
      runner.command(['projects', 'describe', config.project_id, '--format=json']);
      runner.command(['services', 'list', '--enabled', '--format=value(config.name)']);
      runner.command([
        'run', 'services', 'describe', 'photointel-api',
        '--region', config.region, '--format=json',
      ]);
      break;
    case 'secret-add': {
      if (!Object.hasOwn(config.secrets, args.secret)) {
        throw new ConfigurationError('Choose a configured secret field with --secret');
      }
      const name = config.secrets[args.secret].name;
      const command = [
        'secrets', 'versions', 'add', name,
        '--data-file=-', '--project', config.project_id, '--quiet',
      ];
      printCommand('gcloud', command);
      if (args.apply) {
        const value = await readHiddenLine('Secret value (hidden; never stored in config): ');
        if (!value) throw new ConfigurationError('Empty secret is not accepted');
        runChecked('gcloud', command, { input: Buffer.from(value, 'utf8'), timeout: 60_000 });
      }
      break;
    }
    case 'bootstrap':
      bootstrap(runner);
      break;
    case 'build': {
      const sha = args.gitSha || runChecked('git', ['rev-parse', 'HEAD'], { capture: true, cwd: ROOT });
      if (!fullmatch(/^[a-f0-9]{40}$/, sha)) {
        throw new ConfigurationError('Build requires a full Git commit SHA');
      }
      const repositoryImage = config.image.split('@', 1)[0].replace(/:[^:]+$/, '');
      const image = `${repositoryImage}:${sha}`;
      const manifest = path.join(ROOT, 'release-manifest.json');
      if (runner.apply) {
        const current = runChecked('git', ['rev-parse', 'HEAD'], { capture: true, cwd: ROOT });
        if (current !== sha || existsSync(manifest)) {
          throw new ConfigurationError('Build must match HEAD and not overwrite a manifest');
        }
        // The repository's existing manifest generator remains Python.
        runChecked(process.env.PYTHON || 'python3', [
          path.join(ROOT, 'infra/scripts/release-manifest.py'),
          '--output', manifest,
        ], { cwd: ROOT, timeout: 60_000 });
      }
      try {
        runner.command([
          'builds', 'submit', ROOT,
          '--config', path.join(ROOT, 'infra/gcp/cloudbuild.yaml'),
          '--substitutions', `_IMAGE_URI=${image},_GIT_SHA=${sha}`,
          '--ignore-file', path.join(ROOT, 'infra/gcp/build.gcloudignore'),
          '--gcs-source-staging-dir', `gs://${config.project_id}-photointel-build-source/source`,
          '--service-account', `projects/${config.project_id}/serviceAccounts/${identity(config, 'builder')}`,
        ]);
      } finally {
        if (runner.apply) {
          try {
            unlinkSync(manifest);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
      const imageName = image.slice(0, image.lastIndexOf(':'));
      const listing = runner.command([
        'artifacts', 'docker', 'images', 'list', imageName,
        '--include-tags', '--format=json',
      ], { capture: true });
      if (runner.apply) {
        const digest = verifiedDockerDigest(listing, sha);
        console.log(`Verified Artifact Registry image: ${imageName}@${digest} (commit ${sha})`);
      }
      break;
    }
    case 'deploy':
      runner.command([
        'run', 'services', 'replace', path.join(directory, 'photointel-api.json'),
        '--region', config.region,
      ]);
      // Public network transport; authentication must be enforced inside FastAPI.
      runner.command([
        'run', 'services', 'add-iam-policy-binding', 'photointel-api',
        '--region', config.region,
        '--member', 'allUsers',
        '--role', 'roles/run.invoker',
      ]);
      break;
    case 'jobs-deploy':
      deployJobs(runner, directory);
      break;
    case 'scheduler':
      scheduler(runner);
      break;
    case 'migrate':
      if (args.apply && !args.initialEmptyDatabase) {
        if (!args.backupDirectory || !args.backupReceipt) {
          throw new ConfigurationError(
            'Migration requires --backup-directory and --backup-receipt, or explicit --initial-empty-database for a verified empty database',
          );
        }
        await verifyBackupReceipt(path.resolve(args.backupDirectory), path.resolve(args.backupReceipt));
      }
      runner.command([
        'run', 'jobs', 'execute', 'photointel-migrate',
        '--wait', '--region', config.region,
      ]);
      break;
    case 'rollback':
      if (!fullmatch(/^photointel-api-[a-z0-9-]{1,45}$/, args.revision)) {
        throw new ConfigurationError('Specify the exact previously verified API revision');
      }
      runner.command([
        'run', 'services', 'update-traffic', 'photointel-api',
        '--region', config.region,
        '--to-revisions', `${args.revision}=100`,
      ]);
      break;
    case 'cleanup':
      for (const mode of SCHEDULED) {
        runner.command([
          'scheduler', 'jobs', 'pause', `photointel-${mode}`,
          '--location', config.region,
        ]);
      }
      break;
    case 'smoke':
      if (!args.origin) {
        throw new ConfigurationError('Specify --origin https://SERVICE-HASH-REGION.run.app');
      }
      if (args.apply) {
        console.log(JSON.stringify(await smoke(config, args.origin), null, 2));
      } else {
        console.log('Offline plan: anonymous origin probes; no credentials or cloud mutation');
      }
      break;
    default:
      throw new ConfigurationError(`Unknown action: ${args.action}`);
  }
}

main().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(`${error.name || 'Error'}: ${error.message}`);
    process.exitCode = 1;
  }
});
