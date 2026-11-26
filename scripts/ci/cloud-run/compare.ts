import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const [,,legacy,native]=process.argv;
if(!legacy||!native) throw new Error('Usage: node compare.ts legacy-dir native-dir');
const names=['api','discover','backfill','worker','maintenance','migrate'];
function differences(a:unknown,b:unknown,path='$'):string[]{
  if(isDeepStrictEqual(a,b)) return [];
  if(Array.isArray(a)&&Array.isArray(b)){
    if(a.length!==b.length) return [path+'.length'];
    return a.flatMap((v,i)=>differences(v,b[i],path+'['+i+']'));
  }
  if(a!==null&&b!==null&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
    const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
    return [...new Set([...Object.keys(left),...Object.keys(right)])].sort().flatMap(key=>{
      // Never emit dynamic object keys or values: they may contain sensitive data.
      const safe=/^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(key)?key:'[redacted-key]';
      return differences(left[key],right[key],path+'.'+safe);
    });
  }
  return [path];
}
let failed=false;
for(const name of names){
  const file='photointel-'+name+'.json';
  const a=JSON.parse(readFileSync(join(legacy,file),'utf8'));
  const b=JSON.parse(readFileSync(join(native,file),'utf8'));
  const diff=differences(a,b);
  console.log(file+': '+(diff.length?'DIFFERENT ('+diff.length+' paths)':'MATCH'));
  for(const path of diff.slice(0,30)) console.log('  '+path);
  failed ||= diff.length>0;
}
if(failed) process.exitCode=1;
