import { resolve } from 'node:path';
export const processingModes=['discover','backfill','worker','maintenance'] as const;
export const scheduledModes=['discover','worker','maintenance'] as const;
export function planJobs(project:string,region:string,directory:string,apply=false){
  if(apply) throw new Error('Processing jobs are owned by Terraform. Use TF Production.');
  if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)||!/^[a-z]+-[a-z]+[0-9]$/.test(region)) throw new Error('Invalid project or region');
  return processingModes.flatMap(mode=>{
    const name='photointel-'+mode;
    const roles=['api','jobs',...(mode==='backfill'?[]:['scheduler'])];
    return [
      ['run','jobs','replace',resolve(directory,name+'.json'),'--region',region,'--project',project],
      ...roles.map(role=>['run','jobs','add-iam-policy-binding',name,'--region',region,'--member','serviceAccount:photointel-'+role+'@'+project+'.iam.gserviceaccount.com','--role','roles/run.invoker','--project',project])
    ];
  });
}
export function planScheduler(project:string,region:string,timezone:string,schedules:Record<typeof scheduledModes[number],string>,existing:ReadonlySet<string>,autoResume=false){
  if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)||!/^[a-z]+-[a-z]+[0-9]$/.test(region)) throw new Error('Invalid project or region');
  new Intl.DateTimeFormat('en',{timeZone:timezone});
  return scheduledModes.flatMap(mode=>{
    const name='photointel-'+mode, schedule=schedules[mode];
    if(typeof schedule!=='string'||!schedule.trim()||/[\r\n\0]/.test(schedule)) throw new Error('Invalid schedule');
    const update=existing.has(name);
    const args=['scheduler','jobs',update?'update':'create','http',name,'--location',region,'--schedule',schedule,'--time-zone',timezone,'--uri','https://run.googleapis.com/v2/projects/'+project+'/locations/'+region+'/jobs/'+name+':run','--http-method','POST',update?'--update-headers':'--headers','Content-Type=application/json','--message-body','{}','--oauth-service-account-email','photointel-scheduler@'+project+'.iam.gserviceaccount.com','--oauth-token-scope','https://www.googleapis.com/auth/cloud-platform','--attempt-deadline','60s','--max-retry-attempts','1','--project',project];
    const action=autoResume?'resume':update?null:'pause';
    return [args,...(action?[['scheduler','jobs',action,name,'--location',region,'--project',project]]:[])];
  });
}
