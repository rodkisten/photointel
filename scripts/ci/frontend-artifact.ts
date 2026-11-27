import { createHash } from 'node:crypto';
import { readdirSync,readFileSync,writeFileSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
const [,,action,app]=process.argv;
if(app!=='web'&&app!=='manage')throw Error('Invalid app');
const sha=process.env.PHOTOINTEL_BUILD_SHA;
if(!sha||! /^[a-f0-9]{40}$/.test(sha))throw Error('Invalid source SHA');
const root='apps/'+app+'/dist',name='.rodverse-artifact.json';
const publicKeys=app==='web'?['VITE_API_BASE_URL','VITE_RELEASE_ID','VITE_SENTRY_DSN','VITE_SENTRY_ORG','SENTRY_ORG','SENTRY_PROJECT']:['VITE_MANAGE_SENTRY_DSN','VITE_MANAGE_SENTRY_ORG','VITE_MANAGE_RELEASE'];
const hash=createHash('sha256');
function walk(dir:string,prefix=''){
  for(const entry of readdirSync(dir).sort()){
    const relative=prefix+entry,path=join(dir,entry);
    if(relative===name)continue;
    const stat=lstatSync(path);
    if(stat.isDirectory())walk(path,relative+'/');
    else if(stat.isFile()){const bytes=readFileSync(path);hash.update(JSON.stringify([relative,bytes.length])).update('\0').update(bytes);}
    else throw Error('Unsupported artifact entry');
  }
}
walk(root);
const expected={version:1,app,sha,workflowSha:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,configFingerprint:createHash('sha256').update(JSON.stringify(publicKeys.map(k=>[k,process.env[k]??'']))).digest('hex'),contentDigest:hash.digest('hex')};
const path=join(root,name);
if(action==='seal')writeFileSync(path,JSON.stringify(expected)+'\n',{flag:'wx'});
else if(action==='verify'){
  const actual=JSON.parse(readFileSync(path,'utf8'));
  for(const key of Object.keys(expected) as (keyof typeof expected)[])if(actual[key]!==expected[key])throw Error('Artifact mismatch: '+key);
  console.log('Artifact provenance verified');
}else throw Error('Invalid artifact action');
