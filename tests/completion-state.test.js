import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCompletionState, COMPLETION_STATUSES, planProgressOf, taskCompletionContext } from '../server/completion-state.js';

// 一份「一切正常、可判定完成」的基準 context：executor 有 claim 有 evidence、
// Git 乾淨、沒有測試 regression、部署與驗收都通過、Browser Validation 通過、沒有待處理事項。
// 各測試從這份基準覆寫要驗的欄位，避免每個案例都要重寫整個 context。
function baseContext(overrides = {}) {
  return {
    executorResult: { passed: true, questions: [], evidence: ['已完成並驗證'], summary: '完成' },
    git: { workingTreeClean: true, headCommit: 'abc1234', gitMerge: { commit: 'abc1234', baseBranch: 'main' }, gitConflict: null },
    tests: {
      completionTest: { status: 'completed', verdict: 'no_regression', newFailures: [] },
      completionMainTest: { status: 'completed', verdict: 'no_regression', newFailures: [] },
    },
    deployment: { status: 'completed', stage: null, results: {}, failure: null },
    runtime: { completionValidation: { status: 'completed', passed: true, checks: [{ name: 'preview', passed: true }] } },
    browserValidation: { required: true, executed: true, passed: true, status: 'passed', error: null, notes: '' },
    pendingActions: { userActionRequired: false, questions: false, gitIssue: false, outputIssue: false, repairApproval: false },
    ...overrides,
  };
}

test('回傳的 status 一定落在合法的十一種狀態之一', () => {
  const result = reconcileCompletionState(baseContext());
  assert.ok(COMPLETION_STATUSES.includes(result.status));
});

// ---- 十一種狀態，各至少一個案例 -------------------------------------------

test('status=running：部署流程正在執行、尚未進入特定階段', () => {
  const result = reconcileCompletionState(baseContext({
    deployment: { status: 'running', stage: null, results: {}, failure: null },
  }));
  assert.equal(result.status, 'running');
  assert.equal(result.passed, false);
});

test('status=awaiting_user：有待使用者處理的 Git 確認事項', () => {
  const result = reconcileCompletionState(baseContext({
    pendingActions: { userActionRequired: false, questions: false, gitIssue: true, outputIssue: false, repairApproval: false },
  }));
  assert.equal(result.status, 'awaiting_user');
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('Git')));
});

test('status=conflicted：Git 合併會產生衝突，即使 executor 回報 passed=true 也不得 completed', () => {
  const result = reconcileCompletionState(baseContext({
    git: { workingTreeClean: true, headCommit: 'abc1234', gitMerge: null, gitConflict: { files: ['a.js', 'b.js'] } },
  }));
  assert.equal(result.status, 'conflicted');
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('a.js') && r.includes('b.js')));
});

test('status=testing：測試比對仍在執行中', () => {
  const result = reconcileCompletionState(baseContext({
    tests: {
      completionTest: { status: 'running', verdict: null, newFailures: [] },
      completionMainTest: { status: 'completed', verdict: 'no_regression', newFailures: [] },
    },
  }));
  assert.equal(result.status, 'testing');
  assert.equal(result.passed, false);
});

test('status=awaiting_approval：修正方案尚待使用者核准', () => {
  const result = reconcileCompletionState(baseContext({
    pendingActions: { userActionRequired: false, questions: false, gitIssue: false, outputIssue: false, repairApproval: true },
  }));
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.passed, false);
});

test('status=merging：部署流程正在執行合併階段', () => {
  const result = reconcileCompletionState(baseContext({
    deployment: { status: 'running', stage: 'merge', results: {}, failure: null },
  }));
  assert.equal(result.status, 'merging');
  assert.equal(result.passed, false);
});

test('status=deploying：部署流程正在執行重啟／推送／清理階段', () => {
  const result = reconcileCompletionState(baseContext({
    deployment: { status: 'running', stage: 'restart', results: {}, failure: null },
  }));
  assert.equal(result.status, 'deploying');
  assert.equal(result.passed, false);
});

test('status=verifying：部署驗收（preview/runtime）仍在執行中', () => {
  const result = reconcileCompletionState(baseContext({
    runtime: { completionValidation: { status: 'running', passed: null, checks: [] } },
  }));
  assert.equal(result.status, 'verifying');
  assert.equal(result.passed, false);
});

test('status=completed：所有必要證據皆通過或不適用，且沒有任何阻擋', () => {
  const result = reconcileCompletionState(baseContext());
  assert.equal(result.status, 'completed');
  assert.equal(result.passed, true);
  assert.equal(result.blockingReasons.length, 0);
});

test('status=failed：有 deterministic 證據（測試 regression）證明未成功', () => {
  const result = reconcileCompletionState(baseContext({
    tests: {
      completionTest: { status: 'completed', verdict: 'regression', newFailures: ['login.test.js > 登入失敗'], newFailureCount: 1 },
      completionMainTest: { status: 'completed', verdict: 'no_regression', newFailures: [] },
    },
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.passed, false);
});

test('status=blocked：executor 完全沒有回傳結果，沒有 claim 可核對，也沒有 deterministic 失敗證據', () => {
  const result = reconcileCompletionState({
    executorResult: null,
    git: { workingTreeClean: true, headCommit: 'abc1234', gitMerge: null, gitConflict: null },
    pendingActions: {},
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.passed, false);
});

// ---- 驗收情境 --------------------------------------------------------------

test('驗收：AI 回傳 passed=true，但 Git conflict 存在時不得 completed，且 blockingReasons 列出衝突檔案', () => {
  const result = reconcileCompletionState(baseContext({
    executorResult: { passed: true, questions: [], evidence: ['已完成'], summary: '完成' },
    git: { workingTreeClean: true, headCommit: 'abc1234', gitMerge: null, gitConflict: { files: ['src/app.js'] } },
  }));
  assert.notEqual(result.status, 'completed');
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('src/app.js')));
});

test('驗收：AI 回傳 completed／passed=true，但 completionTest 為 regression 時不得 completed，blockingReasons 列出新失敗項目', () => {
  const result = reconcileCompletionState(baseContext({
    tests: {
      completionTest: { status: 'completed', verdict: 'regression', newFailures: ['a.test.js > 案例一', 'b.test.js > 案例二'], newFailureCount: 2 },
      completionMainTest: { status: 'completed', verdict: 'no_regression', newFailures: [] },
    },
  }));
  assert.notEqual(result.status, 'completed');
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('a.test.js') && r.includes('b.test.js')));
});

test('驗收：completionMainTest 為 regression（合併後重測新增失敗）時同樣不得 completed', () => {
  const result = reconcileCompletionState(baseContext({
    tests: {
      completionTest: { status: 'completed', verdict: 'no_regression', newFailures: [] },
      completionMainTest: { status: 'completed', verdict: 'regression', newFailures: ['c.test.js > 案例三'], newFailureCount: 1 },
    },
  }));
  assert.notEqual(result.status, 'completed');
  assert.equal(result.status, 'failed');
  assert.ok(result.blockingReasons.some(r => r.includes('c.test.js')));
});

test('驗收：非關鍵欄位缺席但已由 output-validation 補上安全預設值、summary/evidence/passed 仍有效時，直接可達 completed', () => {
  // 模擬 output-validation 對缺欄位（questions/artifacts）補上的安全預設值：空陣列，
  // 不是「需要重跑」的訊號；context 裡完全沒有任何促使重新執行工作的欄位。
  const context = baseContext({
    executorResult: { passed: true, questions: [], evidence: ['已完成並驗證'], summary: '完成' },
  });
  assert.equal('needsRerun' in context, false);
  assert.equal('retryRequired' in context, false);
  const result = reconcileCompletionState(context);
  assert.equal(result.status, 'completed');
  assert.equal(result.passed, true);
});

test('驗收：blockingReasons／warnings／evidence／nextAction 皆為可直接顯示的純文字，不含伺服器磁碟路徑', () => {
  const result = reconcileCompletionState(baseContext({
    git: { workingTreeClean: true, headCommit: 'abc1234', gitMerge: null, gitConflict: { files: ['src/app.js'] } },
  }));
  const diskPathPattern = /^[a-zA-Z]:\\|^\/[a-zA-Z0-9_.-]+\/(home|Users|worktrees|data)\//;
  for (const text of [...result.blockingReasons, ...result.warnings, ...result.evidence, result.nextAction]) {
    assert.equal(typeof text, 'string');
    assert.equal(diskPathPattern.test(text), false, `不應包含伺服器磁碟路徑：${text}`);
  }
});

test('驗收：完全沒有 executorResult 的舊任務資料不拋例外，且不被誤判為 completed 或 failed（沒有 claim 可核對）', () => {
  const result = reconcileCompletionState({});
  assert.doesNotThrow(() => reconcileCompletionState({}));
  assert.ok(COMPLETION_STATUSES.includes(result.status));
  assert.notEqual(result.status, 'completed');
  assert.notEqual(result.status, 'failed');
  assert.equal(result.passed, false);
});

test('驗收：舊任務資料缺 git/completionTest/completionValidation/completion 等欄位，但有完整有效的 claim 時，缺席類別只計入 warnings（不適用），不擋住 completed；不因此拋例外或誤判為 failed', () => {
  const result = reconcileCompletionState({
    executorResult: { passed: true, questions: [], evidence: ['舊任務的既有成果'], summary: '舊任務' },
  });
  assert.ok(COMPLETION_STATUSES.includes(result.status));
  assert.notEqual(result.status, 'failed');
  assert.equal(result.status, 'completed');
  assert.equal(result.passed, true);
  assert.equal(result.blockingReasons.length, 0);
  assert.ok(result.warnings.length > 0, '缺席的證據類別應計入 warnings，標示為不適用／尚未執行');
});

test('驗收：舊任務資料呼叫 reconcileCompletionState 完全不傳 context（undefined）也不拋例外', () => {
  assert.doesNotThrow(() => reconcileCompletionState());
});

test('驗收：缺少 Browser Validation 結果（該任務不需要）不影響其餘證據齊全時判定 completed', () => {
  const result = reconcileCompletionState(baseContext({
    browserValidation: { required: false, executed: false, passed: null, status: 'not_required', error: null, notes: '' },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.passed, true);
});

test('驗收：Browser Validation 必要但未通過時不得 completed', () => {
  const result = reconcileCompletionState(baseContext({
    browserValidation: { required: true, executed: true, passed: false, status: 'failed', error: '核心 API 回傳 404', notes: '' },
  }));
  assert.notEqual(result.status, 'completed');
  assert.equal(result.status, 'failed');
});

// ---- 計畫步驟進度：group-level 完成的前置條件 --------------------------------

test('status=blocked：計畫還有步驟沒完成時，即使這次驗證自己回報 passed 也不得 completed', () => {
  const result = reconcileCompletionState(baseContext({
    planProgress: { total: 6, completed: 1, remaining: 5, nextStepTitle: '擴充 Public／Admin API' },
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('5 個步驟未完成')));
  assert.ok(result.blockingReasons.some(r => r.includes('擴充 Public／Admin API')));
});

test('計畫步驟全部完成時，進度這一項成為 evidence 而不是 blocking', () => {
  const result = reconcileCompletionState(baseContext({
    planProgress: { total: 6, completed: 6, remaining: 0, nextStepTitle: null },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.passed, true);
  assert.ok(result.evidence.some(e => e.includes('6 個步驟已全部執行完成')));
});

test('沒有計畫步驟進度時視為不適用：列入 warnings，不單獨促成也不擋住完成', () => {
  const result = reconcileCompletionState(baseContext());
  assert.equal(result.status, 'completed');
  assert.ok(result.warnings.some(w => w.includes('計畫步驟進度')));
});

test('步驟未完成屬於 blocked 而不是 failed：還沒做完不等於證明失敗', () => {
  const result = reconcileCompletionState(baseContext({
    planProgress: { total: 3, completed: 0, remaining: 3, nextStepTitle: 'Step 1' },
  }));
  assert.equal(result.status, 'blocked');
  assert.notEqual(result.status, 'failed');
});

// ---- planProgressOf：與 runner 派工用的是同一套事實 ---------------------------

test('planProgressOf 只採計本計畫版本中確實通過、且沒有待回答問題的 execute 步驟', () => {
  const task = { planVersion: 2, plan: { steps: [{ title: 'S1' }, { title: 'S2' }, { title: 'S3' }] } };
  const threads = [
    { version: 2, phase: 'execute', status: 'completed', result: { passed: true, questions: [] } },
    { version: 1, phase: 'execute', status: 'completed', result: { passed: true, questions: [] } },      // 舊版本不算
    { version: 2, phase: 'execute', status: 'completed', result: { passed: false, questions: [] } },     // 未通過不算
    { version: 2, phase: 'execute', status: 'completed', result: { passed: true, questions: ['?'] } },   // 有待回答問題不算
    { version: 2, phase: 'execute', status: 'rate_limited', result: null },                              // 未完成不算
    { version: 2, phase: 'review', status: 'completed', result: { passed: true, questions: [] } },       // 不是 execute
  ];
  assert.deepEqual(planProgressOf(task, threads), { total: 3, completed: 1, remaining: 2, nextStepTitle: 'S2' });
});

test('planProgressOf 在沒有計畫或沒有 threads 時回傳零進度而不是丟例外', () => {
  assert.deepEqual(planProgressOf({}, []), { total: 0, completed: 0, remaining: 0, nextStepTitle: null });
  assert.deepEqual(planProgressOf(null, null), { total: 0, completed: 0, remaining: 0, nextStepTitle: null });
});

// ---- taskCompletionContext：所有寫入 completed 的路徑共用同一組證據 -------------

test('taskCompletionContext 會把計畫步驟進度一併帶進核算，未完成的計畫無法判定完成', () => {
  const task = {
    planVersion: 1,
    plan: { steps: [{ title: 'S1' }, { title: 'S2' }] },
    git: { headCommit: 'abc1234' },
    gitMerge: { commit: 'abc1234', baseBranch: 'main' },
    completion: { status: 'completed', failure: null },
    completionValidation: { status: 'completed', passed: true, checks: [{ name: 'preview', passed: true }] },
  };
  const threads = [
    { version: 1, phase: 'execute', status: 'completed', result: { passed: true, questions: [] } },
    { version: 1, phase: 'review', status: 'completed', result: { passed: true, questions: [], evidence: ['已驗證'], summary: 'ok' } },
  ];
  const context = taskCompletionContext(task, threads);
  assert.deepEqual(context.planProgress, { total: 2, completed: 1, remaining: 1, nextStepTitle: 'S2' });
  assert.equal(context.executorResult.passed, true);
  const result = reconcileCompletionState(context);
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('1 個步驟未完成')));
});

test('taskCompletionContext 在部署驗收未通過時核算為 failed，不會停留在 completed', () => {
  const task = {
    planVersion: 1,
    plan: { steps: [{ title: 'S1' }] },
    git: { headCommit: 'abc1234' },
    gitMerge: { commit: 'abc1234', baseBranch: 'main' },
    completion: { status: 'completed', failure: null },
    completionValidation: { status: 'failed', passed: false, checks: [], error: '找不到可預覽的網頁' },
  };
  const threads = [
    { version: 1, phase: 'execute', status: 'completed', result: { passed: true, questions: [] } },
    { version: 1, phase: 'review', status: 'completed', result: { passed: true, questions: [], evidence: ['已驗證'], summary: 'ok' } },
  ];
  const result = reconcileCompletionState(taskCompletionContext(task, threads));
  assert.equal(result.status, 'failed');
  assert.equal(result.passed, false);
  assert.ok(result.blockingReasons.some(r => r.includes('部署驗收')));
});
