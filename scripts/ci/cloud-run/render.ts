import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Reference = {name: string; version: string};
type Config = {
  project_id: string; image: string; release_git_sha: string; release_branch?: string;
  region: string; frontend_origin: string; api_origin: string; access_team_domain: string;
  access_audience: string; access_allowed_emails: string[]; storage_endpoint: string; storage_bucket: string;
  enable_gpu?: boolean; enable_icloud?: boolean; icloud_account?: string; icloud_library?: string;
  database_profile: string; database_catalog_limit: number; api_max_instances: number;
  api_concurrency: number; api_timeout_seconds: number; job_task_count: number; job_parallelism: number;
  job_timeout_seconds: number; job_max_jobs: number; job_deadline_seconds: number;
  extra_environment?: Record<string,string>; secrets: Record<string,Reference>;
};
const modes = ['discover','backfill','worker','maintenance','migrate'] as const;
type Mode = 'api' | typeof modes[number];
const allowedSecrets = new Set(['DATABASE_URL','MIGRATION_DATABASE_URL','STORAGE_ACCESS_KEY','STORAGE_SECRET_KEY','BRIDGE_TOKEN_PEPPER','BRIDGE_ENROLLMENT_SECRET','ICLOUD_SESSION_KEY','MODAL_TOKEN','MODAL_PROXY_KEY','MODAL_PROXY_SECRET','NOTIFY_DEVICE_ID','NOTIFY_TOKEN','SENTRY_DSN','SENTRY_API_TOKEN','TELEGRAM_NOTIFICATION_API_TOKEN']);
export function environment(c: Config, mode: Mode) {
  const migrate = mode === 'migrate', extra = c.extra_environment ?? {};
  const values: Record<string,string> = {
    APP_ENV:'production', AUTH_MODE:'cloudflare', EXECUTION_PLATFORM:'cloud_run', VERIFICATION_GATES_ENFORCED:'true',
    RELEASE_GIT_SHA:c.release_git_sha, RELEASE_BRANCH:c.release_branch ?? 'main', FRONTEND_ORIGIN:c.frontend_origin,
    API_ORIGIN:c.api_origin, ACCESS_TEAM_DOMAIN:c.access_team_domain, ACCESS_AUDIENCE:c.access_audience,
    ACCESS_ALLOWED_EMAILS:'['+c.access_allowed_emails.map(email=>JSON.stringify(email)).join(', ')+']', STORAGE_BACKEND:'r2', STORAGE_ENDPOINT:c.storage_endpoint,
    STORAGE_BUCKET:c.storage_bucket, STORAGE_REGION:'auto', GPU_ENABLED:String(c.enable_gpu ?? false),
    ICLOUD_ENABLED:String(c.enable_icloud ?? false), INFERENCE_BACKEND:'modal', APPLE_NATIVE_WRITE_ENABLED:'false',
    AUTO_DELETE_ENABLED:'false', INITIAL_IMPORT_LIMIT:'100', INGESTION_IMPORT_LIMIT:'100',
    ICLOUD_ACCOUNT:c.icloud_account ?? '', ICLOUD_LIBRARY:c.icloud_library ?? '', TEMP_DIRECTORY:'/tmp/photointel/processing',
    ICLOUD_SESSION_DIRECTORY:'/tmp/photointel/session', ICLOUD_DOWNLOAD_DIRECTORY:'/tmp/photointel/downloads',
    DATABASE_POOL_SIZE:'2', DATABASE_MAX_OVERFLOW:'0', DATABASE_POOL_MODE:'transaction', DATABASE_REQUIRE_TLS:'true',
    DATABASE_TLS_CA_FILE:'/etc/ssl/certs/ca-certificates.crt', DATABASE_PROFILE:c.database_profile,
    CATALOG_ASSET_LIMIT:String(c.database_catalog_limit), ICLOUD_SESSION_BACKEND:'encrypted_object',
    GCP_PROJECT_ID:c.project_id, GCP_REGION:c.region, GCP_JOB_DISPATCH_ENABLED:String(!migrate),
    NOTIFY_JOB_EVENTS_ENABLED:String(!migrate && !!c.secrets.NOTIFY_DEVICE_ID && !!c.secrets.NOTIFY_TOKEN),
    TELEGRAM_JOB_EVENTS_ENABLED:String(!migrate && !!(extra.TELEGRAM_NOTIFICATION_API_TOKEN || c.secrets.TELEGRAM_NOTIFICATION_API_TOKEN) && !!extra.TELEGRAM_NOTIFICATION_URL && !!extra.TELEGRAM_NOTIFICATION_CHAT_ID),
    ...extra
  };
  if(migrate) delete values.TELEGRAM_NOTIFICATION_API_TOKEN;
  const entries: Array<{name:string;value?:string;valueFrom?:{secretKeyRef:{name:string;key:string}}}> = Object.keys(values).sort().map(name=>({name,value:values[name]}));
  for(const name of Object.keys(c.secrets).sort()){
    const ref=c.secrets[name];
    if(!allowedSecrets.has(name)||!/^[a-z][a-z0-9-]{0,254}$/.test(ref.name)||!/^[1-9][0-9]{0,9}$/.test(ref.version)) throw new Error('Invalid secret reference: '+name);
    if(name==='TELEGRAM_NOTIFICATION_API_TOKEN' && name in values) continue;
    if(migrate ? !['DATABASE_URL','MIGRATION_DATABASE_URL'].includes(name) : name==='MIGRATION_DATABASE_URL'||(mode!=='api'&&name==='SENTRY_API_TOKEN')) continue;
    entries.push({name,valueFrom:{secretKeyRef:{name:ref.name,key:ref.version}}});
  }
  return entries;
}
const identity=(c:Config,role:string)=>'photointel-'+role+'@'+c.project_id+'.iam.gserviceaccount.com';
export function service(c:Config){
  return {apiVersion:'serving.knative.dev/v1',kind:'Service',metadata:{name:'photointel-api',namespace:c.project_id},spec:{template:{
    metadata:{annotations:{'autoscaling.knative.dev/minScale':'0','autoscaling.knative.dev/maxScale':String(c.api_max_instances),'run.googleapis.com/cpu-throttling':'true','run.googleapis.com/startup-cpu-boost':'false'}},
    spec:{serviceAccountName:identity(c,'api'),containerConcurrency:c.api_concurrency,timeoutSeconds:c.api_timeout_seconds,containers:[{
      image:c.image,command:['python'],args:['/app/infra/gcp/entrypoint.py'],ports:[{containerPort:8080}],env:environment(c,'api'),
      resources:{limits:{cpu:'1000m',memory:'1Gi'}},startupProbe:{httpGet:{path:'/health/live',port:8080},periodSeconds:10,timeoutSeconds:5,failureThreshold:12},
      livenessProbe:{httpGet:{path:'/health/live',port:8080},periodSeconds:30,timeoutSeconds:5,failureThreshold:3}
    }]}
  }}};
}
export function job(c:Config,mode:typeof modes[number]){
  const migration=mode==='migrate', taskCount=mode==='worker'?c.job_task_count:1;
  return {apiVersion:'run.googleapis.com/v1',kind:'Job',metadata:{name:'photointel-'+mode,namespace:c.project_id},spec:{template:{spec:{
    taskCount,parallelism:Math.min(c.job_parallelism,taskCount),template:{spec:{serviceAccountName:identity(c,migration?'migrate':'jobs'),
    maxRetries:migration?0:1,timeoutSeconds:migration?'1800':String(c.job_timeout_seconds),containers:[{
      image:c.image,command:['python'],args:['-m','photointel.services.task_runner',mode,'--max-jobs',String(c.job_max_jobs),'--deadline-seconds',migration?'1700':String(c.job_deadline_seconds)],
      env:environment(c,mode),resources:{limits:{cpu:'1000m',memory:'2Gi'}}
    }]}}
  }}}};
}
export function validate(c:Config): void {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c.project_id) || !/^[a-z]+-[a-z]+[0-9]$/.test(c.region)) throw new Error('Invalid project or region');
  if (!/^[a-f0-9]{40}$/.test(c.release_git_sha)) throw new Error('Invalid release SHA');
  const prefix=c.region+'-docker.pkg.dev/'+c.project_id+'/';
  if (!c.image.startsWith(prefix) || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]\/api(?::[a-f0-9]{40}|@sha256:[a-f0-9]{64})$/.test(c.image.slice(prefix.length))) throw new Error('Invalid immutable image');
  if (!c.image.includes('@') && !c.image.endsWith(':'+c.release_git_sha)) throw new Error('Image SHA mismatch');
  for(const value of [c.frontend_origin,c.api_origin,c.storage_endpoint]){
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/') throw new Error('Invalid HTTPS origin');
  }
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(c.access_team_domain)||!c.access_audience||c.access_audience.length>256) throw new Error('Invalid Access identity');
  if(!Array.isArray(c.access_allowed_emails)||c.access_allowed_emails.length<1||c.access_allowed_emails.length>100||c.access_allowed_emails.some(e=>typeof e!=='string'||!/^\S+@\S+$/.test(e))) throw new Error('Invalid Access allowlist');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.storage_bucket)) throw new Error('Invalid storage bucket');
  const limits: Array<[number,number,number]>=[[c.api_max_instances,1,30],[c.api_concurrency,1,80],[c.api_timeout_seconds,10,3600],[c.job_task_count,1,32],[c.job_parallelism,1,32],[c.job_max_jobs,1,10000],[c.job_deadline_seconds,30,82800],[c.job_timeout_seconds,60,86400],[c.database_catalog_limit,100,10000000]];
  if(limits.some(([v,min,max])=>!Number.isInteger(v)||v<min||v>max)||c.job_parallelism>c.job_task_count||c.job_deadline_seconds+60>c.job_timeout_seconds) throw new Error('Invalid execution limits');
  if(!['limited','full'].includes(c.database_profile)||(c.database_profile==='limited'&&c.database_catalog_limit>10000)) throw new Error('Invalid database profile');
  for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','STORAGE_ACCESS_KEY','STORAGE_SECRET_KEY','BRIDGE_TOKEN_PEPPER','BRIDGE_ENROLLMENT_SECRET','ICLOUD_SESSION_KEY']) if(!c.secrets[key]) throw new Error('Missing secret reference: '+key);
  for(const flag of [c.enable_gpu,c.enable_icloud]) if(flag!==undefined&&typeof flag!=='boolean') throw new Error('Invalid feature flag');
  if(c.enable_icloud&&(!c.icloud_account||!c.icloud_library)) throw new Error('Missing iCloud metadata');
  if(c.enable_gpu&&(!c.secrets.MODAL_TOKEN||!c.secrets.MODAL_PROXY_KEY||!c.secrets.MODAL_PROXY_SECRET||!c.extra_environment?.MODAL_ENDPOINT?.startsWith('https://'))) throw new Error('Missing GPU configuration');
}
export function render(c:Config, directory:string){
  validate(c);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const docs=[['api',service(c)],...modes.map(mode=>[mode,job(c,mode)])] as const;
  for(const [name,doc] of docs) writeFileSync(join(directory,'photointel-'+name+'.json'),JSON.stringify(doc,null,2)+'\n',{mode:0o600});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [,,input,output]=process.argv;
  if(!input||!output) throw new Error('Usage: node render.ts validated-config.json output-directory');
  render(JSON.parse(readFileSync(input,'utf8')),output);
}
