import assert from 'node:assert/strict';
import { verifiedDockerDigest } from './build.ts';
const sha='a'.repeat(40), digest='sha256:'+'b'.repeat(64);
const entry={tags:[sha],version:digest};
assert.equal(verifiedDockerDigest(JSON.stringify([entry]),sha),digest);
for(const input of ['{}','bad','[]',JSON.stringify([entry,entry]),JSON.stringify([{...entry,version:'latest'}])]) assert.throws(()=>verifiedDockerDigest(input,sha));
assert.throws(()=>verifiedDockerDigest(JSON.stringify([entry]),'main'));
console.log('Registry digest contract passed');
