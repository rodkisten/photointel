import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export interface WorkerPublication {
  cwd: string;
  account: string;
  token: string;
  config: Record<string, unknown>;
  migrationBinding?: string;
  secrets?: Record<string,string>;
}
export async function publishWorker(options: WorkerPublication): Promise<void> {
  const {cwd,account,token,config,migrationBinding,secrets={}}=options;
  if(!/^[a-f0-9]{32}$/i.test(account)||!token||/[\r\n\0]/.test(token)) throw new Error('Invalid Cloudflare credentials');
  const name=config.name;
  if(typeof name!=='string'||! /^[a-z0-9-]{1,63}$/.test(name))throw new Error('Invalid Worker name');
  const tag='release-'+(process.env.GITHUB_RUN_ID||'local')+'-'+(process.env.GITHUB_RUN_ATTEMPT||'1');
  if(!/^[a-z0-9-]{1,63}$/i.test(tag))throw new Error('Invalid release tag');
  for(const [key,value] of Object.entries(secrets))if(!/^[A-Z][A-Z0-9_]*$/.test(key)||!value||/[\r\n\0]/.test(value))throw new Error('Invalid runtime binding: '+key);
  // Keep config beside Worker entrypoint so relative asset paths remain valid.
  const dir=mkdtempSync(resolve(cwd,'.worker-release-'));
  const file=dir+'.json';
  const env={PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token};
  function run(args:string[],input?:string){
    const p=spawnSync('npx',['--yes','wrangler@4',...args],{cwd,env,input,encoding:'utf8',timeout:300000});
    if(p.status!==0)throw new Error('Wrangler operation failed: '+args.slice(0,2).join(' '));
  }
  try {
    writeFileSync(file,JSON.stringify(config),{mode:0o600,flag:'wx'});
    if(migrationBinding)run(['d1','migrations','apply',migrationBinding,'--remote','--config',file]);
    run(['versions','upload','--config',file,'--tag',tag,'--keep-vars']);
    run(['versions','deploy','--config',file,'--version-tag',tag,'--yes']);
    for(const [key,value] of Object.entries(secrets))run(['secret','put',key,'--name',name,'--config',file],value+'\n');
    console.log('Published Worker '+name+'; Terraform-owned triggers preserved');
  }finally{rmSync(file,{force:true});rmSync(dir,{recursive:true,force:true});}
}
