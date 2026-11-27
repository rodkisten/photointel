import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
    if(result.error||result.status!==0) throw new Error('gcloud operation failed: '+((result.error as NodeJS.ErrnoException | undefined)?.code??result.status??result.signal??'unknown'));
    return {executed:true,stdout:result.stdout};
  }
  function region(value:string){if(!/^[a-z]+-[a-z]+[0-9]$/.test(value))throw new Error('Invalid region');return value;}
  return {
    submitApiBuild:(location:string,repository:string,sha:string)=>{
      if(!/^[a-f0-9]{40}$/.test(sha)||!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(repository)) throw new Error('Invalid build metadata');
      const root=resolve(cwd??process.cwd());
      if(apply){
        const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:10000});
        if(head.status!==0||head.stdout.trim()!==sha||!existsSync(resolve(root,'release-manifest.json'))) throw new Error('Build requires matching HEAD and prepared release manifest');
      }
      const image=region(location)+'-docker.pkg.dev/'+project+'/'+repository+'/api:'+sha;
      return invoke(['builds','submit',root,'--config',resolve(root,'infra/gcp/cloudbuild.yaml'),'--substitutions','_IMAGE_URI='+image+',_GIT_SHA='+sha,'--ignore-file',resolve(root,'infra/gcp/build.gcloudignore'),'--gcs-source-staging-dir','gs://'+project+'-photointel-build-source/source','--service-account','projects/'+project+'/serviceAccounts/photointel-builder@'+project+'.iam.gserviceaccount.com'],3600000);
    },
    submitMediaBuild:(location:string,repository:string,sha:string)=>{
      if(!/^[a-f0-9]{40}$/.test(sha)||!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(repository)) throw new Error('Invalid media build metadata');
      const root=resolve(cwd??process.cwd());
      if(apply){
        const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:10000});
        const status=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',timeout:10000});
        if(head.status!==0||head.stdout.trim()!==sha||status.status!==0||status.stdout.trim()) throw new Error('Media build requires clean matching HEAD');
      }
      return invoke(['builds','submit',root,'--config',resolve(root,'services/media/cloudbuild.yaml'),'--gcs-source-staging-dir','gs://'+project+'-photointel-build-source/source','--service-account','projects/'+project+'/serviceAccounts/photointel-builder@'+project+'.iam.gserviceaccount.com','--substitutions','_REGION='+region(location)+',_REPOSITORY='+repository+',_GIT_SHA='+sha],3600000);
    },
    doctor:()=>[invoke(commands.version),invoke(commands.identity),invoke([...commands.project,project,'--format=json']),invoke(commands.services)],
    describeApi:(location:string)=>invoke(['run','services','describe','photointel-api','--region='+region(location),'--format=json']),
    describeJob:(location:string,mode:string)=>{
      if(!['discover','backfill','worker','maintenance','migrate'].includes(mode))throw new Error('Invalid job');
      return invoke(['run','jobs','describe','photointel-'+mode,'--region='+region(location),'--format=json']);
    },
    listImages:(location:string,repository:string,kind:'api'|'media-image'|'media-video'|'media-imagor'='api')=>{
      if(!['api','media-image','media-video','media-imagor'].includes(kind)) throw new Error('Invalid image kind');
      if(!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(repository))throw new Error('Invalid repository');
      return invoke(['artifacts','docker','images','list',region(location)+'-docker.pkg.dev/'+project+'/'+repository+'/'+kind,'--include-tags','--format=json']);
    }
  };
}
