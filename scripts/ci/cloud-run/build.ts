import { withReleaseManifest } from './manifest.ts';
import { createRunner } from './runner.ts';
export function verifiedDockerDigest(listing:string, sha:string):string {
  if(!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release SHA');
  let images:unknown;
  try { images=JSON.parse(listing); } catch { throw new Error('Invalid registry response'); }
  if(!Array.isArray(images)) throw new Error('Expected registry image array');
  const matches:string[]=[];
  for(const entry of images){
    if(!entry||typeof entry!=='object'||!Array.isArray(entry.tags)||!entry.tags.includes(sha)) continue;
    if(typeof entry.version!=='string'||!/^sha256:[a-f0-9]{64}$/.test(entry.version)) throw new Error('Invalid release digest');
    matches.push(entry.version);
  }
  if(matches.length!==1) throw new Error('Expected exactly one release image; found '+matches.length);
  return matches[0];
}
export function resolveReleaseImage(runner:ReturnType<typeof createRunner>, project:string, region:string, repository:string, sha:string){
  if(!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release SHA');
  const result=runner.listImages(region,repository);
  if(!result.executed) return {executed:false as const};
  const digest=verifiedDockerDigest(result.stdout,sha);
  return {executed:true as const,digest,image:region+'-docker.pkg.dev/'+project+'/'+repository+'/api@'+digest};
}

export function submitAndVerifyRelease(runner:ReturnType<typeof createRunner>,project:string,region:string,repository:string,sha:string){
  const submission=runner.submitApiBuild(region,repository,sha);
  if(!submission.executed) return {executed:false as const};
  return resolveReleaseImage(runner,project,region,repository,sha);
}

export function buildRelease(root:string,project:string,region:string,repository:string,sha:string,apply=false,authorizeCharges=false,confirmProject?:string){
  const runner=createRunner({project,cwd:root,apply,authorizeCharges,confirmProject});
  const operation=()=>submitAndVerifyRelease(runner,project,region,repository,sha);
  return apply?withReleaseManifest(root,sha,operation):operation();
}

export function buildMediaRelease(root:string,project:string,region:string,repository:string,sha:string,apply=false,authorizeCharges=false,confirmProject?:string){
  const runner=createRunner({project,cwd:root,apply,authorizeCharges,confirmProject});
  const submission=runner.submitMediaBuild(region,repository,sha);
  if(!submission.executed) return {executed:false as const};
  const images=['media-image','media-video'] as const;
  return {executed:true as const,images:images.map(kind=>{
    const result=runner.listImages(region,repository,kind);
    if(!result.executed) throw new Error('Registry verification unavailable');
    const digest=verifiedDockerDigest(result.stdout,sha);
    return {kind,digest,image:region+'-docker.pkg.dev/'+project+'/'+repository+'/'+kind+'@'+digest};
  })};
}
