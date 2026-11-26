import {readFileSync,appendFileSync} from 'node:fs';
const c=JSON.parse(readFileSync('infra/gcp/config.local.json','utf8'));
if(c.project_id!==process.env.CONFIRM_PROJECT)throw new Error('Project mismatch');
const u=new URL(c.frontend_origin);
const w=c.workflows?.worker??{};
if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||(w.name??'photointel')!=='photointel'||(w.domain??u.hostname)!==u.hostname)throw new Error('Invalid Photos origin');
const sha=process.env.PHOTOINTEL_BUILD_SHA||process.env.GITHUB_SHA||'';
if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Invalid source SHA');
const e=c.extra_environment??{};
const values={VITE_API_BASE_URL:'',VITE_RELEASE_ID:sha,VITE_SENTRY_DSN:e.VITE_SENTRY_DSN??'',VITE_SENTRY_ORG:e.SENTRY_ORG??'',SENTRY_ORG:e.SENTRY_ORG??'',SENTRY_PROJECT:e.SENTRY_PROJECT??''};
if(c.workflow_secrets?.SENTRY_AUTH_TOKEN&&(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.SENTRY_ORG)||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(values.SENTRY_PROJECT)))throw new Error('Missing Sentry project configuration');
const output=process.env.GITHUB_ENV;if(!output)throw new Error('Missing GITHUB_ENV');
for(const [k,v] of Object.entries(values)){if(typeof v!=='string'||/[\r\n\0]/.test(v))throw new Error('Invalid public variable '+k);appendFileSync(output,k+'='+v+'\n');}
