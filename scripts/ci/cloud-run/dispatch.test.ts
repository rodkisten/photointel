import assert from 'node:assert/strict';
import { matchingRun,verifyJobs,dispatchFrontend } from './dispatch.ts';
const run={id:1,display_title:'test',status:'completed',conclusion:'success'};
assert.equal(matchingRun([run],'test')?.id,1);
assert.throws(()=>matchingRun([run,run],'test'));
assert.throws(()=>verifyJobs([{name:'deploy / 🚀 Publish · web',conclusion:'skipped'}],'web','build-and-deploy'));
verifyJobs([{name:'deploy / 🚀 Publish · web',conclusion:'success'}],'web','build-and-deploy');
await assert.rejects(dispatchFrontend('web','bad','build'));
