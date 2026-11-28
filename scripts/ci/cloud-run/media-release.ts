const initialSha = 'f6b667c5da7d49ee6d1d059ae8dd4f8159a477cc';
const kinds = ['image','video'] as const;
type Kind = typeof kinds[number];
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid media metadata');
  return value as Json;
}
export function releaseSettings(outputs: Json, requested: string, bucket: string) {
  const current = object(object(outputs.media_release ?? {}).value ?? {});
  const sha = requested || current.source_sha || initialSha;
  const selected = bucket || current.bucket || 'photointel';
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid source SHA');
  if (typeof selected !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(selected)) throw Error('Invalid media bucket');
  return {media_image_sha:sha,media_bucket:selected,media_image_digests:sha===current.source_sha ? object(current.images ?? {}) : {},enable_media_jobs:true};
}
export function adoptionImports(state: string[], jobs: Record<Kind,unknown>, project: string, region: string) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[a-z]+-[a-z]+[0-9]+$/.test(region)) throw Error('Invalid target');
  const imports: {to:string;id:string}[]=[];
  const allowed = new Set(['R2_BUCKET','R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY']);
  for(const kind of kinds) {
    const address='google_cloud_run_v2_job.media["'+kind+'"]';
    const job=jobs[kind];
    if(job===null) {if(state.includes(address)) throw Error('Managed media-'+kind+' disappeared'); continue;}
    const task=object(object(object(object(object(object(job).spec).template).spec).template).spec);
    const containers=task.containers;
    if(!Array.isArray(containers)||containers.length!==1) throw Error('Unsupported container configuration');
    const container=object(containers[0]), env=container.env ?? [];
    if(!Array.isArray(env)||env.some(e=>!allowed.has(String(object(e).name)))) throw Error('Additional container configuration');
    const present=(v:unknown)=>Array.isArray(v)?v.length>0:!!v;
    if(['volumes','vpcAccess','encryptionKey'].some(k=>present(task[k]))||['command','args','volumeMounts'].some(k=>present(container[k]))) throw Error('Custom execution settings');
    if(!state.includes(address)) imports.push({to:address,id:'projects/'+project+'/locations/'+region+'/jobs/photointel-media-'+kind});
  }
  return imports;
}
