import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Env = NodeJS.ProcessEnv;
export function context(env: Env = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error('Missing ' + key);
    return value;
  };
  const scope = required('TF_SCOPE');
  if (scope !== 'gcp' && scope !== 'cloudflare') throw new Error('Unsupported Terraform scope');
  const bucket = required('TF_PLAN_BUCKET'), sha = required('GITHUB_SHA');
  if (!/^[a-z0-9][a-z0-9._-]{2,221}$/.test(bucket)) throw new Error('Invalid bucket');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid Git commit SHA');
  return { scope, bucket, root: 'infra/terraform/environments/' + (scope === 'gcp' ? 'production' : 'cloudflare'),
    sha, config_sha256: checksum('infra/gcp/config.local.json'),
    runtime_targets: scope === 'gcp' ? env.TF_RUNTIME_TARGETS ?? 'api,jobs' : '',
    api_sha: scope === 'gcp' ? env.TF_API_SHA ?? '' : '',
    image_sha: scope === 'gcp' ? env.TF_IMAGE_SHA ?? '' : '' };
}
const checksum = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function latestId(output: string, prefix: string) {
  const ids = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).match(/^([0-9]{1,20})\/manifest\.json$/)?.[1])
    .filter((id): id is string => Boolean(id)).map(BigInt);
  if (!ids.length) throw new Error('No saved plans for this scope. Run Plan first.');
  return ids.reduce((a,b) => a > b ? a : b).toString();
}
export function validateMetadata(metadata: Record<string, unknown>, expected: Record<string, unknown>, runId: string, now = Date.now()) {
  for (const [key,value] of Object.entries(expected)) if (metadata[key] !== value) throw new Error('Reviewed plan mismatch: ' + key);
  if (metadata.run_id !== runId) throw new Error('Plan run ID mismatch');
  const created = typeof metadata.created_at === 'string' ? Date.parse(metadata.created_at) : NaN;
  if (!Number.isFinite(created) || created > now || now-created > 86400000) throw new Error('Plan timestamp invalid or expired (24h)');
  if (typeof metadata.plan_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.plan_sha256)) throw new Error('Invalid plan checksum');
}
function gcloud(args: string[], timeout = 180000) {
  try { return execFileSync('gcloud', ['storage', ...args], {encoding:'utf8', timeout, maxBuffer: 8*1024*1024, stdio:['ignore','pipe','pipe']}); }
  catch { throw new Error('Private plan storage operation failed'); }
}
export function main(action: string) {
  if (action !== 'save' && action !== 'restore') throw new Error('Expected save or restore');
  const {scope,bucket,root,...fields} = context();
  const expected = {scope,...fields};
  const prefix = 'gs://' + bucket + '/terraform-reviewed-plans/' + scope + '/';
  const runId = action === 'save' ? process.env.GITHUB_RUN_ID?.trim() : process.env.PLAN_RUN_ID?.trim() || latestId(gcloud(['ls',prefix+'*/manifest.json'],120000),prefix);
  if (!runId || !/^[0-9]{1,20}$/.test(runId)) throw new Error('Plan run ID must be numeric');
  const uri = prefix+runId, plan = root+'/tfplan', manifest = root+'/tfplan-manifest.json';
  if (action === 'save') {
    if (!statSync(plan).isFile()) throw new Error('Plan was not generated');
    writeFileSync(manifest, JSON.stringify({...expected,run_id:runId,plan_sha256:checksum(plan),created_at:new Date().toISOString()}),{mode:0o600});
    gcloud(['cp',plan,uri+'/tfplan']);
    gcloud(['cp',manifest,uri+'/manifest.json']);
    console.log('Reviewed plan stored privately. Apply with plan_run_id='+runId);
  } else {
    gcloud(['cp',uri+'/manifest.json',manifest]);
    const metadata = JSON.parse(readFileSync(manifest,'utf8'));
    validateMetadata(metadata,expected,runId);
    gcloud(['cp',uri+'/tfplan',plan]);
    if (checksum(plan)!==metadata.plan_sha256) throw new Error('Plan checksum mismatch');
    console.log('Verified saved plan from run '+runId+'; Terraform will check remote state on apply.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
