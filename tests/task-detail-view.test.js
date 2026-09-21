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
  validationFailureView,
  publishState,
  technicalFacts,
  threadTechnical,
  threadEvents,
  taskRuns,
  runTitle,
  attemptLabel,
  runtimeView,
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

// --- G2. reconcileCompletionState 的權威判定（server/completion-state.js）--------

test('沒有驗證失敗紀錄時不顯示任何東西', () => {
  assert.equal(validationFailureView(baseTask()), null);
  assert.equal(validationFailureView(null), null);
});

test('驗證未通過：把 blockingReasons／warnings／nextAction 攤成純文字給畫面用', () => {
  const task = baseTask({
    validationFailure: {
      summary: '驗收未通過',
      evidence: ['npm test：2 failed'],
      questions: [],
      blockingReasons: ['測試比對發現 2 項新的失敗：tests/a.test.js、tests/b.test.js'],
      warnings: ['沒有部署驗收（preview/runtime）結果（不適用或尚未執行）。'],
      nextAction: '有 deterministic 證據（測試 regression、部署階段失敗、驗收未通過等）證明未成功，需要修正後重新執行失敗的檢查。',
    },
  });
  const view = validationFailureView(task);
  assert.deepEqual(view.blockingReasons, ['測試比對發現 2 項新的失敗：tests/a.test.js、tests/b.test.js']);
  assert.deepEqual(view.warnings, ['沒有部署驗收（preview/runtime）結果（不適用或尚未執行）。']);
  assert.match(view.nextAction, /需要修正後重新執行失敗的檢查/);
});

test('舊任務資料沒有 blockingReasons／warnings／nextAction 時回傳空陣列，不丟例外', () => {
  const view = validationFailureView(baseTask({ validationFailure: { summary: '舊資料', evidence: [], questions: [] } }));
  assert.deepEqual(view.blockingReasons, []);
  assert.deepEqual(view.warnings, []);
  assert.equal(view.nextAction, null);
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
  assert.equal(validationFailureView({}), null);
  assert.deepEqual(threadEvents({}, 'x'), []);
  assert.equal(publishState(null), null);
  assert.deepEqual(taskRuns(null), []);
  assert.equal(runTitle(null), '');
  const empty = progressSteps({ planVersion: 1, status: 'planning' });
  assert.deepEqual(empty.map(s => s.key), ['plan', 'approval', 'review']);
});

test('步驟還沒做完時，先前那次驗證不會被顯示成「最終驗證：已完成」', () => {
  // 迴歸測試：Task Group 1 只完成 6 步中的第 1 步，畫面卻同時顯示
  // 「3 / 9 個進度項目已完成」與「最終驗證：已完成」。最終驗證是 group-level 的，
  // 只有在計畫步驟全部完成之後才能代表整份計畫已驗證。
  const task = baseTask({
    status: 'running',
    completedSteps: 1,
    threads: [thread({ id: 'th-review', phase: 'review', role: '獨立驗證', result: { passed: true, evidence: ['第 1 步已驗證'], summary: '第 1 步通過', questions: [] } })],
  });
  const review = progressSteps(task).find(s => s.key === 'review');
  assert.equal(review.state, 'pending');
  assert.match(review.note, /尚有 2 個計畫步驟未完成/);
  assert.notEqual(progressSummary(task).done, progressSummary(task).total);
});

test('步驟全部完成後，通過的驗證才顯示為已完成', () => {
  const task = baseTask({
    status: 'completed',
    completedSteps: 3,
    threads: [thread({ id: 'th-review', phase: 'review', role: '獨立驗證', result: { passed: true, evidence: ['全部驗證'], summary: '通過', questions: [] } })],
  });
  assert.equal(progressSteps(task).find(s => s.key === 'review').state, 'done');
});

// ---- 重新規劃之後，舊版本的紀錄不得污染目前狀態 -------------------------------
// 真實事故：Task Group 2 重新規劃到 v5 之後，畫面顯示 7/11 個項目已完成、v5 的第 3、4 步
// 打勾、還多出「第 1 輪修正方案」——但 v5 只完成 2 步，第 3 步是失敗的，第 4 步沒跑過，
// 而 v5 的 round 是 0。原因是讀取端每個推導函式都直接讀 task.threads（所有版本），
// 沒有套用 runner 派工時用的同一條規則（只看 version === planVersion）。

function replannedTask(extra = {}) {
  // v1 跑過三步、做過一輪修正、也跑過一次通過的最終驗證；使用者接著補充需求重新規劃成 v2。
  return baseTask({
    planVersion: 2,
    approvedVersion: 2,
    round: 0,
    completedSteps: 0,
    threads: [
      thread({ id: 'v1-s1', version: 1, result: { passed: true, questions: [], evidence: ['v1 證據一'], summary: 'v1 第一步' } }),
      thread({ id: 'v1-s2', version: 1, result: { passed: true, questions: [], evidence: ['v1 證據二'], summary: 'v1 第二步' } }),
      thread({ id: 'v1-s3', version: 1, result: { passed: true, questions: [], evidence: [], summary: 'v1 第三步' } }),
      thread({ id: 'v1-repair-plan', version: 1, phase: 'repair_plan', round: 1, result: { questions: [] } }),
      thread({ id: 'v1-repair', version: 1, phase: 'repair', round: 1, result: { passed: true, questions: [], evidence: [], summary: 'v1 修正' } }),
      thread({ id: 'v1-review', version: 1, phase: 'review', role: '獨立驗證', result: { passed: true, questions: [], evidence: ['v1 驗證通過'], summary: 'v1 全部通過' } }),
      thread({ id: 'v1-browser', version: 1, result: { passed: true, questions: [], evidence: [], summary: 'v1 瀏覽器', browserValidation: { required: true, status: 'passed', executed: true, passed: true, toolCallCount: 4, url: 'http://127.0.0.1:1111' } } }),
    ],
    ...extra,
  });
}

test('舊版本已完成的步驟不會被算進目前計畫的進度', () => {
  const task = replannedTask();
  // v1 有三步通過，但 v2 一步都還沒跑完。
  assert.deepEqual(states(task), ['✓ 整理需求與計畫', '✓ 核准執行計畫', '→ 分析需求', '○ 修改程式', '○ 執行測試', '○ 最終驗證']);
  assert.equal(progressSummary(task).done, 2, '只有規劃與核准兩項屬於目前狀態');
});

test('舊版本的修正輪次不會出現在目前計畫的進度裡', () => {
  const labels = progressSteps(replannedTask()).map(s => s.label);
  assert.ok(!labels.some(label => label.includes('修正')), labels.join(' | '));
});

test('舊版本通過的最終驗證不會讓目前計畫顯示為已驗證', () => {
  const review = progressSteps(replannedTask()).find(s => s.key === 'review');
  assert.equal(review.state, 'pending', 'v1 的驗證不能代表 v2');
});

test('舊版本的 Browser 驗證不會成為目前的 Browser 驗證狀態', () => {
  const task = replannedTask();
  assert.equal(browserValidations(task).length, 0, 'v1 的紀錄不屬於目前版本');
  assert.ok(!progressSteps(task).some(s => s.key === 'browser'), '目前版本還沒有任何 Browser 驗證紀錄，就不該畫這一列');
});

test('舊版本的驗證證據不會顯示為目前的證據', () => {
  const task = replannedTask();
  assert.deepEqual(validationEvidence(task), [], 'v1 的證據屬於歷史，不是 v2 的成果');
  const withCurrent = replannedTask({
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: true, questions: [], evidence: ['v2 證據'], summary: 'v2 第一步' } })],
  });
  assert.deepEqual(validationEvidence(withCurrent).map(e => e.evidence).flat(), ['v2 證據']);
});

test('目前版本的紀錄照常採計，過濾不會把現在的東西也濾掉', () => {
  const task = replannedTask({
    completedSteps: 1,
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: true, questions: [], evidence: ['v2 證據'], summary: 'v2 第一步' } })],
  });
  assert.deepEqual(states(task).slice(2, 5), ['✓ 分析需求', '→ 修改程式', '○ 執行測試']);
});

test('歷史不會被刪掉：所有版本的工作階段仍然看得到', () => {
  const task = replannedTask();
  assert.equal(task.threads.length, 7, '推導不得改動來源資料');
  const facts = technicalFacts(task);
  assert.equal(facts.find(f => f.label === '工作階段數').value, '7', '技術資訊是歷史檢視，要涵蓋每個版本');
  assert.match(facts.find(f => f.label === '計畫版本').value, /^v2/);
});

// ---- 目前計畫的步驟狀態必須分得出 pending / running / passed / failed ----------
// 真實事故：v5 的第 3 步實際回傳 passed=false，進度卻畫成「尚未開始」，而待處理橫幅
// 同時寫著「此步驟未通過驗收：test minimal」——兩邊互相矛盾。

function stepState(task, key = 'step-0') {
  return progressSteps(task).find(s => s.key === key);
}

test('目前版本的步驟失敗時顯示 failed，而不是「尚未開始」', () => {
  const task = replannedTask({
    status: 'waiting_input',
    questions: ['此步驟未通過驗收：測試沒過'],
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: false, questions: [], evidence: [], summary: '測試沒過' } })],
  });
  const first = stepState(task);
  assert.equal(first.state, 'failed');
  assert.equal(first.note, '驗收未通過：測試沒過');
  assert.equal(first.label, '分析需求', '標題必須維持計畫裡的步驟名稱');
});

test('步驟尚未執行時顯示 pending', () => {
  const task = replannedTask({ status: 'paused' });
  assert.equal(stepState(task).state, 'pending');
});

test('步驟通過時顯示 done', () => {
  const task = replannedTask({
    completedSteps: 1,
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: true, questions: [], evidence: ['ok'], summary: '做完了' } })],
  });
  assert.equal(stepState(task).state, 'done');
});

test('步驟執行中時顯示 active，不會因為上一次失敗就標成 failed', () => {
  const task = replannedTask({
    status: 'running',
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1-fail', version: 2, result: { passed: false, questions: [], evidence: [], summary: '第一次沒過' } }),
      thread({ id: 'v2-s1-retry', version: 2, status: 'running', result: null })],
  });
  assert.equal(stepState(task).state, 'active');
});

test('平台已經在重跑（queued）時不再標成失敗', () => {
  const task = replannedTask({
    status: 'queued',
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: false, questions: [], evidence: [], summary: '沒過' } })],
  });
  assert.equal(stepState(task).state, 'active');
});

test('失敗摘要會截斷，不把任意長度的 agent 輸出塞進進度列', () => {
  const task = replannedTask({
    status: 'waiting_input',
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: false, questions: [], evidence: [], summary: '錯'.repeat(400) } })],
  });
  const first = stepState(task);
  assert.ok(first.note.length < 80, `實際長度 ${first.note.length}`);
  assert.match(first.note, /^驗收未通過：/);
  assert.match(first.note, /…$/);
});

test('失敗但沒有摘要時仍然說得出「驗收未通過」', () => {
  const task = replannedTask({
    status: 'waiting_input',
    threads: [...replannedTask().threads,
      thread({ id: 'v2-s1', version: 2, result: { passed: false, questions: [], evidence: [], summary: '' } })],
  });
  assert.equal(stepState(task).note, '驗收未通過');
});

test('推導是純函式：重複計算結果完全一致', () => {
  const task = replannedTask();
  assert.deepEqual(progressSteps(task), progressSteps(task));
  assert.deepEqual(progressSummary(task), progressSummary(task));
  assert.deepEqual(browserValidations(task), browserValidations(task));
});

// --- Runtime（PID / Port / State） -------------------------------------------

test('沒有 preview 或沒有 runtime 時視為 Runtime 已停止', () => {
  assert.equal(runtimeView(null), null);
  assert.equal(runtimeView({}), null);
  assert.equal(runtimeView({ runtime: null }), null);
});

test('runtime 存在時列出每個 service 的 PID／Port／State，並把英文狀態換成中文標籤', () => {
  const preview = {
    runtime: {
      status: 'READY',
      error: null,
      services: [
        { id: 'backend', type: 'node', status: 'READY', url: 'http://127.0.0.1:45017', port: 45017, pid: 12345 },
        { id: 'frontend', type: 'vite', status: 'STARTING', url: null, port: 45018, pid: 12389 },
      ],
    },
  };
  const view = runtimeView(preview);
  assert.equal(view.status, 'READY');
  assert.deepEqual(view.services.map(s => [s.id, s.port, s.pid, s.state, s.stateLabel]), [
    ['backend', 45017, 12345, 'READY', '執行中'],
    ['frontend', 45018, 12389, 'STARTING', '啟動中'],
  ]);
});

test('service 缺 port／pid 時給 null，不假裝有數值；TaskFlow 自管的服務沒有 pid', () => {
  const preview = { runtime: { status: 'FAILED', error: '啟動失敗', services: [
    { id: 'proxy', type: 'static', status: 'FAILED', port: null, pid: null, error: '連線被拒絕' },
  ] } };
  const view = runtimeView(preview);
  assert.equal(view.error, '啟動失敗');
  assert.deepEqual(view.services[0], {
    id: 'proxy', type: 'static', port: null, pid: null, state: 'FAILED', stateLabel: '失敗', url: '', error: '連線被拒絕',
  });
});

test('推導是純函式：重複計算 runtimeView 結果完全一致', () => {
  const preview = { runtime: { status: 'READY', error: null, services: [{ id: 'backend', type: 'node', status: 'READY', port: 45017, pid: 1 }] } };
  assert.deepEqual(runtimeView(preview), runtimeView(preview));
});
