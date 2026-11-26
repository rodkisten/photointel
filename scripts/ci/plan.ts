import { appendFileSync } from 'node:fs';
import { type App } from '../../rodverse.config.ts';
import { allApps as all, affectedApps, changedFiles } from './affected.ts';
function plan(): App[] {
  if (process.env.EVENT_NAME === 'workflow_dispatch') {
    const requested = process.env.REQUESTED_APP || 'all';
    if (requested === 'all') return all;
    if (!all.includes(requested as App)) throw new Error('Unsupported app selection');
    return [requested as App];
  }
  const pr = process.env.EVENT_NAME === 'pull_request';
  const candidate = (pr ? process.env.BASE_SHA : process.env.BEFORE_SHA) || '';
  const files=changedFiles(candidate,process.env.GITHUB_SHA||'',pr);
  return affectedApps(files);
}
const apps = plan();
const output = process.env.GITHUB_OUTPUT;
if (!output) throw new Error('GITHUB_OUTPUT required');
appendFileSync(output, 'apps='+JSON.stringify(apps)+'\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### 🔮 Deployment plan\n\n'+all.map(app=>'- '+(apps.includes(app)?'🟢':'➖')+' '+app+'\n').join(''));
console.log('Selected:', JSON.stringify(apps));
