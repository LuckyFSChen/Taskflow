import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
  assert.match(task.userActionRequired.message,/requires approval/);
  assert.equal(calls,1);
  await runner.tick();await runner.tick();
  assert.equal(calls,1,'a pending manual action must stop the runner from touching this step again');
 }finally{runner.stop();}
});
test('A sandbox-denied command is classified the same way as an approval block, not a code failure',async t=>{
 const f=fixture(t);let calls=0;f.s.setSetting('runnerEnabled',true);
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>{calls++;throw new Error('Tool execution failed: sandbox denied: npx prisma migrate dev');}});
 try{
  await runner.tick();
  const task=f.s.task(f.task.id);
  assert.equal(task.status,'waiting_input');
  assert.equal(task.userActionRequired.status,'pending');
  assert.equal(task.userActionRequired.category,'approval_required');
  assert.equal(calls,1);
  await runner.tick();
  assert.equal(calls,1,'a pending manual action from a sandbox denial must never be retried automatically');
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
  assert.equal(updated.userActionRequired,null);assert.equal(updated.status,'queued');
  // 被擋住的是 execute 階段，手動完成只代表「那一個步驟的操作做完了」，不代表整份計畫
  // 可以進入最終驗證。validationReviewPending 只在 review 階段被擋住時才成立。
  assert.equal(updated.validationReviewPending,false);
  assert.throws(()=>decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'completed'}),{status:409});
  await runner.tick();
  task=f.s.task(f.task.id);
  // 先回到被擋住的那個步驟重新驗證結果（而不是自動當成通過，也不是直接跳到 review）。
  assert.equal(f.s.threads(task.id).at(-1).phase,'execute');
  assert.match(lastPrompt,/不要重新執行相同或等效的指令/);
  assert.equal(f.s.threads(task.id).at(-1).result.passed,true);
  // 步驟確實驗證通過之後，才輪到 group-level 獨立驗證，任務也才可能標記完成。
  await runner.tick();
  task=f.s.task(f.task.id);
  assert.equal(f.s.threads(task.id).at(-1).phase,'review');
  assert.equal(task.status,'completed');
 }finally{runner.stop();}
});

test('A completed manual action still fails a genuine post-verification problem instead of forcing a pass',async t=>{
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);let calls=0;
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>{calls++;if(calls===1)throw new Error('This command requires approval: npx prisma migrate dev');return {result:{summary:'migration ran but schema mismatch',passed:false,questions:[],evidence:['prisma/schema.prisma does not match applied migration'],artifacts:[]}};}});
 try{
  await runner.tick();
  const task=f.s.task(f.task.id);const request=manualActionRequest(f.s,task);
  const updated=decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'completed'});
  assert.equal(updated.userActionRequired,null);assert.equal(updated.status,'queued');
  await runner.tick();
  const final=f.s.task(task.id);
  assert.equal(final.userActionRequired,null,'a real verification failure must never be reclassified as needing manual action');
  // 重新驗證這個步驟時發現真正的問題：走既有的「步驟未通過驗收」路徑等使用者處理，
  // 絕不會因為使用者回報過「已手動完成」就被當成通過。
  assert.equal(final.status,'waiting_input');
  assert.notEqual(final.status,'completed');
  assert.equal(f.s.threads(task.id).at(-1).result.passed,false);
  assert.match(final.questions.join('\n'),/schema mismatch/);
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
 Object.assign(f.task,{status:'waiting_input',userActionRequired:{required:true,status:'pending',reason:'requires approval',actionType:'run_command',commands:['npx prisma migrate dev --name init'],workingDirectory:f.task.workspace,message:'This command requires approval: npx prisma migrate dev --name init',instructions:'請在 PowerShell 執行。',verification:['prisma/migrations 已建立'],requiresAdministrator:false,threadId:'thread-x',phase:'execute',planVersion:1,at:new Date().toISOString()}});
 f.s.saveTask(f.task);
 f.s.saveThread({id:'thread-x',taskId:f.task.id,version:1,phase:'execute',status:'completed',result:{summary:'blocked',passed:false,questions:[],evidence:['This command requires approval'],artifacts:[],userActionRequired:{required:true}}});
 f.s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('manual-session'),f.u.id,Date.now()+60000);
 const server=createApp(f.s,{status:{}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
   const base=`http://127.0.0.1:${server.address().port}/api/tasks/${f.task.id}`,headers={cookie:'tf_session=manual-session','Content-Type':'application/json'};
   const detail=await (await fetch(base,{headers})).json();
   // A pending manual action must surface as an explicit, distinct status — never collapsed
   // into the generic waiting_input the Reviewer/UI use for ordinary questions.
   assert.equal(detail.status,'waiting_input');
   assert.equal(detail.displayStatus,'waiting_user_action');
   assert.equal(detail.manualAction.reason,'requires approval');
   assert.deepEqual(detail.manualAction.commands,['npx prisma migrate dev --name init']);
   assert.equal(detail.manualAction.workingDirectory,f.task.workspace);
   assert.match(detail.manualAction.message,/requires approval/);
   assert.equal(detail.manualAction.instructions,'請在 PowerShell 執行。');
   const body=JSON.stringify({requestId:detail.manualAction.id,decision:'completed'});
   const response=await fetch(base+'/user-action/decision',{method:'POST',headers,body});assert.equal(response.status,200);
   const updated=await response.json();assert.equal(updated.status,'queued');assert.equal(updated.validationReviewPending,false,'an execute-phase manual action must not push the task into group-level final validation');assert.equal(updated.manualAction,null);
   assert.equal(updated.displayStatus,'queued','once resolved, the display status must fall back to the ordinary task status');
   assert.equal((await fetch(base+'/user-action/decision',{method:'POST',headers,body})).status,409);
 }finally{await new Promise(r=>server.close(r));}
});

test('A manual action on an early step never skips the remaining plan steps',async t=>{
 // 迴歸測試：真實事故中，第 1 步因為執行環境擋住指令而回報需要手動操作，使用者回報
 // 「已完成」之後，平台直接跳到 group-level 獨立驗證，第 2～6 步整批被略過，任務還被
 // 判定為完成。手動操作只影響它自己那一個步驟，絕不能讓剩餘的計畫步驟消失。
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);
 const seeded=f.s.task(f.task.id);
 seeded.plan={summary:'three steps',acceptance:['done'],questions:[],steps:[
  {title:'Step 1 schema',role:'Engineer',instructions:'run migration'},
  {title:'Step 2 api',role:'Engineer',instructions:'extend api'},
  {title:'Step 3 ui',role:'Engineer',instructions:'build ui'}]};
 f.s.saveTask(seeded);
 let calls=0;
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>{calls++;
  if(calls===1)throw new Error('This command requires approval: npx prisma migrate dev');
  return {result:{summary:'step done',passed:true,questions:[],evidence:['verified'],artifacts:[]}};}});
 try{
  await runner.tick();
  const blocked=f.s.task(f.task.id),request=manualActionRequest(f.s,blocked);
  assert.equal(request.commands.length>0||request.message.length>0,true);
  decideManualAction(f.s,f.u,blocked.id,{requestId:request.id,decision:'completed'});

  await runner.tick();
  assert.equal(f.s.threads(f.task.id).some(x=>x.phase==='review'),false,
   '計畫還有步驟沒做完時，不得進入 group-level 獨立驗證');
  assert.notEqual(f.s.task(f.task.id).status,'completed');
  assert.equal(f.s.threads(f.task.id).at(-1).title,'Step 1 schema');

  await runner.tick();
  assert.equal(f.s.threads(f.task.id).at(-1).title,'Step 2 api');
  assert.notEqual(f.s.task(f.task.id).status,'completed');

  await runner.tick();
  assert.equal(f.s.threads(f.task.id).at(-1).title,'Step 3 ui');
  assert.notEqual(f.s.task(f.task.id).status,'completed');

  // 三個步驟都實際執行並通過之後，才輪到最終驗證。
  await runner.tick();
  const last=f.s.threads(f.task.id).at(-1);
  assert.equal(last.phase,'review');
  assert.equal(f.s.threads(f.task.id).filter(x=>x.phase==='execute'&&x.result?.passed===true).length,3);
  assert.equal(f.s.task(f.task.id).status,'completed');
 }finally{runner.stop();}
});

test('A block on git add/commit/push never becomes a user-action request',()=>{
 // 迴歸測試：TaskFlow 自己負責版本控制，agent 被擋下 git add／git commit 是預期中的正確行為。
 // 實際事故：最後一個步驟已完成、測試全過、平台也已 commit，但 agent 在 summary 裡如實說明
 // 「本次執行環境對 git add／git commit 回傳 This command requires approval」，這段敘述被
 // 比對到，於是 passed 被強制改成 false，並生出一個 commands 為空、使用者無從執行的請求。
 assert.equal(detectManualActionRequirement({message:'git commit failed: This command requires approval'}),null);
 assert.equal(detectManualActionRequirement({summary:'本次執行環境對 git add／git commit 等操作回傳「This command requires approval」，已依規則不重複嘗試；版本控制交由 TaskFlow 平台負責。',evidence:['npm test：30 passed']}),null);
 assert.equal(detectManualActionRequirement({summary:'依規則版本控制交由平台處理；sandbox denied 了 git push。'}),null);
});

test('A real environment block is still detected even when a git block is mentioned first',()=>{
 // 版本控制的阻擋要忽略，但不能因此漏掉同一份報告裡真正需要使用者處理的阻擋。
 const detection=detectManualActionRequirement({
  summary:'git commit 被擋下（This command requires approval），版本控制交由平台負責。'
    +' '.repeat(400)
    +'另外，執行 npx prisma migrate deploy 時同樣回報 This command requires approval，此項無法繞過。',
 });
 assert.ok(detection,'a genuine block outside the version-control context must still be detected');
 assert.equal(detection.category,'approval_required');
});

test('Version-control wording never masks an elevation requirement',()=>{
 const detection=detectManualActionRequirement({summary:'git add 被擋；'+' '.repeat(400)+'安裝驅動程式 requires administrator privileges。'});
 assert.ok(detection);
 assert.equal(detection.requiresAdministrator,true);
});

test("An agent asking the user to run git add/commit is never turned into a user action",()=>{
 // 迴歸測試：Task Group 2 的 v5 第 3 步實際做完了工作（改寫兩個測試檔、backend 88 項測試全過），
 // 平台也已經把它 commit 成 7c7ec100。但 agent 不知道平台會替它 commit，於是把被擋下的
 // git add／git commit 放進 userActionRequired，要使用者「在本機手動執行 add/commit」。
 // 照做只會多出一個平台沒有記錄的 commit。先前只過濾了 regex 層，自我回報這條路徑沒擋住。
 const selfReport={required:true,actionType:'run_command',
  commands:['git add src/__tests__/publicApi.test.ts','git commit -m "taskflow(execute): 測試改為內容存在性斷言"'],
  reason:'本次工具呼叫層級的核准機制拒絕了寫入類 git 操作（git add / git commit）',
  instructions:'請在本機終端機依序執行這兩行指令，將本步驟修改的檔案加入版控並建立 commit。'};
 assert.equal(detectManualActionRequirement({summary:'已完成本步驟，唯未能完成 git commit。',selfReport}),null);
 assert.equal(detectManualActionRequirement({selfReport:{required:true,commands:[],instructions:'請手動 git commit 這兩個檔案'}}),null);
});

test('An agent self-report about a genuinely blocked command is still honoured',()=>{
 // 版控要忽略，但不能因此把真正需要使用者處理的事也一起吞掉。
 assert.equal(detectManualActionRequirement({selfReport:{required:true,commands:['npx prisma migrate deploy'],instructions:'請執行'}}).category,'agent_reported');
 assert.equal(detectManualActionRequirement({selfReport:{required:true,commands:[],instructions:'請在本機安裝 Visual Studio Build Tools 後重試'}}).category,'agent_reported');
 // 指令清單同時含版控與非版控時，非版控的那個仍然需要使用者處理。
 assert.equal(detectManualActionRequirement({selfReport:{required:true,commands:['git add .','npm run deploy'],instructions:'請執行'}}).category,'agent_reported');
});

test('The executor prompt states that version control belongs to the platform',()=>{
 // 這是根因的預防：不講清楚，agent 就會一再嘗試 git add／git commit，再把被擋下當成
 // 失敗或需要使用者處理。今晚三次事故都源自這一點。
 const prompt=readFileSync(new URL('../server/runner.js',import.meta.url),'utf8');
 assert.match(prompt,/版本控制由平台負責/);
 assert.match(prompt,/不要執行 git add、git commit、git push/);
 assert.match(prompt,/不要因此把 passed 設為 false/);
});
