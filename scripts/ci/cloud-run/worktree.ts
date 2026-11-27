import { spawnSync } from 'node:child_process';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSource } from './catalog.ts';
function run(command:string,args:string[],cwd:string,timeout=600000){
  const result=spawnSync(command,args,{cwd,timeout,stdio:'inherit',shell:false});
  if(result.error||result.status!==0) throw new Error(command+' failed');
}
export function withSource<T>(root:string,sha:string,head:string,operation:(source:string)=>T):T{
  validateSource(root,sha,head);
  const temp=mkdtempSync(join(tmpdir(),'rodverse-source-')),source=join(temp,'source');
  let added=false;
  try{
    run('git',['worktree','add','--detach',source,sha],root);
    added=true;
    return operation(source);
  }finally{
    if(added) run('git',['worktree','remove','--force',source],root);
    rmSync(temp,{recursive:true,force:true});
  }
}
export function mediaPreflight(source:string){
  for(const kind of ['image','video']){
    const cwd=join(source,'services/media',kind);
    if(!existsSync(join(cwd,'package-lock.json'))) throw new Error('Media requires committed lockfile: '+kind);
    run('npm',['ci','--no-audit','--no-fund'],cwd);
    run('npm',['run','build'],cwd);
    run('npm',['test'],cwd);
  }
}
