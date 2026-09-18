import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
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
test('reconcileBrowserValidation accepts a pass backed by real tool_use evidence',()=>{
  const requirement={required:true,previewUrl:'http://127.0.0.1:1'};
  const claimed={required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:3,url:'http://127.0.0.1:1',checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null};
  const result=reconcileBrowserValidation(claimed,{toolUsed:true,toolCallCount:3},requirement);
  assert.equal(result.executed,true);assert.equal(result.passed,true);assert.equal(result.status,'passed');assert.equal(result.toolCallCount,3);
});
test('reconcileBrowserValidation resets everything to not_required when the task did not need it',()=>{
  const result=reconcileBrowserValidation({required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:9,url:'x',checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null},{toolUsed:true,toolCallCount:9},{required:false});
  assert.deepEqual(result,defaultBrowserValidation());
});

// --- Runner-level integration: the guard is actually wired into the review phase --------
const plan={summary:'新增按鈕與彈窗',acceptance:['按鈕可點擊並顯示彈窗'],questions:[],steps:[{title:'確認 fixture',role:'工程',instructions:'確認頁面已有按鈕'}]};
const goodExecute={summary:'完成',questions:[],artifacts:['index.html'],passed:true,evidence:['已建立按鈕'],browserValidation:defaultBrowserValidation()};
function browserFixture(t,{capabilityAvailable=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'tf-browser-'));
  const store=createStore(join(dir,'db.sqlite'));
  const owner=store.addUser('Owner','owner','password-owner-123');
  const projectId=id();
  const source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'index.html'),'<html><body><h1>Hi</h1><button id="b">Open</button></body></html>');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'demo','Demo',source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id,projectId);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const previews={start:async()=>({url:'http://127.0.0.1:59999',kind:'static'}),stop:async()=>{},status:()=>null,close:async()=>{}};
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
        assert.match(o.prompt,/Browser Preview URL：http:\/\/127\.0\.0\.1:59999/);
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
