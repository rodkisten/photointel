import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ghApi,matchingRun } from './dispatch.ts';
type Request={action:'plan'|'apply';scope:'gcp'|'cloudflare';head:string;apiSha?:string;mediaSha?:string};
export function terraformInputs(r:Request,requestId:string){
  if(!['plan','apply'].includes(r.action)||!['gcp','cloudflare'].includes(r.scope)) throw new Error('Invalid Terraform selection');
  for(const sha of [r.head,r.apiSha,r.mediaSha]) if(sha!==undefined&&!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Full SHA required');
  if(r.scope==='cloudflare'&&(r.apiSha||r.mediaSha)) throw new Error('Invalid scope for image selection');
  if(r.action==='apply'&&r.scope==='gcp'&&!r.apiSha&&!r.mediaSha) throw new Error('Explicit image required');
  return {action:r.action,scope:r.scope,authorize_apply:String(r.action==='apply'),runtime_targets:'api,jobs',image_sha:r.mediaSha??'',api_sha:r.apiSha??'',expected_sha:r.head,request_id:requestId};
}
export function databaseGate(root:string){
  const result=spawnSync('bash',['infra/gcp/release.sh','gate'],{cwd:root,env:{...process.env,CONFIRM_PROJECT:'photointel'},stdio:'inherit',timeout:600000});
  if(result.error||result.status!==0) throw new Error('Database verification failed; apply blocked');
}
export async function dispatchTerraform(root:string,r:Request){
  if(process.env.GITHUB_REPOSITORY!=='rodverse/rodverse'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_SHA!==r.head) throw new Error('Main-only Terraform dispatch');
  if(r.action==='apply'&&process.env.CONFIRM!=='true') throw new Error('Explicit confirmation required');
  const request='native-'+randomUUID(),inputs=terraformInputs(r,request);
  if(r.action==='apply'&&r.apiSha){
    if(r.apiSha!==r.head) throw new Error('Historical API apply requires source-specific database verification');
    databaseGate(root);
  }
  const repo='repos/rodverse/rodverse',endpoint=repo+'/actions/workflows/tf-production.yml';
  const title='TF · '+r.action+' · '+r.scope+' · '+request;
  console.log('Terraform request: '+request);
  ghApi(endpoint+'/dispatches',{ref:'main',inputs});
  const deadline=performance.now()+3000000;
  let id:number|undefined;
  while(performance.now()<deadline){
    if(id===undefined){
      const response=ghApi(endpoint+'/runs?branch=main&event=workflow_dispatch&per_page=100') as {workflow_runs:Parameters<typeof matchingRun>[0]};
      id=matchingRun(response.workflow_runs,title)?.id;
      if(id) console.log('https://github.com/rodverse/rodverse/actions/runs/'+id);
    }else{
      const run=ghApi(repo+'/actions/runs/'+id) as {status:string;conclusion:string};
      if(run.status==='completed'){
        if(run.conclusion!=='success') throw new Error('Terraform failed: '+id);
        return id;
      }
    }
    await sleep(15000);
  }
  throw new Error('Terraform timed out; inspect request '+request+' before retrying');
}
