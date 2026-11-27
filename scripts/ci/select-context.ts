import { affectedApps, changedFiles } from './affected.ts';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const keys=['python','integration','containers','security','py_api','py_manage','py_gpu','py_bridges','front_web','front_manage'] as const;
type Key=typeof keys[number];
export function select(files:string[],scope='auto'){
  const flags=Object.fromEntries(keys.map(k=>[k,false])) as Record<Key,boolean>;
  const set=(...names:Key[])=>names.forEach(k=>flags[k]=true);
  const py=['py_api','py_manage','py_gpu','py_bridges'] as const;
  if(scope==='all')set(...keys);
  else if(scope==='python')set('python',...py);
  else if(scope==='frontend')set('front_web','front_manage');
  else if(scope==='frontend-web')set('front_web');
  else if(scope==='frontend-manage')set('front_manage');
  else if(scope==='integration'||scope==='containers'||scope==='security')set(scope);
  else if(scope!=='auto')throw new Error('Invalid scope');
  else for(const f of files){
    const starts=(...prefix:string[])=>prefix.some(p=>f.startsWith(p));
    if(f==='*'||starts('scripts/ci/','.github/actions/','.github/workflows/ci.yml')||['Makefile','.env.example','rodverse.config.ts'].includes(f)){set(...keys);break;}
    if(starts('apps/api/','tests/api/'))set('py_api');
    if(starts('apps/manage/','tests/manage/'))set('py_manage');
    if(starts('gpu/','tests/gpu/'))set('py_gpu');
    if(starts('bridges/','tests/bridges/'))set('py_bridges');
    if(starts('packages/python/','tests/')||['pyproject.toml','uv.lock'].includes(f))set(...py);
    if(starts('apps/web/','packages/ui/','packages/shared/','packages/frontend/','packages/contracts/','packages/env/'))set('front_web');
    if(starts('apps/manage/','packages/ui/','packages/shared/','packages/frontend/','packages/contracts/','packages/env/'))set('front_manage');
    if(starts('infra/migrations/','infra/scripts/','tests/integration/','apps/api/','infra/docker/minio.'))set('integration');
    if(starts('infra/docker/','apps/api/','apps/web/')||f==='cloudbuild.yaml')set('containers');
    if(starts('apps/','gpu/','bridges/','packages/','infra/','scripts/','.github/')||['pyproject.toml','uv.lock'].includes(f))set('security');
  }
  if(scope==='auto') for(const app of affectedApps(files)) set(app==='web'?'front_web':'front_manage');
  if(py.some(k=>flags[k]))set('python');
  return {...flags,frontend_matrix:[...(flags.front_web?['web']:[]),...(flags.front_manage?['manage']:[])]};
}
function main(){
  const scope=process.env.SCOPE||'auto',base=process.env.BASE_SHA||'',head=process.env.HEAD_SHA||'';
  let files:string[]=[];
  if(scope==='auto'){
    files=changedFiles(base,head,process.env.EVENT_NAME==='pull_request');
  }
  const result=select(files,scope);
  if(!process.env.GITHUB_OUTPUT)throw Error('Missing GITHUB_OUTPUT');
  appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(result).map(([k,v])=>k+'='+JSON.stringify(v)+'\n').join(''));
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,'### CI plan\n\n'+Object.entries(result).map(([k,v])=>'- '+k+': '+JSON.stringify(v)).join('\n')+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
