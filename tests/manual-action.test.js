import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
import {createTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {detectManualActionRequirement,classifyExecutionFailure,manualActionRequest,decideManualAction} from '../server/manual-action.js';
import {threadPresentation} from '../server/thread-presentation.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'tf-manual-action-')),s=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);
 const u=s.addUser('Owner','owner','test-password'),other=s.addUser('Other','other','test-password'),pid=id();s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
 const task=createTask(s,u,{title:'Manual action test',description:'Run prisma migrate against a fresh database',projectId:pid,type:'research'});
 Object.assign(task,{status:'queued',workspace:source,plan:{summary:'Original',acceptance:['done'],questions:[],steps:[{title:'Run migration',role:'Engineer',instructions:'Run prisma migrate dev'}]},approvedVersion:1});
 s.saveTask(task);
 t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
 return {s,u,other,task,root};
}

test('Approval/elevation/policy denials are classified deterministically as needing user action',()=>{
 assert.ok(detectManualActionRequirement({message:'Tool execution failed: This command requires approval'}));
 assert.equal(classifyExecutionFailure({message:'This command requires approval'}),'approval_required');
 assert.ok(detectManualActionRequirement({message:'Error: Access is denied while running this command'}));
 assert.equal(detectManualActionRequirement({message:'requires administrator privileges to continue'}).requiresAdministrator,true);
 assert.equal(detectManualActionRequirement({message:'This command requires approval'}).requiresAdministrator,false);
});
test('A genuine compile/test failure is never misclassified as needing user action',()=>{
 assert.equal(detectManualActionRequirement({message:"TS2322: Type 'string' is not assignable to type 'number'."}),null);
 assert.equal(classifyExecutionFailure({summary:'型別檢查失敗',evidence:['npm run typecheck: TS2322 error']}),'execution_error');
 assert.equal(detectManualActionRequirement({message:'EACCES: permission denied, open \'/tmp/x\''}),null,'a bare file permission error is not, by itself, an environment approval block');
});

test('An approval-blocked command becomes needs_user_action and the runner stops retrying it',async t=>{
 const f=fixture(t);let calls=0;f.s.setSetting('runnerEnabled',true);
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>{calls++;throw new Error('Tool execution failed: This command requires approval: npx prisma migrate dev --name init');}});
 try{
  await runner.tick();
  const task=f.s.task(f.task.id);
  assert.equal(task.status,'waiting_input');
  assert.equal(task.userActionRequired.status,'pending');
  assert.equal(task.userActionRequired.category,'approval_required');
  assert.equal(calls,1);
  await runner.tick();await runner.tick();
  assert.equal(calls,1,'a pending manual action must stop the runner from touching this step again');
 }finally{runner.stop();}
});

test('A genuine execution failure keeps the ordinary failed/waiting_input path, not manual action',async t=>{
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>({result:{summary:'型別檢查失敗',passed:false,questions:[],evidence:['npm run typecheck: TS2322: Type string is not assignable to type number.'],artifacts:[]}})});
 try{
  await runner.tick();
  const task=f.s.task(f.task.id);
  assert.equal(task.userActionRequired,null);
  assert.equal(task.status,'waiting_input');
  assert.match(task.questions[0],/此步驟未通過驗收/);
 }finally{runner.stop();}
});

test('A step already waiting on a pending manual action is never re-executed',async t=>{
 const f=fixture(t);let calls=0;
 f.task.userActionRequired={required:true,status:'pending',reason:'requires approval',actionType:'run_command',commands:['npx prisma migrate dev'],workingDirectory:f.task.workspace,instructions:'run it',verification:[],requiresAdministrator:null,threadId:'thread-1',phase:'execute',planVersion:1,at:new Date().toISOString()};
 f.s.saveTask(f.task);f.s.setSetting('runnerEnabled',true);
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>{calls++;return {result:{summary:'x',passed:true,questions:[],evidence:['x'],artifacts:[]}};}});
 try{await runner.tick();assert.equal(calls,0);}finally{runner.stop();}
});

test('Marking a manual action completed re-enters verification instead of an automatic pass',async t=>{
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);let calls=0,lastPrompt='';
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async o=>{calls++;lastPrompt=o.prompt;if(calls===1)throw new Error('This command requires approval: npx prisma migrate dev');return {result:{summary:'migration verified',passed:true,questions:[],evidence:['prisma/migrations exists'],artifacts:[]}};}});
 try{
  await runner.tick();
  let task=f.s.task(f.task.id);const request=manualActionRequest(f.s,task);
  assert.throws(()=>decideManualAction(f.s,f.other,task.id,{requestId:request.id,decision:'completed'}),{status:404});
  const updated=decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'completed'});
  assert.equal(updated.userActionRequired,null);assert.equal(updated.validationReviewPending,true);assert.equal(updated.status,'queued');
  assert.throws(()=>decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'completed'}),{status:409});
  await runner.tick();
  task=f.s.task(f.task.id);
  assert.equal(f.s.threads(task.id).at(-1).phase,'review');
  assert.match(lastPrompt,/不要重新執行相同或等效的指令/);
  assert.equal(task.status,'completed');
 }finally{runner.stop();}
});

test('Reporting execution failure feeds the error back to the agent instead of re-trying the blocked command',async t=>{
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);let calls=0,lastPrompt='';
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async o=>{calls++;lastPrompt=o.prompt;if(calls===1)throw new Error('This command requires approval: npx prisma migrate dev');return {result:{summary:'fixed connection string',passed:true,questions:[],evidence:['migrated'],artifacts:[]}};}});
 try{
  await runner.tick();
  let task=f.s.task(f.task.id);const request=manualActionRequest(f.s,task);
  decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'failed',note:"Error: P1001 Can't reach database server"});
  task=f.s.task(f.task.id);assert.equal(task.userActionRequired,null);assert.equal(task.status,'queued');
  assert.match(task.clarifications.at(-1).answer,/P1001/);
  await runner.tick();
  assert.equal(calls,2);assert.match(lastPrompt,/P1001/);
  assert.equal(f.s.threads(task.id).at(-1).phase,'execute');
 }finally{runner.stop();}
});

test('Skipping a blocked step records the skip, never claims a full pass, and still lets the plan proceed',async t=>{
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);let calls=0;
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>{calls++;if(calls===1)throw new Error('This command requires approval: npx prisma migrate dev');return {result:{summary:'其餘驗收通過',passed:true,questions:[],evidence:['checked'],artifacts:[]}};}});
 try{
  await runner.tick();
  let task=f.s.task(f.task.id);const request=manualActionRequest(f.s,task);
  assert.throws(()=>decideManualAction(f.s,f.u,task.id,{requestId:'stale',decision:'skip'}),{status:409});
  decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'skip'});
  task=f.s.task(f.task.id);
  assert.equal(task.manualActionSkips.length,1);
  const blockedThread=f.s.threads(task.id)[0];
  assert.equal(blockedThread.result.manualActionSkipped,true);
  assert.match(blockedThread.result.evidence.at(-1),/使用者已選擇略過/);
  assert.equal(threadPresentation(blockedThread).statusLabel,'已略過（未驗證）');
  assert.equal(task.status,'queued');
  await runner.tick();
  assert.equal(f.s.threads(task.id).at(-1).phase,'review');
 }finally{runner.stop();}
});

test('HTTP exposes the manual-action request, requires ownership, and rejects stale decisions',async t=>{
 const f=fixture(t);
 Object.assign(f.task,{status:'waiting_input',userActionRequired:{required:true,status:'pending',reason:'requires approval',actionType:'run_command',commands:['npx prisma migrate dev --name init'],workingDirectory:f.task.workspace,instructions:'請在 PowerShell 執行。',verification:['prisma/migrations 已建立'],requiresAdministrator:false,threadId:'thread-x',phase:'execute',planVersion:1,at:new Date().toISOString()}});
 f.s.saveTask(f.task);
 f.s.saveThread({id:'thread-x',taskId:f.task.id,version:1,phase:'execute',status:'completed',result:{summary:'blocked',passed:false,questions:[],evidence:['This command requires approval'],artifacts:[],userActionRequired:{required:true}}});
 f.s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('manual-session'),f.u.id,Date.now()+60000);
 const server=createApp(f.s,{status:{}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
   const base=`http://127.0.0.1:${server.address().port}/api/tasks/${f.task.id}`,headers={cookie:'tf_session=manual-session','Content-Type':'application/json'};
   const detail=await (await fetch(base,{headers})).json();
   assert.equal(detail.manualAction.reason,'requires approval');
   assert.deepEqual(detail.manualAction.commands,['npx prisma migrate dev --name init']);
   const body=JSON.stringify({requestId:detail.manualAction.id,decision:'completed'});
   const response=await fetch(base+'/user-action/decision',{method:'POST',headers,body});assert.equal(response.status,200);
   const updated=await response.json();assert.equal(updated.status,'queued');assert.equal(updated.validationReviewPending,true);assert.equal(updated.manualAction,null);
   assert.equal((await fetch(base+'/user-action/decision',{method:'POST',headers,body})).status,409);
 }finally{await new Promise(r=>server.close(r));}
});
