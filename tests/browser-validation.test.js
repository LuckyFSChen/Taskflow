import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createTask,approveTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
import {approveRepair} from '../server/repair-approval.js';
import {decideValidationSkip,validationSkipRequest} from '../server/validation-skip.js';
import {
  deriveBrowserValidationRequirement,
  reconcileBrowserValidation,
  defaultBrowserValidation,
  isBrowserToolName,
  categorizeBrowserTool,
} from '../server/browser-capability.js';

// --- A. Browser requirement detection -------------------------------------------------
test('Browser requirement is derived from web-project kind and UI/interaction keywords',()=>{
  assert.equal(deriveBrowserValidationRequirement({webKind:null,title:'Add a button',description:'A modal dialog'}).required,false);
  assert.equal(deriveBrowserValidationRequirement({webKind:'vite',title:'Add Vue component',description:'新增一個按鈕，點擊後顯示彈窗'}).required,true);
  assert.equal(deriveBrowserValidationRequirement({webKind:'vite',title:'Refactor the SQL migration',description:'調整資料庫 migration 腳本，屬於伺服器端 schema 變更'}).required,false);
  assert.equal(deriveBrowserValidationRequirement({webKind:'static',title:'Fix login page layout',description:'調整 responsive layout'}).required,true);
});

// --- D/E. Tool-name evidence parsing (must not depend on one hardcoded tool name) --------
test('Browser tool names are recognised by server identity and categorised, not by a single hardcoded name',()=>{
  assert.equal(isBrowserToolName('mcp__playwright__browser_navigate'),true);
  assert.equal(isBrowserToolName('mcp__playwright__browser_click'),true);
  assert.equal(isBrowserToolName('Bash'),false);
  assert.equal(isBrowserToolName('mcp__other__browser_navigate'),false);
  assert.equal(categorizeBrowserTool('mcp__playwright__browser_navigate'),'navigate');
  assert.equal(categorizeBrowserTool('mcp__playwright__browser_click'),'interact');
  assert.equal(categorizeBrowserTool('mcp__playwright__browser_console_messages'),'console');
  assert.equal(categorizeBrowserTool('mcp__playwright__browser_network_requests'),'network');
});

// --- C/E. The deterministic guard: AI narration never overrides observed tool evidence ---
test('reconcileBrowserValidation ignores a claimed pass when no real tool_use evidence was observed',()=>{
  const requirement={required:true,previewUrl:'http://127.0.0.1:1'};
  const claimed={required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:5,url:null,checks:[{description:'x',passed:true}],consoleErrors:[],networkErrors:[],notes:'I opened the browser and tested it.',error:null};
  const result=reconcileBrowserValidation(claimed,{toolUsed:false,toolCallCount:0},requirement);
  assert.equal(result.executed,false);
  assert.equal(result.passed,false);
  assert.equal(result.status,'blocked');
  assert.equal(result.toolUsed,false);
  assert.match(result.error,/未偵測到 Browser MCP 工具呼叫/);
});
test('reconcileBrowserValidation accepts a pass backed by real navigate tool_use evidence',()=>{
  const requirement={required:true,previewUrl:'http://127.0.0.1:1'};
  const claimed={required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:3,url:'http://127.0.0.1:1',checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null};
  const result=reconcileBrowserValidation(claimed,{toolUsed:true,toolCallCount:3,categories:{navigate:1,console:2}},requirement);
  assert.equal(result.executed,true);assert.equal(result.passed,true);assert.equal(result.status,'passed');assert.equal(result.toolCallCount,3);
});
test('reconcileBrowserValidation resets everything to not_required when the task did not need it',()=>{
  const result=reconcileBrowserValidation({required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:9,url:'x',checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null},{toolUsed:true,toolCallCount:9,categories:{navigate:1,interact:1}},{required:false});
  assert.deepEqual(result,defaultBrowserValidation());
});

// --- Stricter evidence: any mcp__playwright__* call used to count as "executed", even a lone
// console/screenshot call with no navigate. TaskFlow now requires real navigate evidence, and for
// interaction-required tasks, real interact evidence too — the AI's own executed/passed claim is
// never authoritative. ---------------------------------------------------------------------------
test('1) No Browser tool call at all → blocked, passed=false',()=>{
  const requirement={required:true,requiresInteraction:false,previewUrl:'http://127.0.0.1:1'};
  const claimed={...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true};
  const result=reconcileBrowserValidation(claimed,{toolCallCount:0,categories:{}},requirement);
  assert.equal(result.executed,false);assert.equal(result.passed,false);assert.equal(result.status,'blocked');
});
test('2) Only console tool called, no navigate → blocked, executed=false (a single non-navigate call must not count as "executed")',()=>{
  const requirement={required:true,requiresInteraction:false,previewUrl:'http://127.0.0.1:1'};
  const claimed={...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true};
  const result=reconcileBrowserValidation(claimed,{toolCallCount:1,categories:{console:1}},requirement);
  assert.equal(result.executed,false);assert.equal(result.passed,false);assert.equal(result.status,'blocked');
  assert.match(result.error,/未偵測到 Browser navigate 工具呼叫/);
});
test('2b) Only screenshot tool called, no navigate → blocked',()=>{
  const requirement={required:true,requiresInteraction:false,previewUrl:'http://127.0.0.1:1'};
  const claimed={...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true};
  const result=reconcileBrowserValidation(claimed,{toolCallCount:1,categories:{inspect:1}},requirement);
  assert.equal(result.executed,false);assert.equal(result.status,'blocked');
});
test('3) Navigate present, non-interaction task → real Browser executed, AI pass/fail claim decides the outcome',()=>{
  const requirement={required:true,requiresInteraction:false,previewUrl:'http://127.0.0.1:1'};
  const passing=reconcileBrowserValidation({...defaultBrowserValidation(),required:true,passed:true},{toolCallCount:1,categories:{navigate:1}},requirement);
  assert.equal(passing.executed,true);assert.equal(passing.passed,true);assert.equal(passing.status,'passed');
  const failing=reconcileBrowserValidation({...defaultBrowserValidation(),required:true,passed:false},{toolCallCount:1,categories:{navigate:1}},requirement);
  assert.equal(failing.executed,true);assert.equal(failing.passed,false);assert.equal(failing.status,'failed');
});
test('4) Navigate present but interaction task has no interact call → executed=true, passed=false, status=failed',()=>{
  const requirement={required:true,requiresInteraction:true,previewUrl:'http://127.0.0.1:1'};
  const claimed={...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true};
  const result=reconcileBrowserValidation(claimed,{toolCallCount:1,categories:{navigate:1}},requirement);
  assert.equal(result.executed,true);assert.equal(result.passed,false);assert.equal(result.status,'failed');
  assert.match(result.error,/未偵測到 Browser interact 工具呼叫/);
});
test('5) Navigate + interact present for an interaction task → real pass is honoured',()=>{
  const requirement={required:true,requiresInteraction:true,previewUrl:'http://127.0.0.1:1'};
  const claimed={...defaultBrowserValidation(),required:true,passed:true};
  const result=reconcileBrowserValidation(claimed,{toolCallCount:2,categories:{navigate:1,interact:1}},requirement);
  assert.equal(result.executed,true);assert.equal(result.passed,true);assert.equal(result.status,'passed');
});
test('AI-supplied executed/passed is never authoritative on its own: navigate+interact present but AI claims passed=false → failed, not passed',()=>{
  const requirement={required:true,requiresInteraction:true,previewUrl:'http://127.0.0.1:1'};
  const claimed={...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:false};
  const result=reconcileBrowserValidation(claimed,{toolCallCount:2,categories:{navigate:1,interact:1}},requirement);
  assert.equal(result.passed,false);assert.equal(result.status,'failed');
});
test('deriveBrowserValidationRequirement flags requiresInteraction for button/click/form tasks, not for plain layout/content tasks',()=>{
  assert.equal(deriveBrowserValidationRequirement({webKind:'vite',title:'新增按鈕',description:'點擊按鈕後顯示彈窗'}).requiresInteraction,true);
  assert.equal(deriveBrowserValidationRequirement({webKind:'vite',title:'Add a submit form',description:'user fills a form and clicks submit'}).requiresInteraction,true);
  const layoutOnly=deriveBrowserValidationRequirement({webKind:'vite',title:'調整頁面標題字體',description:'頁面上方標題文字的字體大小與行距需要調整，屬於純視覺排版微調'});
  assert.equal(layoutOnly.required,true);
  assert.equal(layoutOnly.requiresInteraction,false);
});

// --- Runner-level integration: the guard is actually wired into the review phase --------
const plan={summary:'新增按鈕與彈窗',acceptance:['按鈕可點擊並顯示彈窗'],questions:[],steps:[{title:'確認 fixture',role:'工程',instructions:'確認頁面已有按鈕'}]};
const goodExecute={summary:'完成',questions:[],artifacts:['index.html'],passed:true,evidence:['已建立按鈕'],browserValidation:defaultBrowserValidation()};
// Preview 的網址現在必須**真的回應得出 HTML**：Runtime Preflight 會在 Browser Validation
// 之前實際 GET 一次根路徑（計畫書第十二章「Frontend Ready 也不能只看 Port」）。
// 寫死一個沒有人在聽的 127.0.0.1:59999 會被正確地判定成服務沒起來，所以這些測試改用
// 一個真的（極小的）伺服器當 Preview——這讓它們驗到的東西比整改前更接近真實流程。
function previewStub(t){
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!DOCTYPE html><html><body><h1>Hi</h1><button id="b">Open</button></body></html>');});
  const url=new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
  return {url};
}
function browserFixture(t,{capabilityAvailable=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'tf-browser-'));
  const store=createStore(join(dir,'db.sqlite'));
  const owner=store.addUser('Owner','owner','password-owner-123');
  const projectId=id();
  const source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'index.html'),'<html><body><h1>Hi</h1><button id="b">Open</button></body></html>');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'demo','Demo',source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id,projectId);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const preview=previewStub(t);
  const previews={start:async()=>({url:await preview.url,kind:'static'}),stop:async()=>{},status:()=>null,close:async()=>{}};
  const checkBrowserCapability=async()=>capabilityAvailable?{available:true,provider:'playwright-mcp',cli:'claude',error:null}:{available:false,provider:null,cli:'claude',error:'Playwright MCP unavailable'};
  return {dir,store,owner,projectId,previews,checkBrowserCapability,
    create:(extra={})=>createTask(store,owner,{title:'UI 按鈕與彈窗',description:'網頁需要一個按鈕，點擊後顯示彈窗（modal dialog），這是前端 UI 互動修改。',projectId,type:'code',executor:'claude',reviewer:'claude',...extra})};
}
function approveWithCompletedStep(store,task,taskPlan=plan){
  const t=store.task(task.id);t.plan=taskPlan;t.approvedVersion=1;t.status='queued';store.saveTask(t);
  store.saveThread({id:id(),taskId:task.id,version:1,round:0,phase:'execute',engine:'claude',role:'確認 fixture',title:'確認 fixture',status:'completed',started:new Date().toISOString(),finished:new Date().toISOString(),summary:'完成',result:goodExecute,sessionId:null,error:null});
}

test('Web UI task with Browser MCP unavailable is reported as blocked, never a silent pass',async t=>{
  const f=browserFixture(t,{capabilityAvailable:false});
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews:f.previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>{if(o.readOnly)return {result:plan};return {result:{summary:'AI 聲稱已測試瀏覽器，一切正常',questions:[],artifacts:['index.html'],passed:true,evidence:['claims tested'],browserValidation:{...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:3}}};}});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create();approveWithCompletedStep(f.store,task);
  await runner.tick();
  const after=f.store.task(task.id);
  const review=f.store.threads(task.id).filter(x=>x.phase==='review').at(-1);
  assert.equal(review.result.browserValidation.status,'blocked');
  assert.equal(review.result.browserValidation.executed,false);
  assert.equal(review.result.passed,false,'AI claimed passed=true but TaskFlow must not trust it when Browser MCP was unavailable');
  assert.equal(after.status,'waiting_input');
  assert.ok(validationSkipRequest(f.store,after),'a blocked browser validation should route through the existing tool-access-failure skip flow');
});

test('AI claiming passed=true without any real tool_use evidence is overridden to failed (anti-fabrication guard)',async t=>{
  const f=browserFixture(t,{capabilityAvailable:true});
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews:f.previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>{
      if(o.readOnly)return {result:plan};
      // Simulates a Claude session that narrates browser testing in text but never actually
      // called an mcp__playwright__* tool — cliAdapter would report browserEvidence.toolCallCount:0.
      return {result:{summary:'I opened the browser and tested it, everything works.',questions:[],artifacts:['index.html'],passed:true,evidence:['tested in browser'],browserValidation:{...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:6}},browserEvidence:{toolUsed:false,toolCallCount:0,categories:{}}};
    }});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create();approveWithCompletedStep(f.store,task);
  await runner.tick();
  const review=f.store.threads(task.id).filter(x=>x.phase==='review').at(-1);
  assert.equal(review.result.browserValidation.toolUsed,false);
  assert.equal(review.result.browserValidation.executed,false);
  assert.equal(review.result.passed,false);
  assert.equal(f.store.task(task.id).status,'waiting_input');
});

test('Real tool_use evidence lets a genuine browser pass complete the task, and a genuine failure enters repair and can pass on retry',async t=>{
  const f=browserFixture(t,{capabilityAvailable:true});
  let reviewCalls=0;
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews:f.previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>{
      if(o.readOnly)return {result:plan};
      if(o.prompt.includes('你是 TaskFlow 的 獨立驗證')){
        reviewCalls++;
        assert.match(o.prompt,/Browser Preview URL：http:\/\/127\.0\.0\.1:\d+/);
        const passed=reviewCalls>=2;
        return {result:{summary:passed?'按鈕點擊後彈窗顯示':'按鈕點擊後彈窗未顯示',questions:[],artifacts:['index.html'],passed,evidence:[passed?'browser_click 後確認彈窗顯示':'browser_click 後彈窗仍隱藏'],browserValidation:{...defaultBrowserValidation(),required:true,status:passed?'passed':'failed',executed:true,passed,toolUsed:true,toolCallCount:3}},browserEvidence:{toolUsed:true,toolCallCount:3,categories:{navigate:1,interact:2}}};
      }
      return {result:{summary:'已修正彈窗顯示邏輯',questions:[],artifacts:['index.html'],passed:true,evidence:['修正 onclick'],browserValidation:defaultBrowserValidation()}};
    }});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create();approveWithCompletedStep(f.store,task);
  await runner.tick();
  let after=f.store.task(task.id);
  assert.equal(after.status,'repair_planning');
  assert.equal(f.store.threads(task.id).at(-1).result.browserValidation.status,'failed');
  await runner.tick();
  after=f.store.task(task.id);assert.equal(after.status,'awaiting_repair_approval');
  approveRepair(f.store,f.owner,task.id,after.repairPlan.id);
  await runner.tick();
  await runner.tick();
  after=f.store.task(task.id);
  assert.equal(after.status,'completed');
  assert.equal(reviewCalls,2);
  const finalReview=f.store.threads(task.id).filter(x=>x.phase==='review').at(-1);
  assert.equal(finalReview.result.browserValidation.passed,true);
  assert.equal(finalReview.result.browserValidation.toolUsed,true);
});

test('Backend-only task on a non-web project never triggers Browser MCP wiring',async t=>{
  const f=browserFixture(t,{capabilityAvailable:true});
  let sawBrowserPrompt=false;
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews:f.previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>{if(o.readOnly)return {result:plan};if(/Browser Preview URL|Browser Validation/.test(o.prompt))sawBrowserPrompt=true;return {result:goodExecute};}});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create({title:'調整 SQL migration 腳本',description:'後端資料庫 migration，純粹是伺服器端資料結構調整，不涉及對外服務邏輯。'});
  const backendPlan={summary:'調整資料表結構',acceptance:['migration 可正確套用'],questions:[],steps:[{title:'撰寫 migration',role:'工程',instructions:'新增欄位'}]};
  approveWithCompletedStep(f.store,task,backendPlan);
  await runner.tick();
  assert.equal(sawBrowserPrompt,false);
  assert.equal(f.store.task(task.id).status,'completed');
});

// Test 9（計畫書第十四、二十章）：Browser Validation 不得自己另外生一個身份。
// 交給 Agent 的 Preview 帳密，必須就是 Preview 注入的那一個 AcceptanceContext 裡的那一組。
test('Browser Validation 使用與 API 驗收相同的 Acceptance Identity',async t=>{
  const f=browserFixture(t,{capabilityAvailable:true});
  const acceptance={id:'ctx-browser',mode:'credentials',username:'taskflow-preview',password:'one-time-browser-pw',injection:{environment:true,database:true,error:null}};
  const preview=previewStub(t);
  const previews={
    start:async()=>({url:await preview.url,kind:'fullstack',pid:1234,acceptance,credentials:{username:acceptance.username,password:acceptance.password}}),
    stop:async()=>{},status:()=>null,close:async()=>{},
  };
  const prompts=[];
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>{prompts.push(o.prompt);if(o.readOnly)return {result:plan};
      return {result:{summary:'已實際開啟 Preview 並登入操作',questions:[],artifacts:['index.html'],passed:true,evidence:['browser checked'],
        browserValidation:{...defaultBrowserValidation(),required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:3}},
        browserEvidence:{toolCallCount:3,categories:{navigate:1,interact:2}}};}});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create();approveWithCompletedStep(f.store,task);
  await runner.tick();

  const browserPrompt=prompts.find(p=>p.includes('Browser Preview URL'));
  assert.ok(browserPrompt,'需要 Browser Validation 的任務應該拿到 Preview URL');
  assert.match(browserPrompt,/username=taskflow-preview/);
  assert.ok(browserPrompt.includes(`password=${acceptance.password}`),'交給 Browser 的必須是同一組一次性帳密，不是另外產生的');
  assert.match(browserPrompt,/禁止嘗試讀取 data\/first-login.txt、猜測或使用任何正式使用者帳密/);
});

// --- Runtime preflight 與 waiting_input 的界線（計畫書第二十一、二十二章）-----------------
// Test 9：可回復的 runtime 失敗在自動回復用盡之後，任務必須停在 runtime 層，
//         **不得**變成 waiting_input，也**不得**觸發 Repair Agent 去改一份沒有壞的程式碼。
test('Test 9 — TaskFlow 自己的 runtime 失敗不會變成 waiting_input，也不會叫 Repair Agent',async t=>{
  const f=browserFixture(t,{capabilityAvailable:true});
  let startCalls=0,reviewCalls=0;
  const previews={
    start:async()=>{startCalls++;const error=new Error('連接埠已被占用（EADDRINUSE）');error.kind='port_conflict';throw error;},
    stop:async()=>{},status:()=>null,close:async()=>{},
  };
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>{if(o.readOnly)return {result:plan};if(o.prompt.includes('你是 TaskFlow 的 獨立驗證'))reviewCalls++;return {result:goodExecute};}});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create();approveWithCompletedStep(f.store,task);
  await runner.tick();

  const after=f.store.task(task.id);
  assert.ok(startCalls>1,'可回復的 runtime 失敗必須真的自動重試過');
  assert.ok(startCalls<=3,`自動回復必須有上限，實際嘗試 ${startCalls} 次`);
  assert.equal(reviewCalls,0,'runtime 沒準備好時不該讓 Reviewer 跑，更不該產生「驗證失敗」的結論');
  assert.notEqual(after.status,'waiting_input','連接埠衝突不是需要使用者回答的問題');
  assert.notEqual(after.status,'repair_planning','runtime 失敗不得直接觸發 Repair Agent');
  assert.equal(after.status,'failed');
  assert.ok(after.runtimeIssue,'必須留下結構化的 runtime 問題紀錄');
  assert.equal(after.runtimeIssue.state,'runtime_blocked');
  assert.equal(after.runtimeIssue.failureKind,'port_conflict');
  assert.equal(after.runtimeIssue.owner,'taskflow');
  assert.deepEqual(after.questions,[],'不該對使用者提問');
  assert.ok(f.store.events(task.id).some(event=>event.kind==='runtime_blocked'));
});

// Test 10：真的需要使用者提供資訊時（TaskFlow 判定不出這個專案要啟動哪些服務），
//          而且只有這一種情況，才可以進 waiting_input。
test('Test 10 — 只有 topology 判定不出來這種真的需要使用者回答的情況才進 waiting_input',async t=>{
  const f=browserFixture(t,{capabilityAvailable:true});
  const previews={
    start:async()=>{throw new Error('此資料夾與其第一層子目錄都沒有找到可預覽的網頁。');},
    stop:async()=>{},status:()=>null,close:async()=>{},
  };
  const runner=createRunner(f.store,{dataDir:join(f.dir,'runs'),recover:false,previews,checkBrowserCapability:f.checkBrowserCapability,
    adapter:async o=>(o.readOnly?{result:plan}:{result:goodExecute})});
  t.after(()=>runner.stop());f.store.setSetting('runnerEnabled',true);
  const task=f.create();approveWithCompletedStep(f.store,task);
  await runner.tick();

  const after=f.store.task(task.id);
  assert.equal(after.status,'waiting_input');
  assert.equal(after.runtimeIssue.failureKind,'topology_unresolved');
  assert.equal(after.runtimeIssue.owner,'user');
  assert.equal(after.questions.length,1);
  assert.match(after.questions[0],/taskflow\.runtime\.json/,'要告訴使用者具體該補什麼，而不是只說失敗');
});
