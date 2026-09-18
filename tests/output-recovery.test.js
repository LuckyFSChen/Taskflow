import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createTask,approveTask,planSchema,planJson,resultSchema,resultJson} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {createApp} from '../server/app.js';
import {changeTaskStatus} from '../server/task-status.js';
import {validatedOutput} from '../server/output-validation.js';
import {defaultBrowserValidation} from '../server/browser-capability.js';
import {defaultManualAction} from '../server/domain.js';
const plan={summary:'新增上傳套件',acceptance:['完成上傳'],questions:[],steps:[{title:'安裝套件',role:'工程',instructions:'使用已核准的 multer'}]};
const good={summary:'完成',questions:[],artifacts:[],passed:true,evidence:['checked']};
function fixture(t,cleanup=true){const dir=mkdtempSync(join(tmpdir(),'tf-output-'));if(cleanup)t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('Two lossless format passes preserve content and never repeat adapter execution',async t=>{
 const dir=fixture(t);let calls=0;
 const result=await validatedOutput(async()=>{calls++;return {result:{output:{...good,passed:'true',evidence:'checked'}}};},{runDir:dir,schema:resultJson},resultSchema);
 assert.equal(calls,1);assert.deepEqual(result.result,{...good,browserValidation:defaultBrowserValidation(),userActionRequired:defaultManualAction()});assert.ok(readFileSync(join(dir,'original-output.json'),'utf8').includes('output'));assert.ok(readdirSync(dir).includes('format-repair-2.json'));
});
test('Missing content fails closed after two passes, with named fields and original evidence',async t=>{
 const dir=fixture(t);let calls=0;
 await assert.rejects(validatedOutput(async()=>{calls++;const e=new Error('schema error');e.code='OUTPUT_FORMAT';e.rawResult={summary:'only summary'};e.sessionId='original-session';throw e;},{runDir:dir,schema:planJson},planSchema),e=>e.code==='OUTPUT_FORMAT'&&e.sessionId==='original-session'&&/acceptance/.test(e.message)&&/questions/.test(e.message)&&/steps/.test(e.message));
 assert.equal(calls,1);assert.equal(readdirSync(dir).filter(x=>x.startsWith('format-repair')).length,2);assert.doesNotMatch(readFileSync(join(dir,'format-repair-2.json'),'utf8'),/acceptance/);
});
test('A result missing questions/artifacts/passed is safely repaired with defaults, without inventing summary or evidence',async t=>{
 const dir=fixture(t);let calls=0;
 const result=await validatedOutput(async()=>{calls++;return {result:{summary:'Ran npm run build and it succeeded',evidence:['npm run build: exit 0']}};},{runDir:dir,schema:resultJson},resultSchema);
 assert.equal(calls,1,'format repair must never re-invoke the adapter/engine');
 assert.deepEqual(result.result,{summary:'Ran npm run build and it succeeded',evidence:['npm run build: exit 0'],questions:[],artifacts:[],passed:false,browserValidation:defaultBrowserValidation(),userActionRequired:defaultManualAction()});
 assert.ok(readdirSync(dir).includes('format-repair-3.json'),'the third, defaults-filling repair pass must have run');
 const original=JSON.parse(readFileSync(join(dir,'original-output.json'),'utf8'));
 assert.deepEqual(original.result,{summary:'Ran npm run build and it succeeded',evidence:['npm run build: exit 0']},'the raw pre-repair command/tool evidence must be preserved untouched');
});
test('A plan missing steps is never defaulted to an empty plan — the third result-only repair pass never applies to the plan schema',async t=>{
 const dir=fixture(t);let calls=0;
 await assert.rejects(validatedOutput(async()=>{calls++;return {result:{summary:'plan without steps',acceptance:['done'],questions:[]}};},{runDir:dir,schema:planJson},planSchema),e=>e.code==='OUTPUT_FORMAT'&&/steps/.test(e.message));
 assert.equal(calls,1);
 assert.equal(readdirSync(dir).filter(x=>x.startsWith('format-repair')).length,2,'the plan schema must keep exactly the two lossless structural passes, never the result-only defaults pass');
});
test('Non-format and quota failures do not trigger repairs or repeat work',async t=>{
 const dir=fixture(t);let calls=0;await assert.rejects(validatedOutput(async()=>{calls++;throw Error('session limit');},{runDir:dir,schema:planJson},planSchema),/session limit/);assert.equal(calls,1);assert.equal(readdirSync(dir).length,0);
});
test('Preflight blocks mutation until explicit owner approval and recheck, preserving task progress',async t=>{
 const dir=fixture(t,false),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});const owner=s.addUser('Owner','owner','test-password'),other=s.addUser('Other','other','test-password');const source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'package.json'),'{}');const pid=id();s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id,pid);
 let probes=0,executions=0;let ready=false;
 const runner=createRunner(s,{recover:false,dataDir:join(dir,'runtime'),adapter:async options=>{
   if(options.preflight){probes++;assert.equal(options.readOnly,false);return {result:{summary:'registry probe',toolAvailable:true,registryReachable:ready,installationAllowed:ready,evidence:['npm ping: '+(ready?'ok':'blocked')]}};}
   if(options.readOnly)return {result:plan};executions++;return {result:good};
 }});t.after(()=>runner.stop());s.setSetting('runnerEnabled',true);
 const task=createTask(s,owner,{title:'上傳圖片',description:'新增已核准的上傳功能',projectId:pid,type:'code'});await runner.tick();approveTask(s,owner,task.id,1);await runner.tick();
 const blocked=s.task(task.id);assert.equal(blocked.status,'waiting_input');assert.ok(blocked.environmentIssue);assert.equal(executions,0);assert.equal(blocked.approvedVersion,1);
 await runner.tick();assert.equal(probes,1);assert.throws(()=>changeTaskStatus(s,runner,owner,task.id,{status:'reopen'}),/審核/);
 const app=createApp(s,runner,{dist:source});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 for(const u of [owner,other])s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(u.id),u.id,Date.now()+60000);
 const retry=(u,issueId)=>fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${task.id}/preflight/retry`,{method:'POST',headers:{cookie:'tf_session='+u.id,'Content-Type':'application/json'},body:JSON.stringify({issueId})});
 assert.equal((await retry(other,blocked.environmentIssue.id)).status,404);assert.equal((await retry(owner,'stale')).status,409);
 ready=true;assert.equal((await retry(owner,blocked.environmentIssue.id)).status,200);assert.equal((await retry(owner,blocked.environmentIssue.id)).status,409);await runner.tick();assert.equal(probes,2);assert.equal(executions,1);assert.equal(s.task(task.id).status,'queued');
});
test('Format failure after a mutation retains the workspace and cannot auto-replay on resume',async t=>{
 const dir=fixture(t,false),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});const u=s.addUser('Owner','owner','test-password'),pid=id(),source=join(dir,'source');mkdirSync(source);s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
 let calls=0;const runner=createRunner(s,{recover:false,dataDir:join(dir,'runtime'),adapter:async o=>{if(o.readOnly)return {result:{...plan,steps:[{title:'建立文件',role:'作者',instructions:'寫入文件'}]}};calls++;writeFileSync(join(o.cwd,'kept.txt'),'finished work');return {result:{summary:'completed but malformed'}};}});t.after(()=>runner.stop());s.setSetting('runnerEnabled',true);
 const task=createTask(s,u,{title:'文件工作',description:'完成文件並驗證',projectId:pid,type:'research'});await runner.tick();approveTask(s,u,task.id,1);await runner.tick();const current=s.task(task.id);assert.ok(current.outputIssue);assert.equal(current.status,'waiting_input');assert.equal(readFileSync(join(current.workspace,'kept.txt'),'utf8'),'finished work');await runner.tick();assert.equal(calls,1);assert.throws(()=>changeTaskStatus(s,runner,u,task.id,{status:'reopen'}),/審核/);
});
