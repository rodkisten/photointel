import assert from 'node:assert/strict';
import { prepare } from './media-prepare.ts';
const sha='a'.repeat(40);
const inventory={outputs:{media_release:{value:{source_sha:sha,bucket:'photointel'}}},state:[],jobs:{image:null,video:null}};
let validated='';
assert.deepEqual(prepare(inventory,'','',s=>{validated=s;}).imports,{import:[]});
assert.equal(validated,sha);
assert.throws(()=>prepare(inventory,'','',()=>{throw Error('unrelated commit');}));
assert.throws(()=>prepare({...inventory,state:['google_cloud_run_v2_job.media["image"]']},'','',()=>{}));
