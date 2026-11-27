import { validateSource,newestCommon,type Catalog } from './catalog.ts';
import { dispatchFrontend } from './dispatch.ts';
import { dispatchTerraform } from './terraform.ts';
import { buildRelease,buildMediaRelease } from './build.ts';
import { withSource,mediaPreflight } from './worktree.ts';
import { createRunner } from './runner.ts';
import { verifiedDockerDigest } from './build.ts';
export type Selection={action:'plan'|'build'|'deploy'|'build-and-deploy';target:'api'|'media'|'web'|'manage';source:'main'|'last';head:string;requested?:string};
export function selectRelease(s:Selection,catalogs:Catalog[]=[],published?:string){
  if(!['plan','build','deploy','build-and-deploy'].includes(s.action)||!['api','media','web','manage'].includes(s.target)||!['main','last'].includes(s.source)) throw new Error('Invalid release selection');
  const sha=s.requested??(s.source==='main'?s.head: s.target==='api'||s.target==='media'?newestCommon(catalogs):published);
  if(!sha||!/^[a-f0-9]{40}$/.test(sha)||!/^[a-f0-9]{40}$/.test(s.head)) throw new Error('Full release SHA required');
  return {sha,build:s.action==='build'||s.action==='build-and-deploy',deploy:s.action==='deploy'||s.action==='build-and-deploy'};
}
// Explicitly invoked by a future authenticated workflow; no side effects on import.
export async function executeRelease(root:string,s:Selection,catalogs:Catalog[]=[],published?:string){
  const plan=selectRelease(s,catalogs,published);
  validateSource(root,plan.sha,s.head);
  if(s.action==='plan') return plan;
  if(process.env.GITHUB_REPOSITORY!=='rodverse/rodverse'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_SHA!==s.head||process.env.CONFIRM!=='true') throw new Error('Confirmed main release required');
  // Historical builds require an isolated source worktree and trusted tooling.
  if(plan.sha!==s.head) throw new Error('Historical execution is not enabled in native console');
  if(s.target==='web'||s.target==='manage'){
    if(s.action==='deploy') throw new Error('Frontend deploy-only is not supported by the native workflow');
    await dispatchFrontend(s.target,plan.sha,plan.deploy?'build-and-deploy':'build');
    return plan;
  }
  if(plan.build) withSource(root,plan.sha,s.head,source=>{
    if(s.target==='media'){
      mediaPreflight(source);
      buildMediaRelease(source,'photointel','us-central1','photointel',plan.sha,true,true,'photointel');
    }else buildRelease(source,'photointel','us-central1','photointel',plan.sha,true,true,'photointel');
  });
  if(plan.deploy){
    const runner=createRunner({project:'photointel',apply:true,authorizeCharges:true,confirmProject:'photointel',cwd:root});
    const kinds=s.target==='api'?['api'] as const:['media-image','media-video'] as const;
    for(const kind of kinds) verifiedDockerDigest(runner.listImages('us-central1','photointel',kind).stdout,plan.sha);
    await dispatchTerraform(root,{action:'apply',scope:'gcp',head:s.head,...(s.target==='api'?{apiSha:plan.sha}:{mediaSha:plan.sha})});
  }
  return plan;
}
