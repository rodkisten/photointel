import { spawnSync } from 'node:child_process';
import { createRunner } from './runner.ts';
const SHA=/^[a-f0-9]{40}$/;
export type Catalog=Map<string,string>;
export function parseCatalog(raw:string):Catalog {
  const entries:unknown=JSON.parse(raw);
  if(!Array.isArray(entries)) throw new Error('Invalid image inventory');
  const catalog:Catalog=new Map();
  for(const item of entries){
    if(!item||typeof item!=='object'||!Array.isArray(item.tags)) continue;
    const stamp=item.uploadTime??item.updateTime??'';
    const time=typeof stamp==='string'&&Number.isFinite(Date.parse(stamp))?new Date(stamp).toISOString():'';
    for(const tag of item.tags){
      if(typeof tag==='string'&&SHA.test(tag)&&(!catalog.has(tag)||time>catalog.get(tag)!)) catalog.set(tag,time);
    }
  }
  return catalog;
}
export function newestCommon(catalogs:Catalog[]):string {
  if(!catalogs.length) throw new Error('No image catalogs');
  const common=[...catalogs[0].keys()].filter(sha=>catalogs.every(c=>c.has(sha)));
  const age=(sha:string)=>catalogs.map(c=>c.get(sha)!).sort()[0];
  common.sort((a,b)=>age(b).localeCompare(age(a))||b.localeCompare(a));
  if(!common.length) throw new Error('No complete published release');
  return common[0];
}
export function validateSource(root:string,sha:string,head:string):string {
  if(!SHA.test(sha)||!SHA.test(head)) throw new Error('Full source and head SHA required');
  for(const args of [['cat-file','-e',sha+'^{commit}'],['merge-base','--is-ancestor',sha,head]]){
    const result=spawnSync('git',args,{cwd:root,timeout:15000,stdio:'ignore'});
    if(result.error||result.status!==0) throw new Error('Source is not an authorized ancestor');
  }
  return sha;
}
export function loadCatalogs(runner:ReturnType<typeof createRunner>,region:string,repository:string,target:'api'|'media'):Catalog[]{
  if(target!=='api'&&target!=='media') throw new Error('Invalid catalog target');
  const kinds=target==='api'?['api'] as const:['media-image','media-video'] as const;
  return kinds.map(kind=>{
    const result=runner.listImages(region,repository,kind);
    if(!result.executed) throw new Error('Registry inventory was not executed');
    return parseCatalog(result.stdout);
  });
}
