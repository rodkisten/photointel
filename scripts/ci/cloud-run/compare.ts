import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const [,,legacy,native]=process.argv;
if(!legacy||!native) throw new Error('Usage: node compare.ts legacy-dir native-dir');
const names=['api','discover','backfill','worker','maintenance','migrate'];
let failed=false;
for(const name of names){
  const file='photointel-'+name+'.json';
  const a=JSON.parse(readFileSync(join(legacy,file),'utf8'));
  const b=JSON.parse(readFileSync(join(native,file),'utf8'));
  const equal=isDeepStrictEqual(a,b);
  console.log(file+': '+(equal?'MATCH':'DIFFERENT'));
  failed ||= !equal;
}
if(failed) process.exitCode=1;
