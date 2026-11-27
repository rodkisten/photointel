import { readFileSync, existsSync } from 'node:fs';
import { publishWorker } from './cloudflare.ts';
import { resolve } from 'node:path';
import { validateTerminal } from '../../../packages/env/src/deploy.ts';

const config = JSON.parse(readFileSync('infra/gcp/config.local.json','utf8'));
const extra: Record<string,string> = config.extra_environment ?? {};
const refs = config.workflow_secrets ?? {};
const secret = (key: string): string => {
  const v = process.env[key] ?? '';
  if (!v || v.length > 4096 || /[\r\n\0]/.test(v)) throw new Error('Missing or invalid credential: '+key);
  return v;
};
const account = secret('CLOUDFLARE_ACCOUNT_ID');
const deploy = secret('CLOUDFLARE_API_TOKEN');
const runtime = secret('MANAGE_CLOUDFLARE_API_TOKEN');
const github = secret('MANAGE_GITHUB_API_TOKEN');
if (!/^[a-f0-9]{32}$/i.test(account) || runtime.length < 20 || github.length < 20 || runtime === deploy) throw new Error('Invalid or non-isolated runtime credentials');
const name = 'photointel-manage', domain = 'photos-manage.migos.club', hook = 'photos-hooks.migos.club';
const cwd = resolve('apps/manage');
const emails: unknown = JSON.parse(extra.MANAGE_ACCESS_ALLOWED_EMAILS || '[]');
if (config.project_id !== 'photointel' || !Array.isArray(emails) || !emails.length || emails.some(e=>typeof e !== 'string'|| !/^[^@\s]+@[^@\s]+$/.test(e))) throw new Error('Invalid project or Access allowlist');
if (!existsSync(resolve(cwd,'dist/index.html'))) throw new Error('Missing Manage build');
async function pages(path: string): Promise<Record<string,any>[]> {
  const rows: Record<string,any>[] = [];
  for(let page=1;page<=100;page++){
    const url = new URL('https://api.cloudflare.com/client/v4/accounts/'+account+path);
    url.searchParams.set('page',String(page)); url.searchParams.set('per_page','50');
    const res = await fetch(url,{headers:{Authorization:'Bearer '+deploy},signal:AbortSignal.timeout(30000)});
    if (!res.ok) throw new Error('Cloudflare discovery failed: HTTP '+res.status);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.result)) throw new Error('Invalid Cloudflare discovery response');
    rows.push(...data.result);
    if (data.result_info?.total_pages ? page>=data.result_info.total_pages : data.result.length<50) return rows;
  }
  throw new Error('Cloudflare pagination limit exceeded');
}
const [apps,domains,dbs] = await Promise.all([pages('/access/apps'),pages('/workers/domains'),pages('/d1/database?name='+name)]);
if(domains.some(d=>[domain,hook].includes(d.hostname)&&d.service!==name)||apps.some(a=>String(a.domain??'').includes(hook))) throw new Error('Unexpected domain or Access ownership');
const matches=apps.filter(a=>a.name===name&&String(a.domain??'').includes(domain));
const db=dbs.filter(d=>d.name===name);
if(matches.length!==1||typeof matches[0].aud!=='string'||!matches[0].aud||db.length!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(db[0].uuid)) throw new Error('Terraform-owned Access or D1 not ready');
const wif='//iam.googleapis.com/projects/799387180206/locations/global/workloadIdentityPools/manage/providers/cloudflare-access';
const sa='photointel-manage@photointel.iam.gserviceaccount.com';
if ((extra.MANAGE_GCP_WIF_AUDIENCE||wif)!==wif||(extra.MANAGE_GCP_IMPERSONATE_SERVICE_ACCOUNT||sa)!==sa) throw new Error('Invalid Manage WIF identity');
validateTerminal(extra);
const vars: Record<string,string> = {
 BUILD_SOURCE_SHA:process.env.PHOTOINTEL_BUILD_SHA||process.env.GITHUB_SHA||'', ACCESS_TEAM_DOMAIN:config.access_team_domain, ACCESS_AUDIENCE:matches[0].aud, ACCESS_ALLOWED_EMAILS:JSON.stringify(emails),
 GITHUB_REPO:'rodkisten/photointel', MANAGE_PROJECT_REPOSITORIES:'rodkisten/userscripts-cf,rodkisten/jardim,rodkisten/roteador', GITHUB_ENVIRONMENT:'production', GITHUB_TOKEN_SECRET_VERSION:'github-actions',
 GCP_PROJECT_ID:'photointel', GCP_REGION:config.region||'us-central1', CLOUDFLARE_ACCOUNT_ID:account, GCP_WIF_AUDIENCE:wif, GCP_IMPERSONATE_SERVICE_ACCOUNT:sa,
 GITHUB_BILLING_OWNER:extra.MANAGE_GITHUB_BILLING_OWNER||'rodkisten', GITHUB_BILLING_SCOPE:extra.MANAGE_GITHUB_BILLING_SCOPE||'users'
};
if(!/^[a-z0-9-]{1,39}$/i.test(vars.GITHUB_BILLING_OWNER)||!['users','organizations'].includes(vars.GITHUB_BILLING_SCOPE)) throw new Error('Invalid billing identity');
const optional: Record<string,string> = {MANAGE_XRELAY_CHAT_ID:'XRELAY_CHAT_ID',MANAGE_GCP_BILLING_TABLE:'GCP_BILLING_TABLE',MANAGE_GITHUB_ACTIONS_INCLUDED_USD:'GITHUB_ACTIONS_INCLUDED_USD',MANAGE_MODAL_BILLING_URL:'MODAL_BILLING_URL',MANAGE_CLOUDBUILD_ALLOWED_TRIGGERS:'GCP_CLOUDBUILD_ALLOWED_TRIGGERS',MANAGE_TERMINAL_GATEWAY_URL:'MANAGE_TERMINAL_GATEWAY_URL',MANAGE_TERMINAL_VMS:'MANAGE_TERMINAL_VMS',MANAGE_SENTRY_DSN:'SENTRY_DSN',SENTRY_ORG:'SENTRY_ORG'};
for(const [key,binding] of Object.entries(optional)) if(extra[key]) vars[binding]=extra[key];
if(vars.GCP_BILLING_TABLE&&!/^[a-z][a-z0-9-]{4,62}\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.gcp_billing_export_(?:resource_)?v1_[A-Za-z0-9_]+$/.test(vars.GCP_BILLING_TABLE)) throw new Error('Invalid billing table');
if(vars.GITHUB_ACTIONS_INCLUDED_USD&&!/^\d{1,7}(?:\.\d{1,2})?$/.test(vars.GITHUB_ACTIONS_INCLUDED_USD)) throw new Error('Invalid billing credit');
if(vars.MODAL_BILLING_URL){const u=new URL(vars.MODAL_BILLING_URL);if(u.protocol!=='https:'||! /^[a-z0-9-]+\.modal\.run$/.test(u.hostname)||u.username||u.password)throw new Error('Invalid Modal URL');}
if(vars.GCP_CLOUDBUILD_ALLOWED_TRIGGERS){const a=vars.GCP_CLOUDBUILD_ALLOWED_TRIGGERS.split(',').map(x=>x.trim()).filter(Boolean);if(a.length>20||a.some(x=>!/^(us-central1|global):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x)))throw new Error('Invalid build triggers');vars.GCP_CLOUDBUILD_ALLOWED_TRIGGERS=[...new Set(a)].join(',');}
const secrets: Record<string,string>={GITHUB_API_TOKEN:github,CLOUDFLARE_API_TOKEN:runtime};
const mapping={MANAGE_GITHUB_WEBHOOK_SECRET:'GITHUB_WEBHOOK_SECRET',MANAGE_GCP_BUILD_RELEASE_URL:'GCP_BUILD_WEBHOOK_RELEASE_URL',MANAGE_GCP_BUILD_PROVISION_URL:'GCP_BUILD_WEBHOOK_PROVISION_URL',MANAGE_GCP_BUILD_CALLBACK_SECRET:'GCP_BUILD_CALLBACK_SECRET',MANAGE_XRELAY_NOTIFICATION_URL:'XRELAY_NOTIFICATION_URL',MANAGE_XRELAY_NOTIFICATION_TOKEN:'XRELAY_NOTIFICATION_TOKEN',MANAGE_MODAL_BILLING_TOKEN:'MODAL_BILLING_TOKEN',MANAGE_SENTRY_API_TOKEN:'SENTRY_API_TOKEN'};
for(const [key,binding] of Object.entries(mapping)) if(refs[key]||process.env[key]) secrets[binding]=secret(key);
if(extra.MANAGE_TERMINAL_GATEWAY_URL||extra.MANAGE_TERMINAL_VMS||refs.MANAGE_TERMINAL_GATEWAY_SECRET||process.env.MANAGE_TERMINAL_GATEWAY_SECRET){if(!extra.MANAGE_TERMINAL_VMS||extra.MANAGE_TERMINAL_GATEWAY_URL!=='https://photointel-ssh.migos.club')throw new Error('Incomplete terminal config');const v=secret('MANAGE_TERMINAL_GATEWAY_SECRET');if(v.length<32)throw new Error('Invalid terminal secret');secrets.MANAGE_TERMINAL_GATEWAY_SECRET=v;}
await publishWorker({cwd,account,token:deploy,config:{name,main:'src/worker.ts',compatibility_date:'2026-11-01',workers_dev:false,preview_urls:false,observability:{enabled:true,logs:{enabled:true,invocation_logs:false}},assets:{directory:'./dist',binding:'ASSETS',run_worker_first:true,not_found_handling:'single-page-application'},routes:[],keep_vars:true,d1_databases:[{binding:'DEPLOY_DB',database_name:name,database_id:db[0].uuid,migrations_dir:'./migrations'}],vars},migrationBinding:'DEPLOY_DB',secrets});
console.log('Manage published: https://'+domain);
