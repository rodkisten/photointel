import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {resolveLocal,renderDotenv} from '../src/pull.ts';
test('runtime references and exact versions',()=>{
 const raw='ENV__MODE=prod\nSECRET__TOKEN=secret://photointel-token@3\nWORKFLOW_SECRET__CI=secret://photointel-ci@latest';
 const calls:string[]=[];
 const values=resolveLocal(raw,(n,v)=>{calls.push(n+'@'+v);return 'a # b';});
 assert.deepEqual(calls,['photointel-token@3']);
 assert.deepEqual(parseEnv(renderDotenv(values)),{MODE:'prod',TOKEN:'a # b'});
});
test('multiline and literal dollar',()=>{
 const values={KEY:'first\nsecond',TOKEN:'${LITERAL}'};
 assert.deepEqual(parseEnv(renderDotenv(values)),values);
});
test('structured config and all scopes',()=>{
 const raw=JSON.stringify({extra_environment:{MODE:'prod'},secrets:{TOKEN:{name:'token',version:'2'}},workflow_secrets:{CI:{name:'ci',version:'latest'}}});
 assert.equal(resolveLocal(raw,(n,v)=>n+v,true).CI,'cilatest');
});
