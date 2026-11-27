import { ghApi } from './dispatch.ts';
import { createRunner } from './runner.ts';
import { parseCatalog } from './catalog.ts';
if(process.env.GITHUB_REPOSITORY!=='rodverse/rodverse'||process.env.GITHUB_REF!=='refs/heads/main') throw new Error('Main-only verification');
const target=process.env.TARGET;
if(!target||!['api','media','web','manage'].includes(target)) throw new Error('Invalid target');
const repo='repos/rodverse/rodverse';
const workflow=ghApi(repo+'/actions/workflows/'+(target==='web'||target==='manage'?'frontend-release.yml':'tf-production.yml')) as {state?:string};
if(workflow.state!=='active') throw new Error('Required workflow is not active');
if(target==='api'||target==='media'){
  const runner=createRunner({project:'photointel',readOnly:true});
  const kinds=target==='api'?['api'] as const:['media-image','media-video','media-imagor'] as const;
  for(const kind of kinds){
    const result=runner.listImages('us-central1','photointel',kind);
    console.log(JSON.stringify({kind,releases:parseCatalog(result.stdout).size}));
  }
}
console.log(JSON.stringify({target,workflow:'active',mode:'read-only'}));
