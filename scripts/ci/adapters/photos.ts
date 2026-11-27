import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {publishWorker} from './cloudflare.ts';
type AccessApp={id:string;name:string;aud:string;domain?:string;self_hosted_domains?:string[];destinations?:{type:string;uri:string}[]};
const c=JSON.parse(readFileSync('infra/gcp/config.local.json','utf8'));
if(c.project_id!=='photointel'||process.env.CONFIRM_PROJECT!==c.project_id)throw new Error('Project mismatch');
const account=process.env.CLOUDFLARE_ACCOUNT_ID||'',token=process.env.CLOUDFLARE_API_TOKEN||'';
if(!/^[a-f0-9]{32}$/i.test(account)||!token||/[\r\n\0]/.test(token))throw new Error('Invalid Cloudflare credentials');
const origin=new URL(c.frontend_origin);
if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Invalid frontend origin');
const w=c.workflows?.worker??{};
if((w.name??'photointel')!=='photointel'||(w.domain??origin.hostname)!==origin.hostname)throw new Error('Unexpected Worker identity');
const sha=process.env.PHOTOINTEL_BUILD_SHA||process.env.GITHUB_SHA||'';
if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Invalid source SHA');
if(!existsSync('apps/web/dist/index.html'))throw new Error('Missing validated artifact');
async function pages<T>(path:string):Promise<T[]>{
 const result:T[]=[];
 for(let page=1;page<=100;page++){
  const url=new URL('https://api.cloudflare.com/client/v4/accounts/'+account+path);
  url.searchParams.set('page',String(page));url.searchParams.set('per_page','50');
  const response=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Cloudflare discovery failed: HTTP '+response.status);
  const data=await response.json();
  if(!data.success||!Array.isArray(data.result))throw new Error('Invalid Cloudflare response');
  result.push(...data.result);
  if(data.result_info?.total_pages?page>=data.result_info.total_pages:data.result.length<50)return result;
 }
 throw new Error('Pagination limit exceeded');
}
function domains(app:AccessApp){return [app.domain,...(app.self_hosted_domains??[]),...(app.destinations??[]).filter(d=>d.type==='public').map(d=>d.uri)].filter((v):v is string=>typeof v==='string').map(v=>v.replace(/^https?:\/\//,'').replace(/\/$/,''));}
const apps=await pages<AccessApp>('/access/apps');
const matches=apps.filter(a=>['photointel','photointel-web'].includes(a.name)&&domains(a).includes(origin.hostname));
if(matches.length!==1||! /^[a-f0-9]{64}$/i.test(matches[0].aud))throw new Error('Missing or ambiguous Photos Access application');
const bridge=apps.filter(a=>a.name==='photointel-bridge'&&domains(a).includes(origin.hostname+'/v1/bridge/*'));
if(bridge.length>1||(bridge.length===1&&!/^[a-f0-9]{64}$/i.test(bridge[0].aud)))throw new Error('Invalid Bridge Access application');
let cloudRun:string;
try{cloudRun=execFileSync('gcloud',['run','services','describe','photointel-api','--region',c.region,'--project',c.project_id,'--format=value(status.url)'],{encoding:'utf8',timeout:45000,stdio:['ignore','pipe','pipe']}).trim();}catch{throw new Error('Cloud Run discovery failed; verify run.services.get permission');}
const api=new URL(cloudRun);
if(api.protocol!=='https:'||!api.hostname.endsWith('.run.app')||api.username||api.password||api.port||api.pathname!=='/'||api.search||api.hash)throw new Error('Invalid Cloud Run origin');
const vars:Record<string,unknown>={CLOUD_RUN_ORIGIN:api.origin,FRONTEND_ORIGIN:origin.origin,ACCESS_TEAM_DOMAIN:c.access_team_domain,ACCESS_AUDIENCE:matches[0].aud,RELEASE_SHA:sha};
const reserved=new Set([...Object.keys(vars),'SENTRY_DSN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID']);
for(const [key,value] of Object.entries(c.cloudflare_environment??{})){
 if(!/^[A-Z][A-Z0-9_]*$/.test(key)||reserved.has(key)||/SECRET|TOKEN|PASSWORD|PRIVATE_KEY/.test(key)||value===null||!['string','boolean','number','object'].includes(typeof value)||JSON.stringify(value).length>8192)throw new Error('Invalid or protected Cloudflare binding: '+key);
 vars[key]=value;
}
if(c.extra_environment?.VITE_SENTRY_DSN)vars.SENTRY_DSN=c.extra_environment.VITE_SENTRY_DSN;
// Bridge policies remain Terraform-owned; do not adopt or mutate them here.
if(bridge.length===1)console.log('Bridge Access application discovered; policies preserved');
await publishWorker({cwd:resolve('infra/cloudflare/cloud-run-proxy'),account,token,config:{name:'photointel',main:'./worker.mjs',compatibility_date:'2026-10-31',workers_dev:false,keep_vars:true,preview_urls:false,observability:{enabled:true,head_sampling_rate:1,logs:{enabled:true,invocation_logs:false}},vars,assets:{directory:'../../../apps/web/dist',binding:'ASSETS',run_worker_first:true,not_found_handling:'single-page-application'},routes:[]}});
