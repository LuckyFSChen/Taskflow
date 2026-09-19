import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createTask} from '../server/domain.js';
import {threadPresentation} from '../server/thread-presentation.js';
import {buildRuns} from '../server/run-attempt.js';
import {createApp} from '../server/app.js';

test('buildRuns returns [] for a task with no threads yet',t=>{
  assert.deepEqual(buildRuns([]),[]);
  assert.deepEqual(buildRuns(undefined),[]);
});

test('buildRuns groups retries of the same phase into one Run with multiple Attempts',t=>{
  const threads=[
    {taskId:'t1',version:1,round:0,phase:'plan',status:'failed',result:null,title:'整理需求與驗收'},
    {taskId:'t1',version:1,round:0,phase:'plan',status:'completed',result:{passed:true},title:'整理需求與驗收'},
  ].map(th=>({...th,...threadPresentation(th)}));
  const runs=buildRuns(threads);
  assert.equal(runs.length,1);
  assert.equal(runs[0].attempts.length,2);
  assert.equal(runs[0].phase,'plan');
  assert.equal(runs[0].round,0);
  assert.equal(runs[0].displayStatus,'awaiting_approval');
});

test('buildRuns advances the execute step cursor only after a passing attempt, keeping retries in the same Run',t=>{
  const threads=[
    {taskId:'t1',version:1,round:0,phase:'execute',status:'failed',result:{passed:false},title:'Step 1'},
    {taskId:'t1',version:1,round:0,phase:'execute',status:'completed',result:{passed:true},title:'Step 1'},
    {taskId:'t1',version:1,round:0,phase:'execute',status:'completed',result:{passed:true},title:'Step 2'},
  ].map(th=>({...th,...threadPresentation(th)}));
  const runs=buildRuns(threads);
  assert.equal(runs.length,2);
  assert.equal(runs[0].stepIndex,0);
  assert.equal(runs[0].attempts.length,2);
  assert.equal(runs[1].stepIndex,1);
  assert.equal(runs[1].attempts.length,1);
});

test('buildRuns keeps repair rounds as separate Runs from the original phase',t=>{
  const threads=[
    {taskId:'t1',version:1,round:0,phase:'review',status:'completed',result:{passed:false},title:'檢查成果與驗收'},
    {taskId:'t1',version:1,round:1,phase:'repair_plan',status:'completed',result:{passed:true},title:'第 1 輪修正方案'},
    {taskId:'t1',version:1,round:1,phase:'repair',status:'completed',result:{passed:true},title:'第 1 輪修正'},
    {taskId:'t1',version:1,round:1,phase:'review',status:'completed',result:{passed:true},title:'檢查成果與驗收'},
  ].map(th=>({...th,...threadPresentation(th)}));
  const runs=buildRuns(threads);
  assert.equal(runs.length,4);
  assert.deepEqual(runs.map(r=>`${r.round}:${r.phase}`),['0:review','1:repair_plan','1:repair','1:review']);
  assert.equal(runs[0].displayStatus,'failed');
  assert.equal(runs[3].displayStatus,'completed');
});

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'tf-run-attempt-')),store=createStore(join(root,'db.sqlite')),source=join(root,'source');
  mkdirSync(source);
  const user=store.addUser('Admin','admin','test-password-admin','admin'),pid=id();
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);
  const dist=join(root,'dist');mkdirSync(dist);writeFileSync(join(dist,'index.html'),'<!doctype html><html>TaskFlow</html>');
  const server=createApp(store,{status:{}},{dist}).listen(0,'127.0.0.1');
  store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('test-session'),user.id,Date.now()+60000);
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
  return {store,user,pid,server};
}

test('/api/tasks/:id serializes runs alongside the existing threads array, empty for a brand-new task',async t=>{
  const f=fixture(t);
  await new Promise(r=>f.server.once('listening',r));
  const task=createTask(f.store,f.user,{title:'Run/Attempt task',description:'Verify runs field on API response.',projectId:f.pid,type:'code'});
  const base=`http://127.0.0.1:${f.server.address().port}`;
  const headers={cookie:'tf_session=test-session'};
  const before=await fetch(`${base}/api/tasks/${task.id}`,{headers});
  assert.equal(before.status,200);
  const beforeBody=await before.json();
  assert.deepEqual(beforeBody.runs,[]);
  assert.deepEqual(beforeBody.threads,[]);
  f.store.saveThread({id:id(),taskId:task.id,version:1,round:0,phase:'plan',engine:'codex',role:'需求規劃',title:'整理需求與驗收',status:'completed',started:Date.now(),finished:Date.now(),summary:null,result:{passed:true},sessionId:null,error:null});
  const after=await fetch(`${base}/api/tasks/${task.id}`,{headers});
  const afterBody=await after.json();
  assert.equal(afterBody.threads.length,1,'existing flat threads array is untouched');
  assert.equal(afterBody.runs.length,1);
  assert.equal(afterBody.runs[0].attempts.length,1);
  assert.equal(afterBody.runs[0].attempts[0].id,afterBody.threads[0].id,'Attempt reuses the same thread object, no fields dropped');
  const state=await fetch(`${base}/api/state`,{headers});
  const stateBody=await state.json();
  const stateTask=stateBody.tasks.find(x=>x.id===task.id);
  assert.ok(Array.isArray(stateTask.runs));
  assert.equal(stateTask.runs.length,1);
});
