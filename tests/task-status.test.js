import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {changeTaskStatus} from '../server/task-status.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'tf-status-')),store=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);const user=store.addUser('Admin','admin','test-password-admin','admin'),other=store.addUser('Other','other','test-password-other'),pid=id();store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);const task=createTask(store,user,{title:'Status task',description:'Test controlled state changes.',projectId:pid,type:'code'});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,user,other,task,root};}
const plan={summary:'Plan',acceptance:['Done'],questions:[],steps:[{title:'Do',role:'Dev',instructions:'Do task'}]};
test('Manual task status respects ownership, approval, stale state and audit history',t=>{
  const f=fixture(t),runner={stopTask:()=>{}};
  assert.throws(()=>changeTaskStatus(f.store,runner,f.other,f.task.id,{status:'completed'}),/找不到/);
  changeTaskStatus(f.store,runner,f.user,f.task.id,{status:'completed',expectedStatus:'planning'});
  const task=f.store.task(f.task.id);assert.equal(task.status,'completed');assert.ok(task.manualCompletion);assert.equal(task.artifactVersion,null);assert.equal(task.publishApproval,null);
  assert.throws(()=>changeTaskStatus(f.store,runner,f.user,task.id,{status:'paused',expectedStatus:'planning'}),/更新/);
  task.plan=plan;f.store.saveTask(task);
  assert.equal(changeTaskStatus(f.store,runner,f.user,task.id,{status:'reopen'}).status,'awaiting_approval');
  assert.equal(f.store.task(task.id).approvedVersion,null);
  assert.ok(f.store.events(task.id).some(e=>e.kind==='status_changed'));
});
for(const outcome of ['success','failure'])test(`Late AI ${outcome} cannot overwrite a manually completed task`,async t=>{
  const f=fixture(t);let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const runner=createRunner(f.store,{adapter:()=>promise,dataDir:join(f.root,'runs'),recover:false});t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const work=runner.tick();let stopped=false;
  changeTaskStatus(f.store,{stopTask:()=>{stopped=true;}},f.user,f.task.id,{status:'completed'});assert.equal(stopped,true);
  assert.throws(()=>changeTaskStatus(f.store,runner,f.user,f.task.id,{status:'reopen'}),/停止/);
  if(outcome==='success')resolve({result:plan});else reject(Error('killed'));await work;
  assert.equal(f.store.task(f.task.id).status,'completed');assert.equal(f.store.threads(f.task.id)[0].status,'cancelled');
  assert.equal(changeTaskStatus(f.store,runner,f.user,f.task.id,{status:'reopen'}).status,'planning');
});
test('Restart preserves manual completion while cleaning up interrupted threads',t=>{
  const f=fixture(t);changeTaskStatus(f.store,{stopTask:()=>{}},f.user,f.task.id,{status:'completed'});f.store.saveThread({id:id(),taskId:f.task.id,status:'running',version:1});
  const runner=createRunner(f.store);runner.stop();assert.equal(f.store.task(f.task.id).status,'completed');assert.equal(f.store.threads(f.task.id)[0].status,'cancelled');
});
