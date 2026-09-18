import {approveRepair,reviseRepair} from '../server/repair-approval.js';
import {changeTaskStatus} from '../server/task-status.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createTask,approveTask,reviseTask,requireTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {createApp} from '../server/app.js';
import {processLine} from '../server/line.js';

const plan={summary:'建立驗收文件',acceptance:['有可讀取的文件'],questions:[],steps:[{title:'撰寫文件',role:'文件作者',instructions:'完成文件'}]};
const good={summary:'驗證完成',questions:[],artifacts:['result.md'],passed:true,evidence:['讀取 result.md 確認符合驗收']};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'taskflow-test-')),store=createStore(join(dir,'db.sqlite'));const owner=store.addUser('Owner','owner','password-owner-123'),other=store.addUser('Other','other','password-other-123'),admin=store.addUser('Admin','admin','password-admin-123','admin'),projectId=id();const source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'README.md'),'Original');writeFileSync(join(source,'.env'),'TOP_SECRET');store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'demo','Demo',source);store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id,projectId);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,owner,other,admin,projectId,source,create:(extra={})=>createTask(store,owner,{title:'Document task',description:'Create a document and validate it.',projectId,type:'research',...extra})};}
function runnerFor(t,f,adapter){const runner=createRunner(f.store,{adapter,dataDir:join(f.dir,'runs'),recover:false});t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);return runner;}

test('An incomplete execution is retried at the same step after recovery',async t=>{
 const f=fixture(t);let attempts=0;const runner=runnerFor(t,f,async o=>{
   if(o.readOnly)return {result:plan};
   attempts++;assert.match(o.prompt,/完成文件/);
   return {result:{...good,passed:attempts>1}};
 });
 const task=f.create();await runner.tick();approveTask(f.store,f.owner,task.id,1);await runner.tick();
 const blocked=f.store.task(task.id);assert.equal(blocked.status,'waiting_input');
 blocked.questions=[];blocked.status='queued';f.store.saveTask(blocked);await runner.tick();
 assert.equal(attempts,2);assert.equal(f.store.threads(task.id).at(-1).phase,'execute');
});

test('Full persisted plan → explicit approval → execution → independent review; original stays untouched',async t=>{const f=fixture(t);let calls=0;const runner=runnerFor(t,f,async o=>{calls++;assert.ok(!existsSync(join(o.cwd,'.env')));if(calls===1)return {result:plan,sessionId:'plan-session'};if(calls===2)writeFileSync(join(o.cwd,'result.md'),'Delivered');return {result:good,sessionId:'execution-session'};});const task=f.create();await runner.tick();assert.equal(f.store.task(task.id).status,'awaiting_approval');await runner.tick();assert.equal(calls,1);assert.throws(()=>approveTask(f.store,f.owner,task.id,0),/計畫已變更/);approveTask(f.store,f.owner,task.id,1);await runner.tick();assert.equal(f.store.task(task.id).status,'queued');await runner.tick();assert.equal(f.store.task(task.id).status,'completed');assert.equal(f.store.threads(task.id).length,3);assert.equal(readFileSync(join(f.source,'README.md'),'utf8'),'Original');assert.equal(existsSync(join(f.source,'result.md')),false);assert.ok(f.store.task(task.id).artifactVersion);});
test('Cross-member task access and project creation are denied',t=>{const f=fixture(t),task=f.create();assert.throws(()=>requireTask(f.store,f.other,task.id),/找不到/);assert.throws(()=>createTask(f.store,f.other,{title:'Intrusion',description:'Should be denied.',projectId:f.projectId,type:'code'}),/授權/);assert.equal(requireTask(f.store,f.admin,task.id).id,task.id);});
test('Questions wait for human; reply invalidates prior plan and approval',async t=>{const f=fixture(t),runner=runnerFor(t,f,async()=>({result:{...plan,questions:['哪個格式？']}})),task=f.create();await runner.tick();assert.equal(f.store.task(task.id).status,'waiting_input');const revised=reviseTask(f.store,f.owner,task.id,'使用 Markdown');assert.equal(revised.planVersion,2);assert.equal(revised.approvedVersion,null);assert.equal(revised.status,'planning');assert.throws(()=>approveTask(f.store,f.owner,task.id,1));});
test('Each failed review produces a read-only proposal and waits for separate approval before repair',async t=>{
 const f=fixture(t),seen=[];let reviews=0;const runner=runnerFor(t,f,async o=>{seen.push(o);if(o.readOnly)return {result:{...plan,summary:'問題：測試失敗；原因：邊界值未處理；解法：補上檢查'}};if(o.prompt.includes('你是 TaskFlow 的 獨立驗證')){reviews++;return {result:{...good,passed:reviews>=3,evidence:['boundary check failed']}};}return {result:good};});
 const task=f.create();await runner.tick();approveTask(f.store,f.owner,task.id,1);await runner.tick();await runner.tick();assert.equal(f.store.task(task.id).status,'repair_planning');
 for(let round=1;round<=2;round++){
  await runner.tick();let current=f.store.task(task.id);assert.equal(current.status,'awaiting_repair_approval');assert.equal(current.round,round);assert.equal(seen.at(-1).readOnly,true);assert.match(seen.at(-1).prompt,/嚴禁修改檔案/);
  const n=seen.length;await runner.tick();await runner.tick();assert.equal(seen.length,n);assert.throws(()=>approveRepair(f.store,f.other,task.id,current.repairPlan.id),/找不到/);assert.throws(()=>approveRepair(f.store,f.owner,task.id,'old'),/已變更/);
  changeTaskStatus(f.store,runner,f.owner,task.id,{status:'paused'});changeTaskStatus(f.store,runner,f.owner,task.id,{status:'reopen'});await runner.tick();assert.equal(f.store.task(task.id).status,'awaiting_repair_approval');assert.equal(seen.length,n);
  if(round===1){const old=current.repairPlan.id;reviseRepair(f.store,f.owner,task.id,old,'先補測試並保留既有行為');await runner.tick();current=f.store.task(task.id);assert.notEqual(current.repairPlan.id,old);assert.throws(()=>approveRepair(f.store,f.owner,task.id,old),/已變更/);assert.match(seen.at(-1).prompt,/先補測試/);}
  approveRepair(f.store,f.owner,task.id,current.repairPlan.id);assert.throws(()=>approveRepair(f.store,f.owner,task.id,current.repairPlan.id),/待審核/);await runner.tick();assert.equal(seen.at(-1).readOnly,false);assert.match(seen.at(-1).prompt,/已核准修正方案/);await runner.tick();
 }
 assert.equal(f.store.task(task.id).status,'completed');assert.equal(f.store.threads(task.id).filter(x=>x.phase==='execute').length,1);assert.equal(f.store.threads(task.id).filter(x=>x.phase==='repair').length,2);
});
test('Only ready tasks are selected; priority wins and paused task stays paused',async t=>{const f=fixture(t),seen=[];const runner=runnerFor(t,f,async o=>{seen.push(o.prompt);return {result:plan};});const low=f.create({title:'Low task',priority:0}),high=f.create({title:'High task',priority:3}),paused=f.create({title:'Paused task',priority:3});paused.status='paused';f.store.saveTask(paused);await runner.tick();assert.ok(seen[0].includes('High task'));assert.equal(f.store.task(low.id).status,'planning');assert.equal(f.store.task(high.id).status,'awaiting_approval');assert.equal(f.store.task(paused.id).status,'paused');});
test('Engine error becomes visible failure; no endless retry',async t=>{const f=fixture(t);let n=0;const runner=runnerFor(t,f,async()=>{n++;throw new Error('Quota exhausted');}),task=f.create();await runner.tick();await runner.tick();assert.equal(n,1);assert.equal(f.store.task(task.id).error,'Quota exhausted');assert.equal(f.store.threads(task.id)[0].status,'failed');});
test('Restart pauses interrupted work instead of silently rerunning it',t=>{const f=fixture(t),task=f.create();task.status='running';f.store.saveTask(task);f.store.saveThread({id:id(),taskId:task.id,status:'running',version:1});const runner=createRunner(f.store,{dataDir:join(f.dir,'runs')});t.after(()=>runner.stop());assert.equal(f.store.task(task.id).status,'paused');assert.equal(f.store.threads(task.id)[0].status,'failed');});
test('LINE redelivery creates exactly one task and outbox message',t=>{const f=fixture(t),lineId='U'+'a'.repeat(32);f.store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,f.owner.id);const event={webhookEventId:'line-event-1',type:'message',source:{type:'user',userId:lineId},message:{type:'text',text:'/task demo My task\nPlease create a report.'}};assert.equal(processLine(f.store,event),true);assert.equal(processLine(f.store,event),false);assert.equal(f.store.tasks().length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);});
test('LINE link token is single-use and group messages cannot create tasks',t=>{const f=fixture(t),lineId='U'+'b'.repeat(32);f.store.db.prepare('UPDATE users SET link_hash=?,link_expires=? WHERE id=?').run(hash('one-time'),Date.now()+60000,f.owner.id);processLine(f.store,{webhookEventId:'link1',type:'message',source:{type:'user',userId:lineId},message:{type:'text',text:'/link one-time'}});assert.equal(f.store.user(f.owner.id).line_id,lineId);assert.equal(f.store.db.prepare('SELECT link_hash FROM users WHERE id=?').get(f.owner.id).link_hash,null);processLine(f.store,{webhookEventId:'group1',type:'message',source:{type:'group',userId:lineId},message:{type:'text',text:'/task demo My task\nSomething to do'}});assert.equal(f.store.tasks().length,0);});
test('HTTP authentication, CSRF, ACL, task persistence, priority and cancel transitions',async t=>{const f=fixture(t),runner={status:{busy:false,activeTaskId:null},stopTask:()=>{}},app=createApp(f.store,runner,{dist:join(f.dir,'absent')}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}/api`;let cookie='';const request=(path,body,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)});assert.equal((await request('/state')).status,401);assert.equal((await request('/login',{username:'owner',password:'password-owner-123'},{origin:'https://evil.example'})).status,403);const auth=await request('/login',{username:'owner',password:'password-owner-123'});assert.equal(auth.status,200);cookie=auth.headers.get('set-cookie').split(';')[0];const created=await request('/tasks',{title:'HTTP task',description:'Create from real API.',projectId:f.projectId,type:'code'});assert.equal(created.status,201);const task=await created.json();assert.equal((await request('/admin/runner',{enabled:true})).status,403);assert.equal((await request(`/tasks/${task.id}/approve`,{version:1})).status,409);assert.equal((await request(`/tasks/${task.id}/priority`,{priority:3})).status,200);await request(`/tasks/${task.id}/action`,{action:'pause'});assert.equal(f.store.task(task.id).status,'paused');await request(`/tasks/${task.id}/action`,{action:'resume'});assert.equal(f.store.task(task.id).status,'planning');await request(`/tasks/${task.id}/action`,{action:'cancel'});assert.equal(f.store.task(task.id).status,'cancelled');assert.equal((await request(`/tasks/${task.id}/action`,{action:'resume'})).status,409);assert.equal((await request('/state')).status,200);});

test('Concurrency fills slots, never duplicates a task, and changes limits without interrupting work',async t=>{
  const f=fixture(t),pending=[];
  const runner=runnerFor(t,f,()=>new Promise(resolve=>pending.push(resolve)));
  for(let i=0;i<5;i++)f.create({title:`Concurrent ${i}`});
  const first=runner.tick();assert.equal(pending.length,1);
  f.store.setSetting('runnerMaxConcurrent',3);
  const second=runner.tick();assert.equal(pending.length,3);
  assert.equal(new Set(runner.status.activeTaskIds).size,3);
  await runner.tick();assert.equal(pending.length,3);
  f.store.setSetting('runnerMaxConcurrent',1);
  pending[0]({result:plan});await first;
  await runner.tick();assert.equal(pending.length,3);assert.equal(runner.status.activeCount,2);
  pending[1]({result:plan});pending[2]({result:plan});await second;
  const third=runner.tick();assert.equal(pending.length,4);
  f.store.setSetting('runnerEnabled',false);await runner.tick();assert.equal(pending.length,4);
  pending[3]({result:plan});await third;assert.equal(runner.status.activeCount,0);
});

test('Runner settings validate atomically, persist, and require admin',async t=>{
  const f=fixture(t),runner={status:{busy:false,activeTaskId:null,activeTaskIds:[]}},server=createApp(f.store,runner,{dist:join(f.dir,'absent')}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}/api`;let cookie='';
  const request=(path,body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});
  for(const username of ['owner','admin']){
    const auth=await request('/login',{username,password:`password-${username}-123`});cookie=auth.headers.get('set-cookie').split(';')[0];
    if(username==='owner'){assert.equal((await request('/admin/runner',{maxConcurrent:3})).status,403);continue;}
    assert.equal((await (await request('/state')).json()).runner.maxConcurrent,1);
    for(const maxConcurrent of [0,33,1.5,'2',null])assert.equal((await request('/admin/runner',{enabled:true,maxConcurrent})).status,400);
    assert.equal(f.store.setting('runnerEnabled',false),false);
    assert.equal((await request('/admin/runner',{maxConcurrent:4})).status,200);
    assert.equal((await (await request('/state')).json()).runner.maxConcurrent,4);
    const reopened=createStore(join(f.dir,'db.sqlite'));assert.equal(reopened.setting('runnerMaxConcurrent'),4);reopened.close();
  }
});

test('Repair proposals with questions cannot be approved, and LINE approval binds the viewed proposal',async t=>{
 const f=fixture(t),runner=runnerFor(t,f,async()=>({result:plan})),task=f.create();task.plan=plan;task.approvedVersion=1;task.round=1;task.validationFailure={summary:'Failed check',evidence:['assert failed'],questions:[]};task.status='awaiting_repair_approval';task.repairPlan={...plan,id:id(),round:1,planVersion:1,questions:['Which boundary?']};f.store.saveTask(task);
 assert.throws(()=>approveRepair(f.store,f.owner,task.id,task.repairPlan.id),/待確認/);task.repairPlan.questions=[];f.store.saveTask(task);
 const lineId='U'+'e'.repeat(32);f.store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,f.owner.id);
 const send=(text,postback=false)=>processLine(f.store,{webhookEventId:id(),type:postback?'postback':'message',source:{type:'user',userId:lineId},...(postback?{postback:{data:text}}:{message:{type:'text',text}})});
 send('核准修正方案');assert.equal(f.store.task(task.id).status,'awaiting_repair_approval');send('tf:view:'+task.id,true);const old=task.repairPlan.id;task.repairPlan.id=id();f.store.saveTask(task);send('核准修正方案');assert.equal(f.store.task(task.id).status,'awaiting_repair_approval');send('tf:view:'+task.id,true);send('核准修正方案');assert.equal(f.store.task(task.id).approvedRepairId,task.repairPlan.id);assert.equal(f.store.task(task.id).status,'queued');
});

test('Answer keeps question context and existing work; repeated planning question is checked once',async t=>{
 const f=fixture(t);let calls=0;const seen=[];
 const question='是否僅以瀏覽器模擬驗證？';
 const runner=runnerFor(t,f,async o=>{seen.push(o);calls++;return {result:calls===1||calls===2?{...plan,questions:[question]}:plan};});
 const task=f.create();await runner.tick();const workspace=f.store.task(task.id).workspace;writeFileSync(join(workspace,'retained.md'),'existing work');
 reviseTask(f.store,f.owner,task.id,'是，僅用瀏覽器模擬');
 assert.equal(f.store.task(task.id).workspace,workspace);
 assert.deepEqual(f.store.task(task.id).clarifications[0].questions,[question]);
 await runner.tick();assert.equal(calls,3);assert.ok(seen[1].prompt.includes('是，僅用瀏覽器模擬'));assert.ok(seen[2].readOnly);assert.ok(seen[2].runDir.endsWith('question-check'));
 assert.equal(readFileSync(join(workspace,'retained.md'),'utf8'),'existing work');assert.equal(f.store.task(task.id).status,'awaiting_approval');assert.equal(f.store.task(task.id).approvedVersion,null);
});

test('Legacy short answers regain paired questions; new unresolved questions remain blocked without retry loop',async t=>{
 const f=fixture(t),task=f.create();const {clarificationHistory}=await import('../server/clarifications.js');
 task.description+='\n\n補充需求：允許';task.planVersion=2;f.store.saveTask(task);
 f.store.saveThread({id:id(),taskId:task.id,version:1,status:'completed',phase:'plan',result:{...plan,questions:['允許使用裝置模擬嗎？']}});
 assert.deepEqual(clarificationHistory(task,f.store.threads(task.id))[0].questions,['允許使用裝置模擬嗎？']);
 let calls=0;const runner=runnerFor(t,f,async o=>{calls++;assert.ok(o.prompt.includes('允許使用裝置模擬嗎？'));return {result:{...plan,questions:['新需求需要哪個私人資料集？']}};});
 await runner.tick();assert.equal(calls,2);assert.equal(f.store.task(task.id).status,'waiting_input');await runner.tick();assert.equal(calls,2);
 assert.throws(()=>approveTask(f.store,f.owner,task.id,2));
});
