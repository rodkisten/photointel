import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { adoptionImports, releaseSettings } from './media-release.ts';
type Json = Record<string,unknown>;
export type Inventory = {outputs:Json;state:string[];jobs:Record<'image'|'video',unknown>};
export function prepare(inventory:Inventory,sha:string,bucket:string,validate:(sha:string)=>void) {
  const settings=releaseSettings(inventory.outputs,sha,bucket);
  validate(settings.media_image_sha);
  return {settings,imports:{import:adoptionImports(inventory.state,inventory.jobs,'photointel','us-central1')}};
}
function read(command:string,args:string[],cwd:string) {
  try {return execFileSync(command,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}
  catch {throw Error(command+' metadata read failed; refusing to assume empty state');}
}
export function main(args:string[]) {
  const {values}=parseArgs({args,options:{'image-sha':{type:'string',default:''},bucket:{type:'string',default:''},'write-local':{type:'boolean',default:false}},strict:true});
  const root=resolve('infra/terraform/environments/production');
  const outputs=JSON.parse(read('terraform',['output','-json'],root));
  const state=read('terraform',['state','list'],root).split(/\r?\n/).filter(Boolean);
  // A successful list is required before absence can be inferred.
  const listed:unknown=JSON.parse(read('gcloud',['run','jobs','list','--project=photointel','--region=us-central1','--format=json','--quiet'],root));
  if(!Array.isArray(listed)||listed.some(j=>typeof j?.metadata?.name!=='string')) throw Error('Invalid Job inventory');
  function describe(kind:'image'|'video') {
    const name='photointel-media-'+kind;
    if(!listed.some(j=>j.metadata.name===name)) return null;
    return JSON.parse(read('gcloud',['run','jobs','describe',name,'--project=photointel','--region=us-central1','--format=json','--quiet'],root));
  }
  const result=prepare({outputs,state,jobs:{image:describe('image'),video:describe('video')}},values['image-sha'],values.bucket,sha=>{
    read('git',['cat-file','-e',sha+'^{commit}'],root);
    read('git',['merge-base','--is-ancestor',sha,'HEAD'],root);
  });
  if(values['write-local']) {
    const files=[['media-release.auto.tfvars.json',result.settings],['media-imports.auto.tf.json',result.imports]] as const;
    if(files.some(([name])=>existsSync(resolve(root,name)))) throw Error('Refusing to overwrite existing generated Terraform files');
    for(const [name,data] of files) writeFileSync(resolve(root,name),JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
  }
  console.log('Media source: '+result.settings.media_image_sha+'; existing Jobs to import: '+result.imports.import.length+'; local files: '+values['write-local']);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
