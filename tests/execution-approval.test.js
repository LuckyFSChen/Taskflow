import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
import {createTask} from '../server/domain.js';
import {executionApproval,decideExecutionApproval} from '../server/execution-approval.js';
import {createRunner} from '../server/runner.js';
import {handleLineUI} from '../server/line-ui.js';
function fixture(t,phase='execute'){
 const root=mkdtempSync(join(tmpdir(),'tf-approval-')),s=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);
 const u=s.addUser('Owner','owner','test-password'),other=s.addUser('Other','other','test-password'),pid=id();s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
 const task=createTask(s,u,{title:'Approval test',description:'Continue original work',projectId:pid,type:'research'});
 Object.assign(task,{status:'waiting_input',workspace:source,plan:{summary:'Original',acceptance:['done'],questions:[],steps:[{title:'Original step',role:'Author',instructions:'Continue work'}]},approvedVersion:1,questions:['是否核准調整套件版本並執行測試？']});
 if(phase==='repair'){task.round=1;task.repairPlan={id:'repair',round:1,planVersion:1,steps:[]};task.approvedRepairId='repair';}
 s.saveTask(task);s.saveThread({id:id(),taskId:task.id,version:1,phase,round:task.round,status:'completed',result:{passed:false,questions:task.questions}});
 t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return {s,u,other,task,root};
}
for(const phase of ['execute','repair'])test(`Approval resumes same ${phase}, preserves plan and injects decision`,async t=>{
 const f=fixture(t,phase),request=executionApproval(f.s,f.task);
 const result=decideExecutionApproval(f.s,f.u,f.task.id,{requestId:request.id,decision:'approve'});
 assert.equal(result.planVersion,1);assert.equal(result.approvedVersion,1);assert.equal(result.workspace,f.task.workspace);assert.deepEqual(result.plan,f.task.plan);
 assert.throws(()=>decideExecutionApproval(f.s,f.u,f.task.id,{requestId:request.id,decision:'approve'}),{status:409});
 let prompt;f.s.setSetting('runnerEnabled',true);const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async options=>{prompt=options.prompt;return {result:{summary:'done',questions:[],passed:true,artifacts:[],evidence:['checked']}};}});
 try{await runner.tick();assert.equal(f.s.threads(f.task.id).at(-1).phase,phase);assert.match(prompt,/核准上述操作/);}finally{runner.stop();}
});
test('Rejection pauses; ownership, stale requests and unrelated questions are protected',t=>{
 const f=fixture(t),request=executionApproval(f.s,f.task);
 assert.throws(()=>decideExecutionApproval(f.s,f.other,f.task.id,{requestId:request.id,decision:'approve'}),{status:404});
 assert.throws(()=>decideExecutionApproval(f.s,f.u,f.task.id,{requestId:'stale',decision:'approve'}),{status:409});
 const result=decideExecutionApproval(f.s,f.u,f.task.id,{requestId:request.id,decision:'reject'});
 assert.equal(result.status,'paused');assert.equal(result.planVersion,1);assert.match(result.clarifications.at(-1).answer,/不得執行/);
 for(const change of [{environmentIssue:{}},{status:'awaiting_approval'},{questions:['請提供網址']}])assert.equal(executionApproval(f.s,{...f.task,...change}),null);
});
test('LINE offers direct choices and rejects old buttons after a decision',t=>{
 const f=fixture(t),send=data=>handleLineUI(f.s,f.u,'test-line',{data});
 const last=()=>JSON.parse(f.s.db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').get().payload)[0];
 send(`tf:view:${f.task.id}`);assert.match(last().text,/是否核准調整/);
 const buttons=last().quickReply.items.map(i=>i.action),approve=buttons.find(b=>b.label==='核准並繼續').data;
 assert.ok(buttons.find(b=>b.label==='不核准，暫停任務'));send(approve);assert.equal(f.s.task(f.task.id).status,'queued');send(approve);assert.match(last().text,/失效/);assert.equal(f.s.task(f.task.id).planVersion,1);
});
test('HTTP returns pending approval and applies a decision without revising the plan',async t=>{
 const f=fixture(t);f.s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('approval-session'),f.u.id,Date.now()+60000);
 const server=createApp(f.s,{status:{}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
   const base=`http://127.0.0.1:${server.address().port}/api/tasks/${f.task.id}`,headers={cookie:'tf_session=approval-session','Content-Type':'application/json'};
   const detail=await (await fetch(base,{headers})).json();assert.ok(detail.executionApproval.id);
   const body=JSON.stringify({requestId:detail.executionApproval.id,decision:'approve'});
   const response=await fetch(base+'/execution/decision',{method:'POST',headers,body});assert.equal(response.status,200);
   const updated=await response.json();assert.equal(updated.status,'queued');assert.equal(updated.planVersion,1);assert.equal(updated.executionApproval,null);
   assert.equal((await fetch(base+'/execution/decision',{method:'POST',headers,body})).status,409);
 }finally{await new Promise(r=>server.close(r));}
});
