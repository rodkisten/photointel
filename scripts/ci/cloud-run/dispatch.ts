import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
type App='web'|'manage';
type Action='build'|'build-and-deploy';
type Run={id:number;display_title:string;status:string;conclusion:string|null};
type Job={name:string;conclusion:string|null};
type Api=(path:string,payload?:unknown)=>unknown;
const repo='repos/rodverse/rodverse';
const endpoint=repo+'/actions/workflows/frontend-release.yml';
export const ghApi:Api=(path,payload)=>{
  const args=['api',path];
  if(payload!==undefined) args.push('--method','POST','--input','-');
  const result=spawnSync('gh',args,{encoding:'utf8',input:payload===undefined?undefined:JSON.stringify(payload),timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,GH_PROMPT_DISABLED:'1'}});
  if(result.error||result.status!==0) throw new Error('GitHub API request failed; inspect Actions before retrying');
  return result.stdout.trim()?JSON.parse(result.stdout):null;
};
export function matchingRun(runs:Run[],title:string):Run|undefined {
  const matches=runs.filter(r=>r.display_title===title);
  if(matches.length>1) throw new Error('Ambiguous release dispatch');
  const run=matches[0];
  if(run&&(!Number.isSafeInteger(run.id)||run.id<=0)) throw new Error('Invalid run ID');
  return run;
}
export function verifyJobs(jobs:Job[],app:App,action:Action){
  const expected=action==='build'?'🧪 Build & Test · '+app:'🚀 Publish · '+app;
  if(!jobs.some(j=>j.name.split(' / ').at(-1)===expected&&j.conclusion==='success')) throw new Error('Requested release job not confirmed');
}
export async function dispatchFrontend(app:App,sha:string,action:Action,options:{api?:Api;timeoutMs?:number;pollMs?:number;onRun?:(url:string)=>void}={}){
  if(!['web','manage'].includes(app)||!['build','build-and-deploy'].includes(action)||!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release selection');
  if(process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_REPOSITORY!=='rodverse/rodverse'||process.env.CONFIRM!=='true') throw new Error('Main-only confirmed release required');
  const api=options.api??ghApi;
  const request='release-'+randomUUID();
  const title='🌐 Cloudflare · '+action+' · '+app+' · '+request;
  const deadline=performance.now()+(options.timeoutMs??3600000);
  api(endpoint+'/dispatches',{ref:'main',inputs:{app,sha,action,request_id:request}});
  let id:number|undefined;
  while(performance.now()<deadline){
    if(id===undefined){
      const response=api(endpoint+'/runs?branch=main&event=workflow_dispatch&per_page=100') as {workflow_runs:Run[]};
      const run=matchingRun(response.workflow_runs,title);
      if(run){id=run.id;options.onRun?.('https://github.com/rodverse/rodverse/actions/runs/'+id);}
    }else{
      const run=api(repo+'/actions/runs/'+id) as Run;
      if(run.status==='completed'){
        if(run.conclusion!=='success') throw new Error('Release failed: '+id);
        const response=api(repo+'/actions/runs/'+id+'/jobs?per_page=100') as {jobs:Job[]};
        verifyJobs(response.jobs,app,action);
        return id;
      }
    }
    await sleep(options.pollMs??15000);
  }
  throw new Error('Release timed out; inspect request '+request+' before retrying');
}
