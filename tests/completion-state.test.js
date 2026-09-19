import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCompletionState, COMPLETION_STATUSES } from '../server/completion-state.js';

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

test('驗收：舊任務資料完全沒有 git/completionTest/completionValidation 等欄位時不拋例外，且不被誤判為 completed 或 failed', () => {
  assert.doesNotThrow(() => reconcileCompletionState({}));
  const result = reconcileCompletionState({
    executorResult: { passed: true, questions: [], evidence: ['舊任務的既有成果'], summary: '舊任務' },
  });
  assert.ok(COMPLETION_STATUSES.includes(result.status));
  assert.notEqual(result.status, 'completed');
  assert.notEqual(result.status, 'failed');
  assert.equal(result.passed, false);
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
