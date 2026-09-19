import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
import {createTask} from '../server/domain.js';
import {toolAccessFailure,validationSkipRequest,decideValidationSkip} from '../server/validation-skip.js';
import {createRunner} from '../server/runner.js';
import {handleLineUI} from '../server/line-ui.js';
import {threadPresentation} from '../server/thread-presentation.js';
function fixture(t,phase='execute'){
 const root=mkdtempSync(join(tmpdir(),'tf-approval-')),s=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);
 const u=s.addUser('Owner','owner','test-password'),other=s.addUser('Other','other','test-password'),pid=id();s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
 const task=createTask(s,u,{title:'Approval test',description:'Continue original work',projectId:pid,type:'research'});
 Object.assign(task,{status:'waiting_input',workspace:source,plan:{summary:'Original',acceptance:['done'],questions:[],steps:[{title:'Original step',role:'Author',instructions:'Continue work'}]},approvedVersion:1,questions:['是否核准調整套件版本並執行測試？']});
 if(phase==='repair'){task.round=1;task.repairPlan={id:'repair',round:1,planVersion:1,steps:[]};task.approvedRepairId='repair';}
 s.saveTask(task);
 // 會走到 review／repair 的任務，代表它的計畫步驟本來就已經執行完成並通過——沒有通過的
 // 步驟根本不會被派到最終驗證。fixture 必須忠實反映這一點，否則就會造出「步驟還沒做完
 // 卻已經在跑最終驗證」這種現實中不該存在的狀態。
 if(phase!=='execute')s.saveThread({id:id(),taskId:task.id,version:1,phase:'execute',round:0,status:'completed',title:'Original step',result:{summary:'Original step done',passed:true,questions:[],evidence:['step verified'],artifacts:[]}});
 s.saveThread({id:id(),taskId:task.id,version:1,phase,round:task.round,status:'completed',result:{passed:false,questions:task.questions}});
 t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return {s,u,other,task,root};
}

const blocked={summary:'驗證工具存取失敗：Browser Use security policy 拒絕存取；其他檢查通過。',passed:false,questions:[],evidence:['Browser Use rejected this action due to browser security policy'],artifacts:[]};

test('Finished executions never display failed validation as successful completion',()=>{
 assert.equal(threadPresentation({status:'completed',phase:'execute',result:blocked}).statusLabel,'驗證受限／未通過');
 assert.equal(threadPresentation({status:'completed',phase:'execute',result:{passed:false}}).statusLabel,'未通過驗收');
 assert.equal(threadPresentation({status:'completed',phase:'review',result:{passed:true}}).statusLabel,'驗證通過');
 assert.equal(threadPresentation({status:'completed',phase:'plan',result:{questions:[]}}).statusLabel,'規劃已產出');
});

test('Existing blocked execution offers an explicit decision and continues the same step, not final review',async t=>{
 const f=fixture(t,'execute');const th=f.s.threads(f.task.id).at(-1);th.result=blocked;f.s.saveThread(th);
 f.task.questions=['此步驟無法完成，請查看角色紀錄並補充處理方式。'];f.s.saveTask(f.task);
 const request=validationSkipRequest(f.s,f.task);assert.equal(request.phase,'execute');
 assert.equal(f.s.task(f.task.id).status,'waiting_input');
 decideValidationSkip(f.s,f.u,f.task.id,{requestId:request.id,decision:'skip'});
 f.s.setSetting('runnerEnabled',true);let prompt;
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async o=>{prompt=o.prompt;return {result:{summary:'其餘步驟檢查通過；瀏覽器未驗證',passed:true,questions:[],evidence:['build passed'],artifacts:[]}};}});
 try{await runner.tick();assert.equal(f.s.threads(f.task.id).at(-1).phase,'execute');assert.match(prompt,/不得聲稱這些項目通過/);assert.equal(f.s.task(f.task.id).status,'queued');assert.equal(f.s.task(f.task.id).planVersion,1);assert.equal(f.s.threads(f.task.id)[0].result.passed,false);}finally{runner.stop();}
});
function pending(t){const f=fixture(t,'review');const th=f.s.threads(f.task.id).at(-1);th.result=blocked;f.s.saveThread(th);f.task.questions=[];f.task.validationFailure={...blocked,threadId:th.id};f.task.status='awaiting_repair_approval';f.task.round=1;f.task.repairPlan={id:'old-repair',round:1,planVersion:1};f.s.saveTask(f.task);return f;}
test('Tool access failure offers skip, without classifying ordinary test failures',t=>{
 assert.equal(toolAccessFailure({passed:false,summary:'功能測試失敗',evidence:['assertion failed']}),false);
 const f=pending(t);assert.ok(validationSkipRequest(f.s,f.task));
 f.s.saveThread({id:id(),taskId:f.task.id,version:1,phase:'repair_plan',status:'completed',result:{questions:[]}});
 assert.ok(validationSkipRequest(f.s,f.task),'An already proposed repair plan must not hide the blocked review');
 const req=validationSkipRequest(f.s,f.task);
 assert.throws(()=>decideValidationSkip(f.s,f.other,f.task.id,{requestId:req.id,decision:'skip'}),{status:404});
 assert.throws(()=>decideValidationSkip(f.s,f.u,f.task.id,{requestId:'old',decision:'skip'}),{status:409});
 const task=decideValidationSkip(f.s,f.u,f.task.id,{requestId:req.id,decision:'wait'});
 assert.equal(task.status,'paused');assert.equal(task.validationSkips,undefined);
});
test('Skip keeps failed evidence and original plan; resumes review, never unapproved repair',async t=>{
 const f=pending(t),req=validationSkipRequest(f.s,f.task);
 const task=decideValidationSkip(f.s,f.u,f.task.id,{requestId:req.id,decision:'skip'});
 assert.equal(task.planVersion,1);assert.equal(task.approvedVersion,1);assert.equal(task.validationFailure.passed,false);assert.equal(task.status,'queued');
 assert.throws(()=>decideValidationSkip(f.s,f.u,f.task.id,{requestId:req.id,decision:'skip'}),{status:409});
 f.s.setSetting('runnerEnabled',true);let prompt;
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async o=>{prompt=o.prompt;return {result:{summary:'其餘檢查通過；視覺未驗證',passed:true,questions:[],evidence:['其他測試通過'],artifacts:[]}};}});
 try{await runner.tick();assert.equal(f.s.threads(task.id).at(-1).phase,'review');assert.match(prompt,/不得聲稱這些項目通過/);assert.equal(f.s.task(task.id).status,'completed');assert.equal(f.s.task(task.id).validationSkips.length,1);assert.equal(f.s.threads(task.id).find(x=>x.phase==='review').result.passed,false,'原本那份受限的驗證報告必須原樣保留，不因為使用者選擇跳過就被改寫成通過');}finally{runner.stop();}
});
test('New blocked review waits for decision; mixed functional failures still require repair',async t=>{
 const f=pending(t);let task=f.task;task.status='queued';task.validationReviewPending=true;f.s.saveTask(task);f.s.setSetting('runnerEnabled',true);
 let output=blocked;const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async()=>({result:output})});
 try{
 await runner.tick();task=f.s.task(task.id);assert.equal(task.status,'waiting_input');assert.ok(validationSkipRequest(f.s,task));
 decideValidationSkip(f.s,f.u,task.id,{requestId:validationSkipRequest(f.s,task).id,decision:'skip'});
 output={summary:'仍有功能錯誤',passed:false,questions:[],evidence:['功能測試 assertion failed'],artifacts:[]};
 await runner.tick();assert.equal(f.s.task(task.id).status,'repair_planning');assert.equal(f.s.task(task.id).validationReviewPending,false);
 }finally{runner.stop();}
});
test('LINE skip choices bind to the current request and reject replay',t=>{
 const f=pending(t),send=data=>handleLineUI(f.s,f.u,'test-line',{data}),last=()=>JSON.parse(f.s.db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').get().payload)[0];
 send(`tf:view:${f.task.id}`);const action=last().quickReply.items.find(i=>i.action.label==='跳過受限驗證並繼續').action.data;
 send(action);assert.equal(f.s.task(f.task.id).status,'queued');send(action);assert.match(last().text,/失效/);
});
test('HTTP exposes skip scope and records the decision without altering the original report',async t=>{
 const f=pending(t);f.s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('skip-session'),f.u.id,Date.now()+60000);
 const server=createApp(f.s,{status:{}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
   const base=`http://127.0.0.1:${server.address().port}/api/tasks/${f.task.id}`,headers={cookie:'tf_session=skip-session','Content-Type':'application/json'};
   const detail=await (await fetch(base,{headers})).json();assert.match(detail.validationSkipRequest.summary,/工具存取失敗/);
   const body=JSON.stringify({requestId:detail.validationSkipRequest.id,decision:'skip'});
   const response=await fetch(base+'/validation/decision',{method:'POST',headers,body});assert.equal(response.status,200);
   const updated=await response.json();assert.equal(updated.status,'queued');assert.equal(updated.validationFailure.passed,false);assert.equal(updated.validationSkipRequest,null);
   assert.equal((await fetch(base+'/validation/decision',{method:'POST',headers,body})).status,409);
 }finally{await new Promise(r=>server.close(r));}
});
