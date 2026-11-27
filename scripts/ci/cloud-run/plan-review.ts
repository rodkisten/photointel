import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const allowed = new Set(['no-op','create','read','update','delete']);
export function reviewPlan(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw Error('Invalid Terraform plan');
  const value = plan as Record<string,unknown>;
  if (value.errored === true || value.complete === false) throw Error('Incomplete or errored Terraform plan');
  const resources = value.resource_changes ?? [];
  if (!Array.isArray(resources)) throw Error('Invalid resource changes');
  const changes: string[] = [];
  for (const resource of resources) {
    if (!resource || typeof resource.address !== 'string' || !resource.address || /[\r\n]/.test(resource.address)) throw Error('Invalid resource address');
    const actions: unknown = resource.change?.actions;
    if (!Array.isArray(actions) || !actions.length || actions.some(a => typeof a !== 'string' || !allowed.has(a))) throw Error('Unsupported Terraform action');
    if (actions.includes('delete')) throw Error('Destruction/replacement blocked: '+resource.address);
    if (actions.length !== 1) throw Error('Unsupported action combination');
    if (resource.mode !== 'managed' && resource.mode !== 'data') throw Error('Unsupported resource mode');
    if (resource.mode === 'managed' && actions[0] !== 'no-op') changes.push(resource.address+': '+actions.join(', '));
  }
  return changes;
}
export function main(scope: string) {
  if (scope !== 'gcp' && scope !== 'cloudflare') throw Error('Unsupported Terraform scope');
  const cwd = 'infra/terraform/environments/'+(scope === 'gcp' ? 'production' : 'cloudflare');
  let output: string;
  try { output = execFileSync('terraform',['show','-json','tfplan'],{cwd,encoding:'utf8',timeout:180000,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']}); }
  catch { throw Error('Unable to inspect saved Terraform plan'); }
  const changes = reviewPlan(JSON.parse(output));
  console.log('Plan reviewed: no deletion or replacement.\n'+changes.join('\n'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
