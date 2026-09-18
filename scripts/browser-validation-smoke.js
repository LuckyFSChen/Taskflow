// Real, non-mocked integration check for TaskFlow → Claude Code CLI → Playwright MCP → Chromium.
// Unlike tests/*.test.js (which use a fake adapter), this drives the actual runner.js
// createRunner()/cliAdapter() path with a real `claude` subprocess and a real preview server,
// exactly as production does. It costs real Claude usage and takes real wall-clock time
// (roughly a minute per scenario), so it is not part of `npm test` — run it manually:
//   node scripts/browser-validation-smoke.js
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {createProjectPreview} from '../server/project-preview.js';

const PASS_HTML=`<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body>
<h1>Hello Browser</h1>
<button id="open-dialog" onclick="document.getElementById('dialog').style.display='block'">Open Dialog</button>
<div id="dialog" style="display:none">Dialog visible</div>
</body></html>`;
const FAIL_HTML=`<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body>
<h1>Hello Browser</h1>
<button id="open-dialog" onclick="throw new Error('browser-validation-test')">Open Dialog</button>
<div id="dialog" style="display:none">Dialog visible</div>
<script>throw new Error('browser-validation-test');</script>
</body></html>`;

async function runScenario(name,html){
  const dir=mkdtempSync(join(tmpdir(),'tf-browser-smoke-'));
  const source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'index.html'),html);
  const store=createStore(join(dir,'db.sqlite'));
  const owner=store.addUser('Owner','owner-'+id().slice(0,8),'password-owner-12345');
  const projectId=id();
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'fixture','Fixture',source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id,projectId);
  const previews=createProjectPreview();
  const runner=createRunner(store,{dataDir:join(dir,'runtime'),previews});
  store.setSetting('runnerEnabled',true);
  const task=createTask(store,owner,{title:'Dialog button UI 驗證',description:'網頁有一個按鈕（button），點擊後應顯示彈窗（dialog）。這是前端 UI 互動變更，需要實際瀏覽器驗證。',projectId,type:'code',executor:'claude',reviewer:'claude'});
  // Skip the real planning + execution calls (already covered by existing tests / smoke-ai.js);
  // pre-approve a trivial one-step plan and mark that step already done, so the real Claude call
  // this script pays for is the one this feature actually adds: the Browser-MCP review.
  const t=store.task(task.id);
  t.plan={summary:'既有 fixture 已完成，僅需驗證',acceptance:['按鈕可點擊並顯示彈窗'],questions:[],steps:[{title:'確認 fixture 檔案',role:'工程',instructions:'確認 index.html 已包含按鈕與彈窗'}]};
  t.approvedVersion=1;t.status='queued';store.saveTask(t);
  store.saveThread({id:id(),taskId:task.id,version:1,round:0,phase:'execute',engine:'claude',role:'確認 fixture 檔案',title:'確認 fixture 檔案',status:'completed',started:new Date().toISOString(),finished:new Date().toISOString(),summary:'fixture 已就緒',result:{summary:'fixture 已就緒',questions:[],artifacts:['index.html'],passed:true,evidence:['已確認 index.html 存在'],browserValidation:{required:false,status:'not_required',executed:false,passed:null,toolUsed:false,toolCallCount:0,url:null,checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null}},sessionId:null,error:null});
  console.log(`[${name}] tick: snapshot workspace + real Claude Code review via Playwright MCP…`);
  await runner.tick();
  const after=store.task(task.id);
  const reviewThread=store.threads(task.id).filter(x=>x.phase==='review').at(-1);
  const report={scenario:name,taskStatus:after.status,round:after.round,reviewResult:reviewThread?.result||null,previewUrl:reviewThread?.result?.browserValidation?.url||null};
  console.log(`[${name}] result:`,JSON.stringify(report,null,2));
  runner.stop();await previews.close();store.close();rmSync(dir,{recursive:true,force:true});
  return report;
}

const passReport=await runScenario('pass-scenario',PASS_HTML);
const failReport=await runScenario('fail-scenario',FAIL_HTML);
console.log('\n=== Summary ===');
console.log('Pass scenario browserValidation:',JSON.stringify(passReport.reviewResult?.browserValidation));
console.log('Fail scenario browserValidation:',JSON.stringify(failReport.reviewResult?.browserValidation));

// toolUsed=true alone is too weak a claim — a lone browser_console_messages call with no
// navigate would also set it. Require the real per-category evidence TaskFlow itself counted
// from the stream-json transcript: at least one navigate call and, since this fixture's task
// is an interaction task (a button that must be clicked), at least one interact call too.
function checkEvidence(label,bv){
  const categories=bv?.categories||{};
  const checks=[
    ['toolCallCount >= 2',(bv?.toolCallCount||0)>=2],
    ['categories.navigate >= 1 (real browser_navigate observed)',(categories.navigate||0)>=1],
    ['categories.interact >= 1 (real browser_click/type/... observed)',(categories.interact||0)>=1],
  ];
  const failed=checks.filter(([,ok])=>!ok);
  console.log(`[${label}] evidence checks:`,checks.map(([d,ok])=>`${ok?'✓':'✗'} ${d}`).join('; '));
  return failed.length===0;
}
const passEvidenceOk=checkEvidence('pass-scenario',passReport.reviewResult?.browserValidation);
const failEvidenceOk=checkEvidence('fail-scenario',failReport.reviewResult?.browserValidation);
const ok=passEvidenceOk&&failEvidenceOk;
console.log(ok
  ?'REAL BROWSER MCP EVIDENCE: navigate >= 1 and interact >= 1 independently confirmed on both real Claude Code review calls (not just toolUsed=true).'
  :'WARNING: did not observe real navigate+interact Browser MCP tool_use evidence on both scenarios.');
process.exitCode=ok?0:1;
