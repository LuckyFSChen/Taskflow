import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DETAIL_TABS,
  DEFAULT_TAB,
  STATE_MARKS,
  pendingActions,
  hasPendingActions,
  pendingBanner,
  progressSteps,
  progressSummary,
  browserValidations,
  validationEvidence,
  publishState,
  technicalFacts,
  threadTechnical,
  threadEvents,
  taskRuns,
  runTitle,
  attemptLabel,
} from '../src/task-detail-view.js';

// 共用的任務樣板：一個已核准、有三個步驟的程式任務。
function baseTask(extra = {}) {
  return {
    id: 'task-1',
    title: '修好登入頁',
    status: 'running',
    planner: 'claude',
    executor: 'codex',
    reviewer: 'claude',
    planVersion: 1,
    approvedVersion: 1,
    round: 0,
    questions: [],
    events: [],
    threads: [],
    completedSteps: 0,
    totalSteps: 3,
    plan: {
      summary: '先分析再修改再測試',
      acceptance: ['登入成功', '沒有 console 錯誤'],
      questions: [],
      steps: [
        { title: '分析需求', role: '需求分析', instructions: '讀程式' },
        { title: '修改程式', role: '實作', instructions: '改程式' },
        { title: '執行測試', role: '實作', instructions: '跑測試' },
      ],
    },
    ...extra,
  };
}

function thread(extra = {}) {
  return { id: 'th-1', phase: 'execute', engine: 'codex', role: '實作', status: 'completed', version: 1, round: 0, result: null, sessionId: null, ...extra };
}

function states(task) {
  return progressSteps(task).map(s => `${s.mark} ${s.label}`);
}

// --- 分頁結構 ---------------------------------------------------------------

test('四個分頁依「概覽 / 執行進度 / 成果 / 技術資訊」排列，預設停在概覽', () => {
  assert.deepEqual(DETAIL_TABS.map(t => t.id), ['overview', 'progress', 'results', 'technical']);
  assert.deepEqual(DETAIL_TABS.map(t => t.label), ['概覽', '執行進度', '成果', '技術資訊']);
  assert.equal(DEFAULT_TAB, 'overview');
});

// --- A. 一般任務 -------------------------------------------------------------

test('一般執行中的任務沒有需要使用者處理的事情', () => {
  const task = baseTask();
  assert.deepEqual(pendingActions(task), []);
  assert.equal(hasPendingActions(task), false);
  assert.equal(pendingBanner(task), null);
});

test('進度依真實 state 推導：已完成打勾、目前這步進行中、其餘尚未開始', () => {
  const task = baseTask({ completedSteps: 1, threads: [thread({ status: 'running', result: null })] });
  assert.deepEqual(states(task), [
    '✓ 整理需求與計畫',
    '✓ 核准執行計畫',
    '✓ 分析需求',
    '→ 修改程式',
    '○ 執行測試',
    '○ 最終驗證',
  ]);
});

test('進度摘要只給可核對的件數，不含任何百分比', () => {
  const summary = progressSummary(baseTask({ completedSteps: 1 }));
  assert.equal(summary.done, 3);
  assert.equal(summary.total, 6);
  assert.equal(summary.label, '3 / 6 個進度項目已完成');
  assert.doesNotMatch(JSON.stringify(progressSteps(baseTask())), /%|percent|progress":\s*\d/);
  assert.doesNotMatch(summary.label, /%/);
});

test('尚未規劃的任務不會假裝已經開始', () => {
  const task = baseTask({ status: 'planning', plan: null, approvedVersion: null, completedSteps: 0, totalSteps: 0 });
  assert.deepEqual(states(task), ['→ 整理需求與計畫', '○ 核准執行計畫', '○ 最終驗證']);
});

test('待審核計畫時，核准那一步標成等待使用者，而不是已完成', () => {
  const task = baseTask({ status: 'awaiting_approval', approvedVersion: null });
  const approval = progressSteps(task).find(s => s.key === 'approval');
  assert.equal(approval.state, 'blocked');
  assert.equal(approval.mark, STATE_MARKS.blocked);
  assert.deepEqual(pendingActions(task).map(a => a.id), ['plan_approval']);
  assert.match(pendingActions(task)[0].title, /v1/);
});

// --- B. waiting_input --------------------------------------------------------

test('waiting_input 的提問會列進「需要我處理」', () => {
  const task = baseTask({ status: 'waiting_input', questions: ['要用哪一個資料庫？'] });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['questions']);
  assert.equal(pendingBanner(task).count, 1);
  assert.equal(pendingBanner(task).tab, 'overview');
});

test('有 execution approval 時不重複列出同一批問題', () => {
  const task = baseTask({ status: 'waiting_input', questions: ['是否核准刪除舊資料表？'], executionApproval: { id: 'ea-1', questions: ['是否核准刪除舊資料表？'] } });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['execution_approval']);
});

// --- C. manual action --------------------------------------------------------

test('manual action 排在最前面，並且讓目前這一步顯示為等待你處理', () => {
  const task = baseTask({
    status: 'waiting_input',
    displayStatus: 'waiting_user_action',
    completedSteps: 1,
    questions: [],
    manualAction: { id: 'ma-1', commands: ['npm install -g pnpm'], reason: '需要系統管理員權限' },
  });
  const actions = pendingActions(task);
  assert.deepEqual(actions.map(a => a.id), ['manual_action']);
  assert.equal(actions[0].title, '需要你在本機執行指令');
  const current = progressSteps(task).find(s => s.key === 'step-1');
  assert.equal(current.state, 'blocked');
  assert.equal(current.note, '需要你處理後才會繼續');
});

test('沒有指令的 manual action 用另一個標題', () => {
  const task = baseTask({ manualAction: { id: 'ma-2', commands: [], reason: '請手動啟動資料庫' } });
  assert.equal(pendingActions(task)[0].title, '需要你完成一項本機操作');
});

// --- D. repair approval ------------------------------------------------------

test('修正方案待審核時列出修正輪次，且修正步驟尚未開始', () => {
  const task = baseTask({
    status: 'awaiting_repair_approval',
    round: 1,
    completedSteps: 3,
    repairPlan: { id: 'rp-1', round: 1, summary: '測試沒有跑起來', steps: [{ title: '修正設定', role: '實作', instructions: 'x' }], acceptance: ['測試通過'], questions: [] },
    validationFailure: { summary: '測試未執行', evidence: [], questions: [] },
    threads: [thread({ id: 'th-review', phase: 'review', role: '獨立驗證', result: { passed: false, evidence: [], summary: '測試未執行' } }), thread({ id: 'th-rp', phase: 'repair_plan', round: 1, role: '修正方案分析', result: { passed: true, evidence: [], summary: 'x' } })],
  });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['repair_approval']);
  assert.match(pendingActions(task)[0].title, /第 1 輪/);
  const labels = states(task);
  assert.ok(labels.includes('! 第 1 輪修正方案'), labels.join(' | '));
  assert.ok(labels.includes('○ 第 1 輪修正'), labels.join(' | '));
  assert.ok(labels.includes('✗ 最終驗證'), labels.join(' | '));
});

test('已完成的修正輪次標成已完成', () => {
  const task = baseTask({
    status: 'running',
    round: 1,
    completedSteps: 3,
    threads: [
      thread({ id: 'th-rp', phase: 'repair_plan', round: 1, result: { passed: true, evidence: [], questions: [] } }),
      thread({ id: 'th-rep', phase: 'repair', round: 1, result: { passed: true, evidence: ['npm test：通過'], questions: [] } }),
    ],
  });
  const labels = states(task);
  assert.ok(labels.includes('✓ 第 1 輪修正方案'), labels.join(' | '));
  assert.ok(labels.includes('✓ 第 1 輪修正'), labels.join(' | '));
});

// --- E. output issue ---------------------------------------------------------

test('成果報告不完整會出現在需要我處理，而且不會蓋掉其他待辦', () => {
  const task = baseTask({ status: 'waiting_input', outputIssue: { id: 'oi-1', issues: ['questions：Required'], recoverable: true } });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['output_issue']);
  assert.match(pendingActions(task)[0].description, /原始回傳與已完成進度都已保留/);
});

test('同時成立的待辦全部列出，不會只留下第一個', () => {
  const task = baseTask({
    status: 'waiting_input',
    manualAction: { id: 'ma', commands: ['x'] },
    environmentIssue: { id: 'ei', message: 'npm 不可用' },
    outputIssue: { id: 'oi', issues: [] },
  });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['manual_action', 'environment_issue', 'output_issue']);
  assert.equal(pendingBanner(task).message, '有 3 件事需要你處理');
});

test('執行失敗的任務也會列進需要我處理，與「待我處理」列表一致', () => {
  const task = baseTask({ status: 'failed', error: 'Browser 驗證未取得實際工具呼叫證據。' });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['task_failed']);
  assert.equal(pendingBanner(task).message, '任務執行失敗，需要你檢查');
});

test('已經有明確處理方式時，不會再多列一個籠統的失敗項目', () => {
  const task = baseTask({ status: 'failed', manualAction: { id: 'ma', commands: [] } });
  assert.deepEqual(pendingActions(task).map(a => a.id), ['manual_action', 'task_failed']);
  assert.equal(pendingActions(task)[0].id, 'manual_action');
});

// --- F. completed ------------------------------------------------------------

test('完成的任務每一步都打勾', () => {
  const task = baseTask({
    status: 'completed',
    completedSteps: 3,
    artifactVersion: 'v1-abc',
    threads: [thread({ id: 'th-review', phase: 'review', role: '獨立驗證', result: { passed: true, evidence: ['npm test：通過'], summary: '全部通過', questions: [] } })],
  });
  assert.deepEqual(states(task), ['✓ 整理需求與計畫', '✓ 核准執行計畫', '✓ 分析需求', '✓ 修改程式', '✓ 執行測試', '✓ 最終驗證']);
  assert.equal(progressSummary(task).label, '6 / 6 個進度項目已完成');
  assert.equal(progressSummary(task).note, '');
});

test('手動完成不會被說成通過驗證', () => {
  const task = baseTask({ status: 'completed', manualCompletion: true, completedSteps: 0 });
  const review = progressSteps(task).find(s => s.key === 'review');
  assert.equal(review.state, 'skipped');
  assert.match(review.note, /不代表已通過 AI 驗證/);
  assert.match(progressSummary(task).note, /手動完成/);
});

test('經同意跳過的驗證會標記為未驗證', () => {
  const task = baseTask({
    status: 'completed',
    completedSteps: 3,
    validationSkips: [{ id: 's1', planVersion: 1, summary: '工具受限' }],
    threads: [thread({ id: 'th-review', phase: 'review', result: { passed: true, evidence: [], questions: [] } })],
  });
  const review = progressSteps(task).find(s => s.key === 'review');
  assert.equal(review.state, 'done');
  assert.match(review.detail, /經同意跳過/);
  assert.match(progressSummary(task).note, /記為未驗證/);
});

// --- G. artifacts / 成果 ------------------------------------------------------

test('發布核准只在有成果版本的已完成任務出現，且不會自稱已對外發布', () => {
  assert.equal(publishState(baseTask({ status: 'running' })), null);
  assert.equal(publishState(baseTask({ status: 'completed', manualCompletion: true, artifactVersion: 'v1' })), null);
  assert.equal(publishState(baseTask({ status: 'completed' })), null);
  const state = publishState(baseTask({ status: 'completed', artifactVersion: 'v1-abc' }));
  assert.deepEqual({ approved: state.approved, version: state.version }, { approved: false, version: 'v1-abc' });
  assert.match(state.note, /不會自動部署/);
  assert.equal(publishState(baseTask({ status: 'completed', artifactVersion: 'v1-abc', publishApproval: { at: 'now' } })).approved, true);
});

test('驗證證據依角色集中，沒有證據的角色不會列出空白區塊', () => {
  const task = baseTask({
    threads: [
      thread({ id: 'a', role: '實作', result: { summary: '改好了', evidence: [], questions: [] } }),
      thread({ id: 'b', phase: 'review', role: '獨立驗證', result: { summary: '檢查完成', evidence: ['npm test：19 passed', 'npm run build：成功'], questions: [] } }),
    ],
  });
  const evidence = validationEvidence(task);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].role, '獨立驗證');
  assert.deepEqual(evidence[0].evidence, ['npm test：19 passed', 'npm run build：成功']);
});

// --- H. browser validation ---------------------------------------------------

test('沒有任務要求 Browser 驗證時，進度不會憑空長出那一列', () => {
  assert.deepEqual(browserValidations(baseTask()), []);
  assert.ok(!progressSteps(baseTask()).some(s => s.key === 'browser'));
});

test('通過的 Browser 驗證顯示為已完成，並帶出網址與工具呼叫次數', () => {
  const validation = { required: true, status: 'passed', executed: true, passed: true, toolUsed: true, toolCallCount: 4, url: 'http://127.0.0.1:5173', checks: [{ description: '登入成功', passed: true }], consoleErrors: [], networkErrors: [], notes: '', error: null };
  const task = baseTask({ completedSteps: 3, threads: [thread({ id: 'th-review', phase: 'review', role: '獨立驗證', result: { passed: true, evidence: [], questions: [], browserValidation: validation } })] });
  const browser = progressSteps(task).find(s => s.key === 'browser');
  assert.equal(browser.state, 'done');
  assert.equal(browser.detail, 'http://127.0.0.1:5173 · 工具呼叫 4 次');
  assert.equal(browserValidations(task).length, 1);
  assert.equal(browserValidations(task)[0].role, '獨立驗證');
});

test('blocked 的 Browser 驗證不會被當成通過，錯誤訊息保留下來', () => {
  const validation = { required: true, status: 'blocked', executed: false, passed: false, toolUsed: false, toolCallCount: 0, url: null, checks: [], consoleErrors: [], networkErrors: [], notes: '', error: '未偵測到 Browser MCP 工具呼叫' };
  const task = baseTask({ threads: [thread({ id: 'th-review', phase: 'review', result: { passed: false, evidence: [], questions: [], browserValidation: validation } })] });
  const browser = progressSteps(task).find(s => s.key === 'browser');
  assert.equal(browser.state, 'blocked');
  assert.equal(browser.mark, '!');
  assert.match(browser.note, /未偵測到 Browser MCP 工具呼叫/);
});

// --- I. 技術資訊 --------------------------------------------------------------

test('技術資訊集中引擎、版本、工作階段與事件數', () => {
  const task = baseTask({ round: 2, artifactVersion: 'v1-abc', events: [{ seq: 1, thread_id: 'th-1', message: 'x' }], threads: [thread({ sessionId: 'sess-9' })] });
  const facts = Object.fromEntries(technicalFacts(task).map(f => [f.label, f.value]));
  assert.equal(facts['任務 ID'], 'task-1');
  assert.equal(facts['計畫版本'], 'v1（已核准 v1）');
  assert.equal(facts['規劃 / 執行 / 驗證引擎'], 'claude / codex / claude');
  assert.equal(facts['工作階段數'], '1');
  assert.equal(facts['事件紀錄數'], '1');
  assert.equal(facts['修正輪次'], '第 2 輪');
  assert.equal(facts['成果版本'], 'v1-abc');
});

test('尚未核准的計畫版本說清楚是尚未核准', () => {
  const facts = Object.fromEntries(technicalFacts(baseTask({ approvedVersion: null })).map(f => [f.label, f.value]));
  assert.equal(facts['計畫版本'], 'v1（尚未核准）');
});

test('thread 的技術欄位包含 Session ID，沒有就不硬湊一列', () => {
  const rows = Object.fromEntries(threadTechnical(thread({ sessionId: 'sess-9', round: 1 })).map(r => [r.label, r.value]));
  assert.equal(rows['Session ID'], 'sess-9');
  assert.equal(rows.Engine, 'codex');
  assert.equal(rows.Round, '1');
  assert.ok(!threadTechnical(thread({ sessionId: null })).some(r => r.label === 'Session ID'));
});

test('執行紀錄只取該 thread 的事件', () => {
  const task = baseTask({ events: [{ seq: 1, thread_id: 'a', message: '1' }, { seq: 2, thread_id: 'b', message: '2' }, { seq: 3, thread_id: 'a', message: '3' }] });
  assert.deepEqual(threadEvents(task, 'a').map(e => e.message), ['1', '3']);
  assert.deepEqual(threadEvents(task, 'a', 1).map(e => e.message), ['3']);
});

// --- K. Run / Attempt ---------------------------------------------------------
// task.runs 由 server/run-attempt.js 的 buildRuns() 算好，這裡只驗證
// task-detail-view.js 挑選顯示欄位的邏輯，不重算分組（分組演算法在
// tests/run-attempt.test.js 已經測過）。

test('taskRuns 直接回傳 task.runs，沒有就給空陣列', () => {
  assert.deepEqual(taskRuns(null), []);
  assert.deepEqual(taskRuns({}), []);
  const runs = [{ id: 'r1', attempts: [] }];
  assert.deepEqual(taskRuns({ runs }), runs);
});

test('runTitle 優先用 server 算好的中文標題，缺漏才用 phase 對照表', () => {
  assert.equal(runTitle({ title: '修改程式', phase: 'execute' }), '修改程式');
  assert.equal(runTitle({ title: '', phase: 'repair_plan' }), '修正方案分析');
  assert.equal(runTitle(null), '');
});

test('attemptLabel 只在重試過一次以上才顯示第幾次／共幾次', () => {
  const single = { attempts: [{ id: 'a' }] };
  const retried = { attempts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.equal(attemptLabel(single, 0), '');
  assert.equal(attemptLabel(retried, 0), '嘗試 1 / 3');
  assert.equal(attemptLabel(retried, 2), '嘗試 3 / 3');
});

// --- J. 防呆 ------------------------------------------------------------------

test('缺資料時不會丟例外', () => {
  assert.deepEqual(pendingActions(null), []);
  assert.deepEqual(progressSteps(null), []);
  assert.deepEqual(technicalFacts(null), []);
  assert.deepEqual(threadTechnical(null), []);
  assert.deepEqual(browserValidations({}), []);
  assert.deepEqual(validationEvidence({}), []);
  assert.deepEqual(threadEvents({}, 'x'), []);
  assert.equal(publishState(null), null);
  assert.deepEqual(taskRuns(null), []);
  assert.equal(runTitle(null), '');
  const empty = progressSteps({ planVersion: 1, status: 'planning' });
  assert.deepEqual(empty.map(s => s.key), ['plan', 'approval', 'review']);
});
