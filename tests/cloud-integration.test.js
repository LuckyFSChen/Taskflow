import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {processLine} from '../server/line.js';
import worker,{computeLineSignature} from '../cloud-inbox/worker.js';

test('Signed cloud webhook → durable SQLite → Windows inbox → replay → ack, without duplicate tasks',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'taskflow-cloud-integration-'));const cloud=new DatabaseSync(join(dir,'cloud.sqlite'));cloud.exec(readFileSync(new URL('../cloud-inbox/migrations/0001_init.sql',import.meta.url),'utf8'));
  const local=createStore(join(dir,'local.sqlite'));t.after(()=>{cloud.close();local.close();rmSync(dir,{force:true,recursive:true});});
  const user=local.addUser('Member','member','password-member-123'),pid=id(),source=join(dir,'source');mkdirSync(source);local.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);local.db.prepare('INSERT INTO memberships VALUES (?,?)').run(user.id,pid);const lineId='U'+'a'.repeat(32);local.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,user.id);
  function prepare(sql){let args=[];return {bind(...values){args=values;return this;},run(){return cloud.prepare(sql).run(...args);},all(){return {results:cloud.prepare(sql).all(...args)};}};}
  const env={DB:{prepare,batch(statements){cloud.exec('BEGIN');try{const result=statements.map(s=>s.run());cloud.exec('COMMIT');return result;}catch(e){cloud.exec('ROLLBACK');throw e;}}},LINE_CHANNEL_SECRET:'fixture-only-secret',INBOX_TOKEN:'fixture-runner-token'};
  const event={webhookEventId:'durable-event-1',type:'message',source:{type:'user',userId:lineId},message:{type:'text',text:'/task demo Durable task\nCreate a test document.'}},payload=JSON.stringify({events:[event]}),signature=await computeLineSignature(env.LINE_CHANNEL_SECRET,new TextEncoder().encode(payload));
  const post=(path,body,headers={})=>worker.fetch(new Request('https://fixture.invalid'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}),env);
  assert.equal((await post('/line/webhook',payload,{'x-line-signature':'wrong'})).status,401);
  assert.equal((await post('/line/webhook',payload,{'x-line-signature':signature})).status,200);
  assert.equal((await post('/line/webhook',payload,{'x-line-signature':signature})).status,200);
  const headers={authorization:'Bearer '+env.INBOX_TOKEN};let pulled=await (await post('/runner/pull',{},headers)).json();assert.equal(pulled.events.length,1);processLine(local,pulled.events[0]);
  // Simulate local commit succeeded but ack response was never sent.
  pulled=await (await post('/runner/pull',{},headers)).json();processLine(local,pulled.events[0]);assert.equal(local.tasks().length,1);assert.equal(local.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
  assert.equal((await post('/runner/ack',{id:event.webhookEventId},headers)).status,200);pulled=await (await post('/runner/pull',{},headers)).json();assert.equal(pulled.events.length,0);
});
