import { spawnSync } from 'node:child_process';
export type RunnerOptions = { project:string; apply?:boolean; authorizeCharges?:boolean; confirmProject?:string; cwd?:string };
export type Result = { executed:boolean; stdout:string };
const commands = {
  version: ['version'],
  identity: ['auth','list','--filter=status:ACTIVE','--format=value(account)'],
  project: ['projects','describe'],
  services: ['services','list','--enabled','--format=value(config.name)'],
} as const;
export function createRunner(options:RunnerOptions) {
  const {project,apply=false,cwd}=options;
  if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('Invalid project');
  if(apply&&(!options.authorizeCharges||options.confirmProject!==project)) throw new Error('Apply requires explicit project and charge authorization');
  function invoke(args:readonly string[], timeout=60000):Result {
    if(!apply) return {executed:false,stdout:''};
    const result=spawnSync('gcloud',[...args,'--project='+project,'--quiet'],{
      cwd, shell:false, encoding:'utf8', timeout, killSignal:'SIGKILL', maxBuffer:8*1024*1024, stdio:['ignore','pipe','pipe'],
      env:{...process.env,CLOUDSDK_CORE_DISABLE_PROMPTS:'1'}
    });
    if(result.error||result.status!==0) throw new Error('gcloud operation failed: '+(result.error?.code??result.status??result.signal??'unknown'));
    return {executed:true,stdout:result.stdout};
  }
  function region(value:string){if(!/^[a-z]+-[a-z]+[0-9]$/.test(value))throw new Error('Invalid region');return value;}
  return {
    doctor:()=>[invoke(commands.version),invoke(commands.identity),invoke([...commands.project,project,'--format=json']),invoke(commands.services)],
    describeApi:(location:string)=>invoke(['run','services','describe','photointel-api','--region='+region(location),'--format=json']),
    describeJob:(location:string,mode:string)=>{
      if(!['discover','backfill','worker','maintenance','migrate'].includes(mode))throw new Error('Invalid job');
      return invoke(['run','jobs','describe','photointel-'+mode,'--region='+region(location),'--format=json']);
    },
    listImages:(location:string,repository:string)=>{
      if(!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(repository))throw new Error('Invalid repository');
      return invoke(['artifacts','docker','images','list',region(location)+'-docker.pkg.dev/'+project+'/'+repository+'/api','--include-tags','--format=json']);
    }
  };
}
