import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,id} from '../server/db.js';
import {createTask,approveTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {changeTaskStatus} from '../server/task-status.js';
import {parseClaudeReset,parseEngineLimit} from '../server/limit-retry.js';
const limit='claude 執行失敗（1）："You\'ve hit your session limit · resets 3:50pm (Asia/Taipei)"';
const before=Date.parse('2026-09-16T07:40:00Z'),due=Date.parse('2026-09-16T07:50:30Z');
const plan={summary:'Plan',acceptance:['Delivered'],questions:[],steps:[{title:'Make file',role:'Author',instructions:'Write file'}]},good={summary:'Done',questions:[],artifacts:[],passed:true,evidence:['checked']};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'tf-limit-')),dbFile=join(root,'db.sqlite'),s=createStore(dbFile),source=join(root,'source');mkdirSync(source);const u=s.addUser('Owner','owner','test-password'),pid=id();s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);s.setSetting('runnerEnabled',true);let time=before;const runners=[];t.after(()=>{for(const r of runners)r.stop();s.close();rmSync(root,{recursive:true,force:true});});return {s,u,root,dbFile,setTime:value=>time=value,create:(extra={})=>createTask(s,u,{title:'Task test',description:'Test quota recovery',projectId:pid,type:'code',planner:'claude',executor:'codex',reviewer:'claude',...extra}),runner:(adapter,store=s)=>{const r=createRunner(store,{adapter,dataDir:join(root,'data'),clock:()=>time});runners.push(r);return r;}};}
test('Reset parser honors timezone, AM/PM, midnight and rejects ambiguous errors',()=>{
 assert.equal(parseClaudeReset(limit,before).retryAt,'2026-09-16T07:50:30.000Z');
 assert.equal(parseClaudeReset('session limit · resets 12am (Asia/Taipei)',Date.parse('2026-09-16T15:59:00Z')).resetAt,'2026-09-16T16:00:00.000Z');
 assert.equal(parseClaudeReset('session limit · resets 12pm (America/New_York)',Date.parse('2026-09-16T14:00:00Z')).resetAt,'2026-09-16T16:00:00.000Z');
 assert.equal(parseClaudeReset(limit,Date.parse('2026-09-16T08:00:00Z')).resetAt,'2026-09-17T07:50:00.000Z');
 for(const text of ['Quota exhausted','session limit resets soon','session limit resets 15:90 (Asia/Taipei)','session limit resets 3pm (Bad/Zone)','unrelated error resets 3pm (Asia/Taipei)'])assert.equal(parseClaudeReset(text,before),null);
});
test('Session limit releases slot, persists restart, retries only when due, and retains approval gate',async t=>{
 const f=fixture(t);f.s.setSetting('engineAutoFallback',false);let calls=0;const task=f.create(),r=f.runner(async()=>{calls++;throw new Error(limit);});await r.tick();assert.equal(calls,1);assert.equal(r.status.activeCount,0);assert.equal(f.s.task(task.id).status,'rate_limited');assert.equal(f.s.threads(task.id)[0].status,'rate_limited');await r.tick();assert.equal(calls,1);r.stop();
 const reopened=createStore(f.dbFile);const next=f.runner(async()=>{calls++;return {result:plan};},reopened);f.setTime(due-1);await next.tick();assert.equal(calls,1);f.setTime(due);await next.tick();assert.equal(calls,2);assert.equal(reopened.task(task.id).status,'awaiting_approval');assert.equal(reopened.task(task.id).approvedVersion,null);await next.tick();assert.equal(calls,2);next.stop();reopened.close();
});
test('Review retries preserve completed execution and repair count',async t=>{
 // Single-engine policy still supports scheduled recovery.
 const f=fixture(t),task=f.create();let calls=0;const r=f.runner(async()=>{calls++;if(calls===1)return {result:plan};if(calls===3)throw new Error(limit);return {result:good};});await r.tick();approveTask(f.s,f.u,task.id,1);await r.tick();await r.tick();assert.equal(f.s.task(task.id).status,'queued');assert.equal(f.s.task(task.id).round,0);await r.tick();assert.equal(f.s.task(task.id).status,'completed');assert.equal(f.s.threads(task.id).filter(th=>th.phase==='execute').length,1);assert.equal(f.s.threads(task.id).filter(th=>th.phase==='review').length,2);assert.equal(f.s.threads(task.id).at(-1).engine,'codex');
});
test('Claude cooldown blocks other Claude jobs but lets Codex continue',async t=>{
 const f=fixture(t),task=f.create();let calls=[];const r=f.runner(async o=>{calls.push(o.engine);if(o.engine==='claude')throw new Error(limit);return {result:plan};});await r.tick();const second=f.create(),third=f.create({planner:'codex'});await r.tick();await r.tick();await r.tick();assert.deepEqual(calls,['claude','codex','codex','codex']);for(const task of [second,third])assert.equal(f.s.task(task.id).status,'awaiting_approval');
});
test('Manual stop, disabled runner and stale failure never restart a stopped task',async t=>{
 const f=fixture(t),task=f.create();let calls=0;const r=f.runner(async()=>{calls++;throw new Error(limit);});await r.tick();f.setTime(due);f.s.setSetting('runnerEnabled',false);await r.tick();assert.equal(calls,1);changeTaskStatus(f.s,r,f.u,task.id,{status:'paused'});f.s.setSetting('runnerEnabled',true);await r.tick();assert.equal(calls,1);assert.equal(f.s.task(task.id).retryAt,null);
 let fail;const second=f.create({planner:'claude'}),pending=f.runner(()=>new Promise((resolve,reject)=>fail=reject));r.stop();const job=pending.tick();changeTaskStatus(f.s,pending,f.u,second.id,{status:'cancelled'});fail(new Error(limit));await job;assert.equal(f.s.task(second.id).status,'cancelled');assert.equal(f.s.task(second.id).retryAt,null);
});
test('Unknown reset time tries each engine once then waits without looping',async t=>{
 const f=fixture(t),task=f.create();let calls=0;const r=f.runner(async()=>{calls++;throw new Error('session limit resets unknown');});await r.tick();await r.tick();await r.tick();assert.equal(calls,2);assert.equal(f.s.task(task.id).status,'rate_limited');assert.equal(f.s.setting('engineCooldown:codex').estimated,true);
});

test('CLI keeps quota errors from stdout and reports is_error even with exit code zero',async t=>{
 const {EventEmitter}=await import('node:events'),{cliAdapter}=await import('../server/runner.js');const f=fixture(t);
 for(const output of [JSON.stringify({type:'result',is_error:true,result:limit}),limit]){
  const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>setImmediate(()=>{child.stdout.emit('data',Buffer.from(output+'\n'));child.emit('close',output.startsWith('{')?0:1);});return child;};
  await assert.rejects(cliAdapter({engine:'claude',cwd:f.root,runDir:join(f.root,'cli'),prompt:'test',schema:{},onEvent:()=>{},spawnProcess}),error=>{assert.ok(parseClaudeReset(error.message,before));return true;});
 }
});

test('Codex quota switches to Claude with partial files and complete task history',async t=>{
 const f=fixture(t),task=f.create();let execution=0;const engines=[];
 const r=f.runner(async o=>{
   if(o.readOnly)return {result:plan};
   engines.push(o.engine);execution++;
   if(execution===1){writeFileSync(join(o.cwd,'partial.txt'),'keep this work');for(let i=0;i<305;i++)f.s.event(task.id,'activity','progress '+i);throw Error('usage_limit_reached');}
   assert.equal(readFileSync(join(o.cwd,'partial.txt'),'utf8'),'keep this work');
   assert.match(o.prompt,/handoff.json/);const handoff=JSON.parse(readFileSync(join(o.cwd,'.taskflow','handoff.json'),'utf8'));
   assert.ok(handoff.events.some(e=>e.message==='progress 0'));
   assert.ok(handoff.events.some(e=>e.message==='progress 304'));
   assert.ok(handoff.threads.some(th=>th.engine==='codex'&&th.status==='rate_limited'));
   assert.equal(handoff.approvedVersion,1);return {result:good};
 });
 await r.tick();approveTask(f.s,f.u,task.id,1);await r.tick();assert.equal(f.s.task(task.id).status,'queued');
 await r.tick();assert.deepEqual(engines,['codex','claude']);assert.equal(f.s.task(task.id).planVersion,1);
 assert.equal(f.s.threads(task.id).filter(th=>th.phase==='execute'&&th.result?.passed).length,1);
});

test('Unrelated execution errors do not switch providers',()=>{
 for(const error of ['spawn EPERM','npm ECONNREFUSED','permission denied','invalid JSON'])assert.equal(parseEngineLimit(error,before),null);
 assert.equal(parseEngineLimit('You have hit your usage limit',before).estimated,true);
});
