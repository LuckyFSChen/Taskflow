import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_STEPS,WIZARD_HEALTH_KEYS,shouldShowOnboarding,systemCheckItems,systemCheckSummary,
  stepDone,stepBlocker,canAdvance,wizardSteps,nextStepId,previousStepId,firstStepId,stepDefinition,
  aiModeOptions,defaultAiMode,aiModeDescription
} from '../src/onboarding-view.js';
import {healthGroups} from '../src/system-health-view.js';
import {AI_MODES,AUTO,CUSTOM,autoModeSummary} from '../src/task-defaults.js';

const ok=message=>({status:'ok',message});
const health=(overrides={})=>({status:'ok',checkedAt:'2026-01-01T00:00:00.000Z',checks:{
  runtime:ok('Node 24.20.0 可使用'),codex:ok('Codex CLI 可使用'),claude:ok('Claude CLI 可使用'),
  browser:ok('Browser MCP 可使用（playwright-mcp）'),projects:ok('2 個專案路徑正常'),line:ok('已連線'),
  ...overrides
}});
const configured=extra=>({health:health(),defaultProjectRoot:'D:\\Projects',aiMode:AUTO,hasProject:true,...extra});

// --- 四個步驟 ------------------------------------------------------------------------
test('步驟順序與需求一致：系統檢查 → 專案位置 → AI 模式 → 建立第一個任務',()=>{
  assert.deepEqual(ONBOARDING_STEPS.map(s=>s.id),['system','project','ai','task']);
  assert.deepEqual(ONBOARDING_STEPS.map(s=>s.label),['系統檢查','專案位置','AI 模式','建立第一個任務']);
  assert.equal(firstStepId(),'system');
  assert.equal(nextStepId('system'),'project');
  assert.equal(nextStepId('task'),null,'最後一步之後沒有下一步');
  assert.equal(previousStepId('system'),null);
  assert.equal(previousStepId('ai'),'project');
  assert.equal(stepDefinition('project').label,'專案位置');
  assert.equal(stepDefinition('nope'),null);
});

// --- 要不要顯示 ----------------------------------------------------------------------
test('顯示與否只看後端算出的設定狀態，不在前端猜「第一次登入」',()=>{
  const admin={role:'admin'},member={role:'member'};
  assert.equal(shouldShowOnboarding({user:admin,onboarding:{show:true}}),true);
  assert.equal(shouldShowOnboarding({user:admin,onboarding:{show:false,completed:true}}),false);
  // 成員不會看到一個他無法完成的流程，即使後端資料有誤也一樣。
  assert.equal(shouldShowOnboarding({user:member,onboarding:{show:true}}),false);
  assert.equal(shouldShowOnboarding({user:null,onboarding:{show:true}}),false);
  assert.equal(shouldShowOnboarding({}),false);
  assert.equal(shouldShowOnboarding(),false);
  // 沒拿到狀態時保守處理：不跳出來打擾。
  assert.equal(shouldShowOnboarding({user:admin,onboarding:null}),false);
});

// --- 第一步：沿用既有的 system health ---------------------------------------------------
test('系統檢查直接沿用 /api/system/health 的分組結果，沒有第二套檢查',()=>{
  const report=health();
  const items=systemCheckItems(report);
  assert.deepEqual(items.map(i=>i.key),WIZARD_HEALTH_KEYS);
  assert.deepEqual(items.map(i=>i.label),['Node','Codex','Claude','Playwright MCP']);
  // 每一項的文字與符號都來自既有的 healthGroups，不是在精靈裡重新算的。
  const fromHealthView=healthGroups(report).flatMap(group=>group.items).filter(item=>WIZARD_HEALTH_KEYS.includes(item.key));
  assert.deepEqual(items,fromHealthView);
  assert.deepEqual(items.map(i=>i.mark),['✓','✓','✓','✓']);
  // 專案路徑與 LINE 不在第一步（專案是第二步的事，LINE 是選用的）。
  assert.equal(items.find(i=>i.key==='projects'),undefined);
  assert.equal(items.find(i=>i.key==='line'),undefined);
});

test('後端回報的失敗會原文顯示；還沒拿到資料時不會假裝正常',()=>{
  const report=health({claude:{status:'error',message:'Claude CLI 無法執行。請確認已安裝並完成登入。'}});
  const claude=systemCheckItems(report).find(i=>i.key==='claude');
  assert.deepEqual({status:claude.status,mark:claude.mark},{status:'error',mark:'✗'});
  assert.equal(claude.message,'Claude CLI 無法執行。請確認已安裝並完成登入。');
  assert.deepEqual(systemCheckItems(null),[]);
  assert.equal(systemCheckSummary(null).checked,false);
  assert.equal(systemCheckSummary(health()).checked,true);
});

test('系統檢查有錯誤時仍然可以繼續：精靈不擋人，錯誤交給首頁提醒',()=>{
  const report=health({claude:{status:'error',message:'Claude CLI 無法執行'}});
  const summary=systemCheckSummary(report);
  assert.equal(summary.blocking,false,'環境有問題不代表使用者要被困在精靈裡');
  assert.deepEqual(summary.errors,['Claude：Claude CLI 無法執行']);
  assert.match(summary.note,/仍然可以繼續設定/);
  assert.match(summary.note,/首頁會持續提醒/);
  assert.equal(canAdvance('system',{health:report}),true);
  assert.equal(stepBlocker('system',{health:report}),null);
  // 兩個引擎都壞掉也一樣不擋。
  const both=health({codex:{status:'error',message:'Codex CLI 無法執行'},claude:{status:'error',message:'Claude CLI 無法執行'}});
  assert.equal(systemCheckSummary(both).errors.length,2);
  assert.equal(canAdvance('system',{health:both}),true);
});

test('尚未就緒但不是錯誤的項目會被列為待處理，不會被講成正常',()=>{
  const summary=systemCheckSummary(health({browser:{status:'warning',message:'尚未安裝 @playwright/mcp'}}));
  assert.deepEqual(summary.warnings,['Playwright MCP：尚未安裝 @playwright/mcp']);
  assert.deepEqual(summary.errors,[]);
  assert.match(summary.note,/尚未就緒/);
  assert.match(systemCheckSummary(health()).note,/都可以使用/);
});

// --- 第二步：專案位置 -----------------------------------------------------------------
test('沒有預設專案存放位置就不能進入下一步，設定後即可繼續',()=>{
  assert.match(stepBlocker('project',{defaultProjectRoot:''}),/預設專案存放位置/);
  assert.equal(canAdvance('project',{defaultProjectRoot:''}),false);
  assert.equal(stepBlocker('project',{defaultProjectRoot:'D:\\Projects'}),null);
  // 最後一步同樣需要存放位置：第一個任務要靠它建立新專案。
  assert.match(stepBlocker('task',{defaultProjectRoot:''}),/專案位置/);
  assert.equal(stepBlocker('task',{defaultProjectRoot:'D:\\Projects'}),null);
});

// --- 第三步：AI 模式 ------------------------------------------------------------------
test('AI 模式預設是自動選擇，選項與說明沿用既有的 task-defaults',()=>{
  assert.equal(defaultAiMode(),AUTO);
  assert.equal(aiModeOptions(),AI_MODES);
  assert.equal(aiModeOptions()[0].label,'自動選擇（推薦）');
  assert.deepEqual(aiModeOptions().map(m=>m.value),[AUTO,CUSTOM]);
  const description=aiModeDescription('code');
  assert.match(description,/TaskFlow 會依任務類型自動安排規劃、執行與驗證模型/);
  assert.ok(description.endsWith(autoModeSummary('code')),'說明文字必須沿用既有的安排，不另外寫一份');
  assert.ok(aiModeDescription('research').endsWith(autoModeSummary('research')));
  assert.doesNotMatch(description,/Planner|Executor|Reviewer/i);
});

// --- 步驟狀態 ------------------------------------------------------------------------
test('每一步「做完了沒有」全部由既有狀態推導，不另外記錄進度',()=>{
  assert.equal(stepDone('system',{health:{checkedAt:'2026-01-01T00:00:00.000Z'}}),true);
  assert.equal(stepDone('system',{health:{checkedAt:null}}),false);
  assert.equal(stepDone('project',{defaultProjectRoot:'D:\\Projects'}),true);
  assert.equal(stepDone('project',{defaultProjectRoot:''}),false);
  assert.equal(stepDone('ai',{aiMode:AUTO}),true);
  assert.equal(stepDone('task',{hasTask:true}),true);
  assert.equal(stepDone('task',{hasTask:false}),false);
  assert.equal(stepDone('unknown',{}),false);
});

test('步驟列同時顯示目前位置與已完成的步驟',()=>{
  const steps=wizardSteps('ai',configured({hasTask:false}));
  assert.deepEqual(steps.map(s=>s.state),['done','done','current','todo']);
  assert.deepEqual(steps.map(s=>s.index),[1,2,3,4]);
  assert.deepEqual(steps.map(s=>s.label),['系統檢查','專案位置','AI 模式','建立第一個任務']);
  // 目前所在的步驟永遠標成 current，即使它其實已經完成。
  assert.equal(wizardSteps('project',configured()).find(s=>s.id==='project').state,'current');
  const fresh=wizardSteps('system',{health:null,defaultProjectRoot:'',aiMode:AUTO,hasTask:false});
  assert.deepEqual(fresh.map(s=>s.state),['current','todo','done','todo']);
});
