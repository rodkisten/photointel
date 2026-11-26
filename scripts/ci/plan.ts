import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { workspace, type App } from '../../rodverse.config.ts';

const all = Object.keys(workspace.apps) as App[];
const git = (...args: string[]) => execFileSync('git', args, {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
const validSha = (sha: string) => /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha);
export function affectedApps(files: string[]): App[] {
  if (files.some(file => workspace.sharedPaths.test(file))) return all;
  return all.filter(app => files.some(file => file.startsWith(workspace.apps[app].root + '/')));
}
function plan(): App[] {
  if (process.env.EVENT_NAME === 'workflow_dispatch') {
    const requested = process.env.REQUESTED_APP || 'all';
    if (requested === 'all') return all;
    if (!all.includes(requested as App)) throw new Error('Unsupported app selection');
    return [requested as App];
  }
  const pr = process.env.EVENT_NAME === 'pull_request';
  const candidate = (pr ? process.env.BASE_SHA : process.env.BEFORE_SHA) || '';
  if (!validSha(candidate)) return all;
  let files: string[];
  try {
    git('cat-file','-e',candidate+'^{commit}');
    const base = pr ? git('merge-base',candidate,'HEAD') : candidate;
    files = git('diff','--name-only','-z',base,'HEAD').split('\0').filter(Boolean);
  } catch {
    console.log('::warning::Unable to resolve diff; building all apps');
    return all;
  }
  return affectedApps(files);
}
const apps = plan();
const output = process.env.GITHUB_OUTPUT;
if (!output) throw new Error('GITHUB_OUTPUT required');
appendFileSync(output, 'apps='+JSON.stringify(apps)+'\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### 🔮 Deployment plan\n\n'+all.map(app=>'- '+(apps.includes(app)?'🟢':'➖')+' '+app+'\n').join(''));
console.log('Selected:', JSON.stringify(apps));
