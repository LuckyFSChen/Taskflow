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
