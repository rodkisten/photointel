import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseEnv, parseArgs, TextDecoder } from 'node:util';
import { normalizeDeployConfig } from './deploy.ts';
import { parseEnvironment } from './index.ts';

type Binding = { key: string; name: string; version: string };
function bindings(input: unknown): Binding[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') throw new Error('Invalid secret inventory');
  return Object.entries(input).map(([key, ref]) => ({key, ...(ref as Omit<Binding,'key'>)}));
}
export function renderDotenv(values: Record<string,string>): string {
  return Object.entries(values).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0') || value.includes('\r')) throw new Error('Unsupported dotenv binding: ' + key);
    const quote = ['"', "'", '`'].find(q => !value.includes(q));
    if (!quote) throw new Error('Cannot safely quote binding: ' + key);
    const line = key + '=' + quote + value + quote;
    if (parseEnv(line)[key] !== value) throw new Error('Dotenv round-trip failed: ' + key);
    return line;
  }).join('\n') + '\n';
}
export function resolveLocal(raw: string, read: (name:string,version:string)=>string, all=false): Record<string,string> {
  const config = normalizeDeployConfig(raw);
  const values: Record<string,string> = Object.assign(Object.create(null), config.runtime);
  const seen = new Map<string,string>();
  const refs = [...bindings(config.secrets), ...(all ? bindings(config.workflowSecrets) : [])];
  if (all) for (const [key,value] of Object.entries(config.cloudflare)) {
    if (Object.hasOwn(values,key) && values[key] !== value) throw new Error('Conflicting binding: ' + key);
    values[key]=value;
  }
  for (const {key,name,version} of refs) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !/^[a-zA-Z0-9_-]+$/.test(name) || !/^(latest|[1-9][0-9]*)$/.test(version)) throw new Error('Invalid secret reference');
    const id=name+'@'+version;
    if (seen.has(key) && seen.get(key)!==id) throw new Error('Conflicting secret: '+key);
    seen.set(key,id);
    values[key]=read(name,version);
  }
  return values;
}
function run() {
  const {values: args} = parseArgs({options: {repo:{type:'string',default:'rodverse/rodverse'},environment:{type:'string',default:'Production'},project:{type:'string',default:'photointel'},output:{type:'string',default:'.env.resolved'},all:{type:'boolean',default:false}}});
  const call=(bin:string,argv:string[])=>execFileSync(bin,argv,{stdio:['ignore','pipe','ignore'],maxBuffer:4*1024*1024});
  let raw:string;
  try {raw=call('gh',['api', 'repos/'+args.repo+'/environments/'+encodeURIComponent(args.environment!)+'/variables/GCP_CONFIG_ENV','--jq','.value']).toString('utf8');}
  catch {throw new Error('Unable to read GitHub configuration');}
  const obj=raw.trimStart().startsWith('{') ? JSON.parse(raw) : parseEnvironment(raw).entries;
  const project=obj.project_id ?? obj.PROJECT_ID;
  if (project!==args.project) throw new Error('Configuration project mismatch');
  const cache=new Map<string,string>();
  const result=resolveLocal(raw,(name,version)=>{
    const id=name+'@'+version;
    if (!cache.has(id)) {
      try {
        const encoded=call('gcloud',['secrets','versions','access',version,'--secret='+name,'--project='+args.project,'--format=get(payload.data)','--quiet']).toString('ascii').trim();
        if (!/^[A-Za-z0-9_+/=-]*$/.test(encoded)) throw new Error('Invalid payload');
        cache.set(id,new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(encoded,'base64')));
      } catch {throw new Error('Unable to resolve secret '+name+'@'+version);}
    }
    return cache.get(id)!;
  },args.all);
  const content=renderDotenv(result);
  writeFileSync(args.output!,content,{mode:0o600,flag:'wx'});
  console.log('Wrote '+Object.keys(result).length+' bindings to '+args.output);
}
if (import.meta.main) {
  try {run();} catch {console.error('ENV pull failed. Check configuration, IAM, dotenv compatibility and whether output already exists. No remote changes made.');process.exitCode=1;}
}
