import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cliAdapter} from '../server/runner.js';
import {planJson} from '../server/domain.js';
test('Planning prompt includes full output contract and structured failure preserves session without inventing fields',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'tf-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=prompt=>{assert.ok(prompt.includes(JSON.stringify(planJson)));setImmediate(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',session_id:'fixture-session',is_error:true,errors:['Failed to provide valid structured output: acceptance missing']})+'\n'));child.emit('close',1);});};return child;};
 await assert.rejects(cliAdapter({engine:'claude',prompt:'Plan',cwd:dir,runDir:dir,schema:planJson,readOnly:true,onEvent:()=>{},spawnProcess}),e=>{assert.equal(e.sessionId,'fixture-session');assert.match(e.message,/不必重新填寫/);return true;});
});
