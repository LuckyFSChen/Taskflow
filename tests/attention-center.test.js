import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionCategory,attentionItems,attentionCount,needsAttention} from '../src/attention.js';

const base=(extra={})=>({id:'t1',title:'任務',projectName:'demo',status:'queued',updated:'2026-01-01T00:00:00.000Z',questions:[],...extra});

// --- 不需要使用者處理的狀態，一律不進入待我處理 -------------------------------------
test('進行中與已結束的任務不會出現在待我處理',()=>{
  for(const status of ['planning','queued','running','paused','completed','cancelled','repair_planning','rate_limited']){
    assert.equal(attentionCategory(base({status})),null,`${status} 不應被視為待處理`);
  }
  assert.equal(attentionCategory(null),null);
});

// --- 1. 計畫待確認 -----------------------------------------------------------------
test('awaiting_approval 分類為需要確認執行計畫，並帶出計畫摘要',()=>{
  const category=attentionCategory(base({status:'awaiting_approval',plan:{summary:'先建立元件再補測試'}}));
  assert.equal(category.type,'plan_approval');
  assert.equal(category.title,'需要確認執行計畫');
  assert.equal(category.action,'查看計畫');
  assert.equal(category.reason,'先建立元件再補測試');
  assert.equal(category.priority,1);
});

// --- 2. 修正方案待確認 --------------------------------------------------------------
test('awaiting_repair_approval 分類為修正方案待確認，原因取自驗證失敗摘要',()=>{
  const category=attentionCategory(base({status:'awaiting_repair_approval',validationFailure:{summary:'Browser 驗證發現 375px 寬度仍出現水平捲動。'},repairPlan:{summary:'調整 overflow'}}));
  assert.equal(category.type,'repair_approval');
  assert.equal(category.title,'驗證未通過，AI 已提出修正方案');
  assert.equal(category.reason,'Browser 驗證發現 375px 寬度仍出現水平捲動。');
});

// --- 3. 人工操作 --------------------------------------------------------------------
test('manualAction 優先於 waiting_input，有指令時標題改為在本機執行指令',()=>{
  const withCommands=attentionCategory(base({status:'waiting_input',displayStatus:'waiting_user_action',manualAction:{id:'m1',reason:'npm 需要系統管理員權限',commands:['npm install -g pnpm']},questions:['要改用別的套件嗎？']}));
  assert.equal(withCommands.type,'manual_action');
  assert.equal(withCommands.title,'需要你在本機執行指令');
  assert.equal(withCommands.reason,'npm 需要系統管理員權限');
  const withoutCommands=attentionCategory(base({status:'waiting_input',manualAction:{id:'m1',reason:'需要你在瀏覽器完成登入',commands:[]}}));
  assert.equal(withoutCommands.title,'需要你完成一項本機操作');
});
test('只有 displayStatus=waiting_user_action（manualAction 尚未產生）也算人工操作',()=>{
  assert.equal(attentionCategory(base({status:'waiting_input',displayStatus:'waiting_user_action'})).type,'manual_action');
});

// --- 4. 環境問題 --------------------------------------------------------------------
test('environmentIssue 分類為執行環境需要處理，優先於一般等待回答',()=>{
  const category=attentionCategory(base({status:'waiting_input',environmentIssue:{id:'e1',message:'套件環境檢查未通過，尚未開始本次工作。\nnpm ping 失敗',report:{summary:'npm registry 無法連線'}},questions:['要略過嗎？']}));
  assert.equal(category.type,'environment_issue');
  assert.equal(category.title,'執行環境需要處理');
  assert.equal(category.reason,'npm registry 無法連線');
});
test('沒有 report 時，環境問題原因只取訊息第一行',()=>{
  const category=attentionCategory(base({status:'waiting_input',environmentIssue:{id:'e1',message:'工作副本無寫入權限，尚未開始工作。\n處理方案：恢復寫入權限'}}));
  assert.equal(category.reason,'工作副本無寫入權限，尚未開始工作。');
});

// --- 5. Output Issue ----------------------------------------------------------------
test('outputIssue 分類為格式不完整，且不把原始欄位錯誤顯示在列表',()=>{
  const category=attentionCategory(base({status:'waiting_input',outputIssue:{id:'o1',message:'AI 回傳格式仍不完整\nquestions：Required\nartifacts：Required\npassed：Required',issues:['questions：Required','artifacts：Required','passed：Required']}}));
  assert.equal(category.type,'output_issue');
  assert.equal(category.title,'成果報告不完整');
  assert.match(category.description,/不會重新執行已完成工作/);
  const shown=`${category.title} ${category.description} ${category.reason}`;
  assert.doesNotMatch(shown,/Required/);
  assert.doesNotMatch(shown,/questions|artifacts|passed/);
});

// --- 6. 等待回答（必須排除五種特殊情況）----------------------------------------------
test('單純的 waiting_input 分類為需要補充資訊，並帶出第一個問題',()=>{
  const category=attentionCategory(base({status:'waiting_input',questions:['要支援 IE11 嗎？','要不要保留舊網址？']}));
  assert.equal(category.type,'waiting_answer');
  assert.equal(category.title,'AI 需要你補充資訊');
  assert.match(category.reason,/要支援 IE11 嗎？/);
  assert.match(category.reason,/另有 1 個問題/);
});
test('executionApproval 與 validationSkipRequest 不會被誤判為等待回答',()=>{
  const execution=attentionCategory(base({status:'waiting_input',executionApproval:{id:'a1',questions:['是否核准刪除舊資料夾？']},questions:['是否核准刪除舊資料夾？']}));
  assert.equal(execution.type,'execution_approval');
  assert.equal(execution.reason,'是否核准刪除舊資料夾？');
  const skip=attentionCategory(base({status:'waiting_input',validationSkipRequest:{id:'s1',summary:'Browser MCP 存取被拒絕，無法驗證'}}));
  assert.equal(skip.type,'validation_skip');
  assert.equal(skip.reason,'Browser MCP 存取被拒絕，無法驗證');
});
test('待審核修正方案時，尚未處理的驗證受限決定優先顯示',()=>{
  const category=attentionCategory(base({status:'awaiting_repair_approval',validationSkipRequest:{id:'s1',summary:'驗證工具存取失敗'},repairPlan:{summary:'修正'}}));
  assert.equal(category.type,'validation_skip');
});
test('已暫停的任務即使仍有驗證受限請求也不再列入待我處理',()=>{
  assert.equal(attentionCategory(base({status:'paused',validationSkipRequest:{id:'s1',summary:'驗證工具存取失敗'}})),null);
});

// --- 7. 一般失敗 --------------------------------------------------------------------
test('failed 在沒有特殊類別時分類為執行失敗',()=>{
  const category=attentionCategory(base({status:'failed',error:'執行逾時'}));
  assert.equal(category.type,'task_failed');
  assert.equal(category.reason,'執行逾時');
});
test('failed 但需要人工操作時，仍分類為人工操作',()=>{
  assert.equal(attentionCategory(base({status:'failed',manualAction:{id:'m1',reason:'需要管理員權限',commands:['x']}})).type,'manual_action');
});

// --- 列表排序與計數 ------------------------------------------------------------------
test('attentionItems 依 priority 排序，同類別以最後更新時間新的在前',()=>{
  const tasks=[
    base({id:'failed',status:'failed',error:'x',updated:'2026-01-05T00:00:00.000Z'}),
    base({id:'plan-old',status:'awaiting_approval',plan:{summary:'a'},updated:'2026-01-01T00:00:00.000Z'}),
    base({id:'running',status:'running'}),
    base({id:'plan-new',status:'awaiting_approval',plan:{summary:'b'},updated:'2026-01-09T00:00:00.000Z'}),
    base({id:'repair',status:'awaiting_repair_approval',updated:'2026-01-02T00:00:00.000Z'}),
  ];
  assert.deepEqual(attentionItems(tasks).map(i=>i.task.id),['plan-new','plan-old','repair','failed']);
  assert.equal(attentionCount(tasks),4);
  assert.equal(attentionCount([]),0);
  assert.equal(attentionCount(undefined),0);
  assert.equal(needsAttention(tasks[2]),false);
  assert.equal(needsAttention(tasks[0]),true);
});

test('過長的原因會被截斷，不會把整段錯誤訊息塞進列表',()=>{
  const category=attentionCategory(base({status:'failed',error:'錯'.repeat(400)}));
  assert.ok(category.reason.length<=120,`原因長度 ${category.reason.length} 應不超過 120`);
  assert.match(category.reason,/…$/);
});
