import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, basename } from 'node:path';
export function createReleaseManifest(root:string, sha:string) {
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:60000}).trim();
  if(!/^[a-f0-9]{40}$/.test(sha)||git('rev-parse','HEAD')!==sha||git('status','--porcelain')) throw new Error('Release requires clean matching HEAD');
  const hash=createHash('sha256');
  for(const name of git('ls-files','-z','infra').split('\0').filter(Boolean).sort()){
    if(basename(name).includes('.env')) continue;
    const path=resolve(root,name);
    if(!statSync(path).isFile()) continue;
    hash.update(name).update('\0').update(readFileSync(path));
  }
  const revisions=new Set<string>(),parents=new Set<string>();
  const directory=resolve(root,'infra/migrations/versions');
  for(const name of readdirSync(directory).filter(n=>n.endsWith('.py'))){
    const source=readFileSync(resolve(directory,name),'utf8');
    for(const field of ['revision','down_revision']){
      const match=source.match(new RegExp('^'+field+'\\s*=\\s*(?:(["\x27])([^"\x27]+)\\1|None)\\s*(?:#.*)?$','m'));
      if(!match) throw new Error('Unsupported migration metadata: '+name);
      if(match[2]) (field==='revision'?revisions:parents).add(match[2]);
    }
  }
  const heads=[...revisions].filter(x=>!parents.has(x));
  if(heads.length!==1) throw new Error('Expected one migration head');
  const project=readFileSync(resolve(root,'pyproject.toml'),'utf8').match(/^\[project\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  const version=project?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if(!version) throw new Error('Missing static API version');
  const pins=JSON.parse(readFileSync(resolve(root,'packages/configuration/model-pins.json'),'utf8'));
  const models=Object.fromEntries(['joytag','siglip2'].map(key=>{
    const pin=pins[key];
    if(typeof pin?.model_id!=='string'||typeof pin?.revision!=='string') throw new Error('Invalid model pin');
    return [key,{model_id:pin.model_id,revision:pin.revision}];
  }));
  return {manifest_version:1,git_sha:sha,branch:git('branch','--show-current')||null,build_timestamp:new Date().toISOString(),container_digest:null,frontend_release_id:sha,api_version:version,database_migration_head:heads[0],models,modal_deployment_id:null,infrastructure_hash:hash.digest('hex'),ci_run_ids:[],test_results:[],provenance_status:'identified',validation_status:'unverified'};
}
export function withReleaseManifest<T>(root:string,sha:string,operation:()=>T):T {
  const path=resolve(root,'release-manifest.json');
  const manifest=createReleaseManifest(root,sha);
  writeFileSync(path,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  try {return operation();} finally {unlinkSync(path);}
}
