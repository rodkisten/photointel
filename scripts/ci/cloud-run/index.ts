import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './render.ts';
import { buildRelease } from './build.ts';
import { createRunner } from './runner.ts';
import { planJobs,planScheduler } from './jobs.ts';
const root=fileURLToPath(new URL('../../../',import.meta.url));
export function main(args:string[]){
  const {positionals,values:v}=parseArgs({args,allowPositionals:true,strict:true,options:{
    config:{type:'string'},output:{type:'string'},'git-sha':{type:'string'},apply:{type:'boolean'},'authorize-charges':{type:'boolean'},'confirm-project':{type:'string'},'existing-schedule':{type:'string',multiple:true},help:{type:'boolean'}
  }});
  const [action]=positionals;
  if(v.help||!action){console.log('Usage: node scripts/ci/cloud-run/index.ts <render|build|doctor|jobs-plan|scheduler-plan> [--config path] [--output path] [--git-sha SHA] [--apply --authorize-charges --confirm-project PROJECT]');return;}
  if(positionals.length!==1||!['render','build','doctor','jobs-plan','scheduler-plan'].includes(action)) throw new Error('Unsupported action');
  if(v.apply&&!['build','doctor'].includes(action)) throw new Error('Action does not permit direct apply');
  const c=JSON.parse(readFileSync(v.config??resolve(root,'infra/gcp/config.local.json'),'utf8'));
  const output=v.output??resolve(root,'infra/gcp/rendered');
  const project=c.project_id,region=c.region;
  if(typeof project!=='string'||typeof region!=='string') throw new Error('Invalid configuration');
  if(action==='render'){render(c,output);console.log('Manifests rendered');return;}
  if(action==='build'){
    const result=buildRelease(root,project,region,c.repository,v['git-sha']??c.release_git_sha,v.apply,v['authorize-charges'],v['confirm-project']);
    console.log(JSON.stringify(result));return;
  }
  if(action==='jobs-plan'){console.log(JSON.stringify(planJobs(project,region,output),null,2));return;}
  if(action==='scheduler-plan'){
    console.log(JSON.stringify(planScheduler(project,region,c.scheduler_timezone,{discover:c.discovery_schedule,worker:c.worker_schedule,maintenance:c.maintenance_schedule},new Set(v['existing-schedule']??[]),c.auto_resume_schedules===true),null,2));return;
  }
  const runner=createRunner({project,apply:v.apply,authorizeCharges:v['authorize-charges'],confirmProject:v['confirm-project']});
  const results=runner.doctor();
  console.log(JSON.stringify({executed:results.every(r=>r.executed),checks:results.length}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main(process.argv.slice(2));}catch{console.error('Cloud Run command rejected or failed; verify configuration and authorization.');process.exitCode=1;}
}
