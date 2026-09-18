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

// ===== Phase 4：Deterministic Result Recovery =========================================
// Recovery 只處理已經存在的 raw output。它沒有 adapter，因此結構上不可能重跑 AI；
// 下面的測試除了驗證擷取規則，也直接守住「不重新執行工作」這條紅線。
import {deterministicResultRecovery,recoverFormatFailure,extractEvidence,extractArtifacts,recoverPassed,RECOVERABLE_PHASES} from '../server/output-recovery.js';
const complete={summary:'完成上傳功能',questions:[],artifacts:['src/Upload.vue'],passed:true,evidence:['npm run build 通過']};
const formatError=(candidate,extra={})=>Object.assign(new Error('AI 回傳格式仍不完整'),{code:'OUTPUT_FORMAT',candidate,issues:['artifacts：Required'],...extra});

// --- Case 1：完整 Result 不改 ---------------------------------------------------------
test('Case 1：完整的 Result 原樣保留，不被 Recovery 改寫',()=>{
  const recovery=deterministicResultRecovery(structuredClone(complete));
  assert.equal(recovery.ok,true);
  assert.equal(recovery.source,'structured');
  assert.equal(recovery.result.summary,'完成上傳功能');
  assert.deepEqual(recovery.result.artifacts,['src/Upload.vue']);
  assert.deepEqual(recovery.result.evidence,['npm run build 通過']);
  assert.equal(recovery.result.passed,true,'原始輸出本來就有可信的 passed 時必須沿用');
  assert.deepEqual(recovery.notes,[]);
});

// --- Case 2：缺 questions／artifacts／passed 安全補值 ----------------------------------
test('Case 2：缺少 questions／artifacts／passed 時安全補值，summary 與 evidence 不動',()=>{
  const recovery=deterministicResultRecovery({summary:'完成上傳功能',evidence:['npm test 通過']});
  assert.equal(recovery.ok,true);
  assert.deepEqual(recovery.result.questions,[]);
  assert.deepEqual(recovery.result.evidence,['npm test 通過'],'既有的 evidence 必須原樣保留');
  assert.equal(recovery.result.passed,false,'缺少 passed 時一律 false');
  assert.equal(recovery.result.summary,'完成上傳功能');
  assert.ok(recovery.notes.some(n=>n.includes('questions')));
});

test('Case 2b：明確的空陣列被視為原始輸出的事實，不會再從文字補內容',()=>{
  const recovery=deterministicResultRecovery({summary:'修改 src/App.vue。npm run build 通過。',questions:[],artifacts:[],evidence:[],passed:false});
  assert.deepEqual(recovery.result.artifacts,[]);
  assert.deepEqual(recovery.result.evidence,[]);
});

// --- Case 3：純文字輸出可還原 artifact／evidence／passed -------------------------------
test('Case 3：純文字輸出能還原 artifact 與 evidence，passed 仍為 false',()=>{
  const recovery=deterministicResultRecovery('修改 src/App.vue。npm run build 通過。');
  assert.equal(recovery.ok,true);
  assert.equal(recovery.source,'text');
  assert.equal(recovery.result.summary,'修改 src/App.vue。npm run build 通過。');
  assert.deepEqual(recovery.result.artifacts,['src/App.vue']);
  assert.deepEqual(recovery.result.evidence,['npm run build 通過']);
  assert.equal(recovery.result.passed,false);
});

test('Case 3b：evidence 只取得指令與結果的敘述，測試數量的敘述也算',()=>{
  assert.deepEqual(extractEvidence('npm run build 通過'),['npm run build 通過']);
  assert.deepEqual(extractEvidence('21 tests passed'),['21 tests passed']);
  assert.deepEqual(extractEvidence('phpunit: OK'),['phpunit: OK']);
  assert.deepEqual(extractEvidence('npm test 失敗，3 個錯誤'),['npm test 失敗，3 個錯誤']);
});

test('Case 3c：artifacts 只認得原始輸出裡明確寫出的檔案路徑',()=>{
  assert.deepEqual(extractArtifacts('修改 src/App.vue 與 server/app.js'),['src/App.vue','server/app.js']);
  assert.deepEqual(extractArtifacts('Updated server/app.js.'),['server/app.js'],'句末句點不應併入路徑');
  assert.deepEqual(extractArtifacts('已更新 package.json'),[],'沒有目錄結構的字詞不視為路徑');
  assert.deepEqual(extractArtifacts('部署到 https://example.com/app/main.js'),[],'網址不是工作副本的成果檔案');
  assert.deepEqual(extractArtifacts('修改 src/App.vue。修改 src/App.vue。'),['src/App.vue'],'重複路徑只列一次');
});

// --- Case 4：無 Evidence 不得創造 Evidence --------------------------------------------
test('Case 4：看到「修改完成」不得生出任何 evidence，且整筆 Recovery 失敗交由人審核',()=>{
  const recovery=deterministicResultRecovery('修改完成。已經處理好了。工作完成。');
  // 最容易出錯的地方：把「完成」腦補成「npm run build 通過」。
  assert.doesNotMatch(JSON.stringify(recovery),/npm run build/);
  assert.equal(recovery.ok,false,'宣稱做完卻拿不出任何證據時必須 fail closed');
  assert.match(recovery.reason,/不得創造 evidence/);
  assert.equal(recovery.result,undefined);
});

test('Case 4b：原始輸出自己給了空的 evidence 陣列時沿用，不另行編造',()=>{
  const recovery=deterministicResultRecovery({summary:'修改完成',evidence:[],questions:[],artifacts:[]});
  assert.equal(recovery.ok,true);
  assert.deepEqual(recovery.result.evidence,[]);
  assert.equal(recovery.result.passed,false);
});

test('Case 4c：只有結果詞或只有指令都不算證據',()=>{
  assert.deepEqual(extractEvidence('全部完成'),[]);
  assert.deepEqual(extractEvidence('接下來要執行 npm run build'),[],'只提到指令、沒有結果不算證據');
});

// --- Case 5：無 Summary，Recovery 必須失敗 --------------------------------------------
test('Case 5：找不到 summary 時 Recovery 失敗，不自行虛構摘要',()=>{
  for(const raw of [{questions:[],artifacts:['a/b.js'],passed:true,evidence:['npm test 通過']},'   ','',null,undefined,{summary:'   '}]){
    const recovery=deterministicResultRecovery(raw);
    assert.equal(recovery.ok,false,`${JSON.stringify(raw)} 不應被還原`);
    assert.match(recovery.reason,/summary/);
    assert.equal(recovery.result,undefined);
  }
});

// --- Case 9：passed 絕不由文字推論 ----------------------------------------------------
test('passed 只沿用原始輸出本身的布林值，其餘一律 false',()=>{
  assert.equal(recoverPassed({passed:true}),true);
  assert.equal(recoverPassed({passed:'true'}),true,'字串 true 是無損轉換，與既有 normalize 一致');
  assert.equal(recoverPassed({passed:false}),false);
  assert.equal(recoverPassed({passed:'完成'}),false);
  assert.equal(recoverPassed({passed:1}),false);
  assert.equal(recoverPassed({}),false);
  assert.equal(recoverPassed('工作完成，全部通過'),false,'純文字永遠不可能推論出 passed=true');
  // 即使文字同時宣稱完成、又帶著真實證據，passed 仍然不得由文字推論。
  assert.equal(deterministicResultRecovery('全部工作已完成，驗收通過。npm test 通過。').result.passed,false);
});

// --- 進入點與適用範圍 ------------------------------------------------------------------
test('只有 execute／repair／review 會套用 Recovery；計畫階段維持 Output Issue',()=>{
  assert.deepEqual(RECOVERABLE_PHASES,['execute','repair','review']);
  for(const phase of ['plan','repair_plan']){
    const outcome=recoverFormatFailure(formatError({summary:'計畫摘要'}),{phase});
    assert.equal(outcome.ok,false);
    assert.match(outcome.reason,/不套用 Result Recovery/);
  }
  assert.equal(recoverFormatFailure(formatError({summary:'完成',evidence:['npm test 通過']}),{phase:'execute'}).ok,true);
});

test('非格式問題（例如額度或執行失敗）完全不進入 Recovery',()=>{
  const outcome=recoverFormatFailure(Object.assign(new Error('session limit reached'),{code:undefined}),{phase:'execute'});
  assert.equal(outcome.ok,false);
  assert.match(outcome.reason,/不是輸出格式問題/);
});

test('Recovery 會保存 recovered-output.json 以便追查，失敗時也保存',async t=>{
  const dir=fixture(t);
  const success=recoverFormatFailure(formatError('修改 src/App.vue。npm run build 通過。'),{phase:'execute',runDir:join(dir,'ok')});
  assert.equal(success.ok,true);
  const saved=JSON.parse(readFileSync(join(dir,'ok','recovered-output.json'),'utf8'));
  assert.equal(saved.ok,true);
  assert.deepEqual(saved.result.artifacts,['src/App.vue']);
  assert.deepEqual(saved.issues,['artifacts：Required'],'原始的 schema 問題一併保存');
  const failed=recoverFormatFailure(formatError({questions:[]}),{phase:'execute',runDir:join(dir,'failed')});   // 沒有 summary
  assert.equal(failed.ok,false);
  assert.equal(JSON.parse(readFileSync(join(dir,'failed','recovered-output.json'),'utf8')).ok,false);
});

// --- Case 6：Recovery 不得重新呼叫 Agent ----------------------------------------------
test('Case 6：格式失敗後由 Recovery 接手，Executor 只被呼叫一次且不重跑',async t=>{
  const dir=fixture(t,false),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const u=s.addUser('Owner','owner','test-password'),pid=id(),source=join(dir,'source');mkdirSync(source);
  s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);
  s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
  let plans=0,executions=0;
  const runner=createRunner(s,{recover:false,dataDir:join(dir,'runtime'),adapter:async o=>{
    if(o.readOnly){plans++;return {result:{...plan,steps:[{title:'建立文件',role:'作者',instructions:'寫入文件'}]}};}
    executions++;
    // 少了 questions／artifacts／passed 的壞輸出：既有的補值救不了 artifacts 之外的
    // 結構問題時，Recovery 必須接手，而不是再跑一次工作。
    return {result:{summary:'修改 src/App.vue。npm run build 通過。',artifacts:'src/App.vue',evidence:null}};
  }});
  t.after(()=>runner.stop());s.setSetting('runnerEnabled',true);
  const task=createTask(s,u,{title:'文件工作',description:'完成文件並驗證',projectId:pid,type:'research'});
  await runner.tick();approveTask(s,u,task.id,1);await runner.tick();
  assert.equal(executions,1,'Recovery 絕不能重新呼叫 Executor');
  const after=s.task(task.id);
  assert.equal(after.outputIssue,undefined,'成功還原後不應再建立 Output Issue');
  const executed=s.threads(task.id).find(th=>th.phase==='execute');
  assert.equal(executed.status,'completed');
  assert.equal(executed.result.passed,false,'還原的結果一律 passed=false');
  assert.deepEqual(executed.result.evidence,['npm run build 通過']);
  assert.ok(s.events(task.id).some(e=>e.kind==='output_recovered'),'還原必須留下可追查的事件');
  await runner.tick();
  assert.equal(executions,1,'後續 tick 也不得重跑已經還原的步驟');
  assert.equal(plans,1);
});

test('無法還原時維持原本的 Output Issue，而且不重跑工作',async t=>{
  const dir=fixture(t,false),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const u=s.addUser('Owner','owner','test-password'),pid=id(),source=join(dir,'source');mkdirSync(source);
  s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);
  s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
  let executions=0;
  const runner=createRunner(s,{recover:false,dataDir:join(dir,'runtime'),adapter:async o=>{
    if(o.readOnly)return {result:{...plan,steps:[{title:'建立文件',role:'作者',instructions:'寫入文件'}]}};
    executions++;return {result:{questions:[],artifacts:[]}};   // 沒有 summary
  }});
  t.after(()=>runner.stop());s.setSetting('runnerEnabled',true);
  const task=createTask(s,u,{title:'文件工作',description:'完成文件並驗證',projectId:pid,type:'research'});
  await runner.tick();approveTask(s,u,task.id,1);await runner.tick();
  const after=s.task(task.id);
  assert.ok(after.outputIssue,'summary 都沒有的輸出必須維持 Output Issue');
  assert.equal(after.status,'waiting_input');
  assert.equal(executions,1);
  await runner.tick();
  assert.equal(executions,1,'Output Issue 待審核期間不得自動重跑');
});

// ===== Phase 5：Output Recovery UI 與人工處理流程 =====================================
// 使用者按下「重新整理成果報告」時，TaskFlow 只能重讀已經存在的原始回傳。
// 下面的測試除了驗證流程，也直接守住「不呼叫 Agent、不重跑已完成工作」這條紅線。
import {createApp as createAppForOutput} from '../server/app.js';
import {outputIssueRecoverable,recoveryCandidate,originalOutput} from '../server/output-issue.js';

// 一個已經停在 Output Issue 的任務（例如 Phase 4 之前留下的紀錄）：計畫已核准、
// 工作副本與執行紀錄都在，只有成果報告的格式不完整。
function stuckTask(t,{raw,phase='execute',plan:taskPlan=plan,type='research'}){
  const dir=mkdtempSync(join(tmpdir(),'tf-output5-'));
  const s=createStore(join(dir,'db.sqlite'));
  const owner=s.addUser('Owner','owner','test-password'),other=s.addUser('Other','other','test-password');
  const source=join(dir,'source');mkdirSync(source);
  const pid=id();
  s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);
  s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id,pid);
  let adapterCalls=0;
  const runner=createRunner(s,{recover:false,dataDir:join(dir,'runtime'),adapter:async o=>{
    adapterCalls++;
    if(o.readOnly)return {result:taskPlan};
    return {result:{...good,summary:`${phase} 重跑`}};
  }});
  const task=createTask(s,owner,{title:'文件工作',description:'完成文件並驗證',projectId:pid,type});
  task.plan=taskPlan;task.approvedVersion=1;task.status='waiting_input';
  task.workspace=join(dir,'runtime','workspaces',task.id,'v1');mkdirSync(task.workspace,{recursive:true});
  const runDir=join(dir,'runtime','runs','thread-1');
  mkdirSync(runDir,{recursive:true});
  writeFileSync(join(runDir,'original-output.json'),JSON.stringify({result:raw,error:'AI 回傳格式仍不完整',sessionId:'session-1'}));
  const thread={id:'thread-1',taskId:task.id,version:1,round:0,phase,engine:'codex',role:phase==='review'?'獨立驗證':'作者',title:'建立文件',status:'failed',started:'2026-01-01T00:00:00.000Z',finished:'2026-01-01T00:05:00.000Z',summary:null,result:null,sessionId:'session-1',error:'AI 回傳格式仍不完整'};
  s.saveThread(thread);
  task.outputIssue={id:'issue-1',threadId:thread.id,phase,planVersion:1,message:'AI 回傳格式仍不完整\nquestions：Required',at:'2026-01-01T00:05:00.000Z',issues:['questions：Required'],runDir,recovery:null};
  s.saveTask(task);
  const app=createAppForOutput(s,runner,{dist:join(dir,'no-dist')});
  const server=app.listen(0,'127.0.0.1');
  for(const u of [owner,other])s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(u.id),u.id,Date.now()+60000);
  t.after(()=>new Promise(r=>server.close(r)));
  t.after(()=>runner.stop());
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const ready=new Promise(r=>server.once('listening',r));
  const call=async(path,body,u=owner)=>{
    await ready;
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${task.id}${path}`,{
      method:body===undefined?'GET':'POST',
      headers:body===undefined?{cookie:'tf_session='+u.id}:{cookie:'tf_session='+u.id,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {s,runner,task,owner,other,call,runDir,counts:()=>adapterCalls};
}

test('Phase 5：重新整理成果報告成功時清除 Output Issue，並依原本流程繼續下一個安全階段',async t=>{
  const ctx=stuckTask(t,{raw:{summary:'修改 src/App.vue。npm run build 通過。',passed:true,artifacts:'src/App.vue'}});
  const before=ctx.s.task(ctx.task.id);
  assert.equal(outputIssueRecoverable(before),true,'原始回傳還在磁碟上時應該可以重新整理');

  const {status,body}=await ctx.call('/output/recover',{issueId:'issue-1'});
  assert.equal(status,200);
  assert.equal(body.recovery.ok,true);
  assert.equal(ctx.counts(),0,'重新整理成果報告不得呼叫任何引擎');

  const after=ctx.s.task(ctx.task.id);
  assert.ok(!after.outputIssue,'Schema 完整後必須清除 outputIssue');
  const thread=ctx.s.threads(ctx.task.id).find(th=>th.id==='thread-1');
  assert.equal(thread.status,'completed');
  assert.equal(thread.result.summary,'修改 src/App.vue。npm run build 通過。');
  assert.deepEqual(thread.result.evidence,['npm run build 通過'],'evidence 只能來自原始回傳');
  assert.deepEqual(thread.result.artifacts,['src/App.vue']);
  assert.equal(after.status,'queued','已通過的步驟依原本流程進入下一個安全階段');
  assert.ok(ctx.s.events(ctx.task.id).some(e=>e.kind==='output_recovered'),'必須留下可追查的事件');
});

test('Phase 5：重新整理後只會前進到下一個安全階段，已完成的步驟不會被重跑',async t=>{
  const ctx=stuckTask(t,{raw:{summary:'修改 src/App.vue。npm run build 通過。',passed:true}});
  await ctx.call('/output/recover',{issueId:'issue-1'});
  assert.equal(ctx.counts(),0);
  ctx.s.setSetting('runnerEnabled',true);
  await ctx.runner.tick();
  const threads=ctx.s.threads(ctx.task.id);
  assert.equal(threads.filter(th=>th.phase==='execute').length,1,'已完成的執行步驟不得被重新執行');
  assert.equal(threads.filter(th=>th.phase==='review').length,1,'應接續到既有的獨立驗證階段');
  assert.equal(ctx.counts(),1,'唯一的引擎呼叫來自下一個階段，不是重跑');
});

test('Phase 5：還原後 passed=false 不會直接 Completed，而是進入既有 Review／Validation 流程',async t=>{
  const ctx=stuckTask(t,{phase:'review',raw:{summary:'驗證完成。npm test 通過。'}});
  const {body}=await ctx.call('/output/recover',{issueId:'issue-1'});
  assert.equal(body.recovery.ok,true);
  const after=ctx.s.task(ctx.task.id);
  assert.notEqual(after.status,'completed','recovered passed=false 絕不能直接完成任務');
  assert.equal(after.status,'repair_planning','未通過的驗證走既有的修正方案流程');
  assert.ok(after.validationFailure,'必須保留這次驗證結果供既有流程使用');
  assert.equal(ctx.counts(),0);
});

test('Phase 5：Recovery 失敗時維持 Output Issue，並回報目前仍缺少哪些內容',async t=>{
  const ctx=stuckTask(t,{raw:{summary:'修改完成，已經處理好了。'}});   // 沒有任何可確認的執行證據
  const {status,body}=await ctx.call('/output/recover',{issueId:'issue-1'});
  assert.equal(status,200);
  assert.equal(body.recovery.ok,false);
  assert.deepEqual(body.recovery.missing,['evidence']);
  assert.doesNotMatch(JSON.stringify(body.recovery),/npm run build/,'不得為了湊齊格式而創造證據');

  const after=ctx.s.task(ctx.task.id);
  assert.ok(after.outputIssue,'還原失敗必須保持 Output Issue');
  assert.equal(after.status,'waiting_input');
  assert.deepEqual(after.outputIssue.recovery.missing,['evidence']);
  assert.equal(outputIssueRecoverable(after),false,'已經失敗過的還原不再提供注定失敗的按鈕');
  assert.equal(body.outputIssue.recoverable,false);
  assert.equal(ctx.counts(),0,'失敗的還原同樣不得呼叫引擎');
  assert.equal(ctx.s.threads(ctx.task.id).find(th=>th.id==='thread-1').status,'failed','失敗時不得偽造已完成的工作階段');
});

test('Phase 5：plan 階段的 Output Issue 不套用還原，仍只能補充需求並重新規劃',async t=>{
  const ctx=stuckTask(t,{phase:'plan',raw:{summary:'計畫摘要'}});
  assert.equal(outputIssueRecoverable(ctx.s.task(ctx.task.id)),false);
  const {body}=await ctx.call('/output/recover',{issueId:'issue-1'});
  assert.equal(body.recovery.ok,false);
  assert.match(body.recovery.reason,/重新規劃/);
  assert.ok(ctx.s.task(ctx.task.id).outputIssue);
  assert.equal(ctx.counts(),0);
});

test('Phase 5：查看原始回傳只顯示已保存的內容，不做任何解讀',async t=>{
  const ctx=stuckTask(t,{raw:{summary:'修改完成',questions:[]}});
  const {status,body}=await ctx.call('/output/original');
  assert.equal(status,200);
  assert.equal(body.available,true);
  assert.equal(body.sessionId,'session-1');
  assert.match(body.raw,/修改完成/);
  assert.deepEqual(body.issues,['questions：Required']);
  assert.equal(ctx.counts(),0);
});

test('Phase 5：只有任務擁有者能重新整理，且過期的問題編號會被拒絕',async t=>{
  const ctx=stuckTask(t,{raw:{summary:'修改 src/App.vue。npm run build 通過。'}});
  assert.equal((await ctx.call('/output/recover',{issueId:'issue-1'},ctx.other)).status,404);
  assert.equal((await ctx.call('/output/original',undefined,ctx.other)).status,404);
  assert.equal((await ctx.call('/output/recover',{issueId:'stale'})).status,409);
  assert.equal((await ctx.call('/output/recover',{issueId:'issue-1'})).status,200);
  // 還原成功後 Output Issue 已經不存在，重複點擊不會再套用一次。
  assert.equal((await ctx.call('/output/recover',{issueId:'issue-1'})).status,409);
  assert.equal(ctx.counts(),0);
});

test('Phase 5：送到瀏覽器的 Output Issue 不含伺服器磁碟路徑，但帶著能否重新整理的結論',async t=>{
  const ctx=stuckTask(t,{raw:{summary:'修改 src/App.vue。npm run build 通過。'}});
  const {body}=await ctx.call('/output/original');
  assert.ok(body.available);
  const state=await ctx.call('/output/recover',{issueId:'stale'});
  assert.equal(state.status,409);
  const task=ctx.s.task(ctx.task.id);
  assert.ok(task.outputIssue.runDir,'伺服器端仍保留 runDir 以便重新整理');
  assert.equal(recoveryCandidate(task.outputIssue).summary,'修改 src/App.vue。npm run build 通過。');
  assert.equal(originalOutput(task.outputIssue).sessionId,'session-1');
});

test('Phase 5：自動還原失敗的結論會寫進 Output Issue，使用者直接看到仍缺少什麼',async t=>{
  const dir=fixture(t,false),s=createStore(join(dir,'db.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const u=s.addUser('Owner','owner','test-password'),pid=id(),source=join(dir,'source');mkdirSync(source);
  s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);
  s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
  const runner=createRunner(s,{recover:false,dataDir:join(dir,'runtime'),adapter:async o=>{
    if(o.readOnly)return {result:{...plan,steps:[{title:'建立文件',role:'作者',instructions:'寫入文件'}]}};
    return {result:{questions:[],artifacts:[]}};   // 沒有 summary
  }});
  t.after(()=>runner.stop());s.setSetting('runnerEnabled',true);
  const task=createTask(s,u,{title:'文件工作',description:'完成文件並驗證',projectId:pid,type:'research'});
  await runner.tick();approveTask(s,u,task.id,1);await runner.tick();
  const after=s.task(task.id);
  assert.ok(after.outputIssue);
  assert.equal(after.outputIssue.recovery.ok,false);
  assert.deepEqual(after.outputIssue.recovery.missing,['summary']);
  assert.equal(outputIssueRecoverable(after),false);
});
