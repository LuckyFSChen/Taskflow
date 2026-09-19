import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionAvailable,
  shouldLoadReview,
  mergeBlockers,
  completionStages,
  completionView,
  shortCommit,
} from '../src/completion-view.js';

// 一個已通過獨立驗證、停在待合併狀態的 Git 任務。
function baseTask(extra = {}) {
  return {
    id: 'task-1',
    title: '修好登入頁',
    status: 'completed',
    manualCompletion: null,
    artifactVersion: 'artifact-1',
    planVersion: 1,
    git: {
      mode: 'worktree',
      baseBranch: 'main',
      workingBranch: 'taskflow/20415e0f-login',
      baseCommit: 'c17453a1111111111111111111111111111111111',
      headCommit: '3052fe8222222222222222222222222222222222',
    },
    ...extra,
  };
}

// /api/tasks/:id/git/review 的回傳：正式分支乾淨、停在 main。
function baseReview(extra = {}) {
  return {
    available: true,
    status: 'ready',
    baseBranch: 'main',
    workingBranch: 'taskflow/20415e0f-login',
    baseCommit: 'c17453a1111111111111111111111111111111111',
    headCommit: '3052fe8222222222222222222222222222222222',
    commits: [
      { commit: '3052fe8222222222222222222222222222222222', subject: 'taskflow(execute): 修正登入', at: '2026-09-19T01:00:00.000Z' },
    ],
    repository: { branch: 'main', clean: true, onBaseBranch: true, dirty: [] },
    validation: [{ phase: 'review', role: '獨立驗證', passed: true, browserValidation: 'passed', commit: null }],
    merge: null,
    conflict: null,
    rollback: null,
    cleanedUp: false,
    ...extra,
  };
}

test('shortCommit 取前八碼，取不到就給空字串而不是 undefined', () => {
  assert.equal(shortCommit('3052fe8222222222222222222222222222222222'), '3052fe82');
  assert.equal(shortCommit(null), '');
  assert.equal(shortCommit(''), '');
});

test('只有 git worktree 模式的任務才有部署與驗收', () => {
  assert.equal(completionAvailable(baseTask()), true);
  assert.equal(completionAvailable({ git: null }), false);
  assert.equal(completionAvailable({ git: { mode: 'legacy' } }), false);
  assert.equal(completionAvailable(null), false);
  assert.equal(completionView({ git: null }), null);
});

test('只有可能要合併時才去讀會實際執行 git 指令的 review API', () => {
  assert.equal(shouldLoadReview(baseTask()), true);
  assert.equal(shouldLoadReview(baseTask({ status: 'running' })), false);
  assert.equal(shouldLoadReview(baseTask({ status: 'running', gitMerge: { commit: 'ab3e585' } })), true);
  assert.equal(shouldLoadReview(baseTask({ status: 'running', gitConflict: { files: ['a.js'] } })), true);
  assert.equal(shouldLoadReview({ git: { mode: 'legacy' }, status: 'completed' }), false);
});

test('狀態正常時沒有任何阻擋原因', () => {
  assert.deepEqual(mergeBlockers(baseTask(), baseReview()), []);
});

test('尚未完成獨立驗證不得合併', () => {
  const blockers = mergeBlockers(baseTask({ status: 'running' }), baseReview());
  assert.equal(blockers[0].code, 'not_completed');
});

test('手動標記完成不等於驗收通過，不提供合併', () => {
  const blockers = mergeBlockers(baseTask({ manualCompletion: { by: 'u1', at: '2026-09-19T00:00:00.000Z' } }), baseReview());
  assert.equal(blockers[0].code, 'manual_completion');
});

test('沒有成果版本時擋住合併（後端會比對版本）', () => {
  const blockers = mergeBlockers(baseTask({ artifactVersion: null }), baseReview());
  assert.ok(blockers.some(b => b.code === 'no_artifact_version'));
});

test('衝突一律擋住，且提示不會替使用者選 ours／theirs', () => {
  const review = baseReview({ conflict: { files: ['server/app.js'], hint: 'TaskFlow 不會自行決定 ours／theirs。', workingBranch: 'taskflow/20415e0f-login' } });
  const blockers = mergeBlockers(baseTask(), review);
  const conflict = blockers.find(b => b.code === 'conflict');
  assert.ok(conflict);
  assert.match(conflict.message, /server\/app\.js/);
  assert.match(conflict.hint, /ours／theirs/);
});

test('正式分支沒有被 check out 時擋住，且說明 TaskFlow 不會替你切分支', () => {
  const review = baseReview({ repository: { branch: 'feature/x', clean: true, onBaseBranch: false, dirty: [] } });
  const blocker = mergeBlockers(baseTask(), review).find(b => b.code === 'not_on_base_branch');
  assert.ok(blocker);
  assert.match(blocker.message, /目前在 feature\/x/);
  assert.match(blocker.hint, /不會替你切換分支/);
});

test('正式分支有未提交修改時擋住，且承諾不 reset／clean／stash', () => {
  const review = baseReview({ repository: { branch: 'main', clean: false, onBaseBranch: true, dirty: ['M src/App.vue', '?? notes.txt'] } });
  const blocker = mergeBlockers(baseTask(), review).find(b => b.code === 'dirty_working_tree');
  assert.ok(blocker);
  assert.match(blocker.message, /M src\/App\.vue/);
  assert.match(blocker.hint, /不會 reset、clean、stash/);
});

test('讀不到 Git 狀態時擋住，不假設專案是乾淨的', () => {
  const review = baseReview({ repository: null, repositoryError: 'git status 執行失敗' });
  const blocker = mergeBlockers(baseTask(), review).find(b => b.code === 'repository_error');
  assert.ok(blocker);
  assert.match(blocker.hint, /不會假設專案是乾淨的/);
});

test('已合併的任務只回報 already_merged，不再列其他原因', () => {
  const task = baseTask({ gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', at: '2026-09-19T01:30:00.000Z' } });
  const review = baseReview({ repository: { branch: 'feature/x', clean: false, onBaseBranch: false, dirty: ['M a.js'] } });
  const blockers = mergeBlockers(task, review);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, 'already_merged');
});

test('review 還沒讀到之前，絕不宣稱可以合併', () => {
  const view = completionView(baseTask(), null);
  assert.equal(view.state, 'loading');
  assert.equal(view.canMerge, false);
  assert.match(view.message, /讀到之前不會顯示可否合併/);
});

test('狀態齊備時才開放合併，並帶出要送回後端的成果版本', () => {
  const view = completionView(baseTask(), baseReview());
  assert.equal(view.state, 'ready');
  assert.equal(view.canMerge, true);
  assert.equal(view.artifactVersion, 'artifact-1');
  assert.equal(view.branch.headCommit, '3052fe82');
  assert.equal(view.commits[0].short, '3052fe82');
  assert.deepEqual(view.blockers, []);
});

test('被擋住時不開放合併，且逐條列出原因', () => {
  const review = baseReview({ repository: { branch: 'main', clean: false, onBaseBranch: true, dirty: ['M a.js'] } });
  const view = completionView(baseTask(), review);
  assert.equal(view.state, 'blocked');
  assert.equal(view.canMerge, false);
  assert.equal(view.blockers.length, 1);
});

test('有衝突時狀態是 conflict，合併階段標記為未通過', () => {
  const review = baseReview({ conflict: { files: ['server/app.js'], workingBranch: 'taskflow/20415e0f-login' } });
  const view = completionView(baseTask(), review);
  assert.equal(view.state, 'conflict');
  assert.equal(view.canMerge, false);
  const merge = view.stages.find(s => s.key === 'merge');
  assert.equal(merge.state, 'failed');
});

test('合併完成後改為顯示已合併，並可撤銷', () => {
  const task = baseTask({ gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', workingBranch: 'taskflow/20415e0f-login', at: '2026-09-19T01:30:00.000Z' } });
  const view = completionView(task, baseReview({ cleanedUp: true }));
  assert.equal(view.state, 'merged');
  assert.equal(view.canMerge, false);
  assert.equal(view.canRollback, true);
  assert.equal(view.mergeCommit, 'ab3e585333333333333333333333333333333333');
  assert.equal(completionView(baseTask(), baseReview()).mergeCommit, '');
  assert.equal(view.stages.find(s => s.key === 'merge').state, 'done');
  assert.equal(view.stages.find(s => s.key === 'cleanup').state, 'done');
});

test('每個狀態都對應得到既有的 badge 樣式（template 不再自帶對照表）', () => {
  const merged = { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', at: '2026-09-19T01:30:00.000Z' };
  const cases = [
    [completionView(baseTask(), baseReview()), 'ready', 'completed'],
    [completionView(baseTask(), null), 'loading', 'queued'],
    [completionView(baseTask({ status: 'running' }), baseReview()), 'blocked', 'paused'],
    [completionView(baseTask(), baseReview({ conflict: { files: ['a.js'] } })), 'conflict', 'failed'],
    [completionView(baseTask({ gitMerge: merged }), baseReview()), 'merged', 'completed'],
    [completionView(baseTask({ gitMerge: merged, gitRollback: { commit: 'dd11aa22' } }), baseReview()), 'rolled_back', 'cancelled'],
  ];
  for (const [view, state, badge] of cases) {
    assert.equal(view.state, state);
    assert.equal(view.badgeClass, badge);
  }
});

test('merge 摘要帶好短碼，template 不必自己切字串', () => {
  const task = baseTask({ gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', at: '2026-09-19T01:30:00.000Z' } });
  assert.equal(completionView(task, baseReview()).merge.short, 'ab3e5853');
});

test('已撤銷過的合併不再提供第二次撤銷', () => {
  const task = baseTask({
    gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', at: '2026-09-19T01:30:00.000Z' },
    gitRollback: { commit: 'dd11aa22', mergeCommit: 'ab3e585333333333333333333333333333333333', at: '2026-09-19T02:00:00.000Z' },
  });
  const view = completionView(task, baseReview());
  assert.equal(view.state, 'rolled_back');
  assert.equal(view.canRollback, false);
});

test('階段清單只由真實資料推導，未知的一律 pending', () => {
  const stages = completionStages(baseTask({ status: 'running' }), null);
  assert.deepEqual(stages.map(s => s.key), ['implementation', 'review', 'test', 'merge', 'validate', 'cleanup']);
  assert.equal(stages.find(s => s.key === 'test').state, 'pending');
  assert.equal(stages.find(s => s.key === 'implementation').state, 'pending');
  assert.equal(stages.find(s => s.key === 'review').state, 'pending');
  assert.equal(stages.find(s => s.key === 'cleanup').state, 'pending');
});

test('獨立驗證未通過時階段標記為未通過', () => {
  const review = baseReview({ validation: [{ phase: 'review', role: '獨立驗證', passed: false, browserValidation: 'failed' }] });
  const stages = completionStages(baseTask({ status: 'running' }), review);
  assert.equal(stages.find(s => s.key === 'review').state, 'failed');
});

// --- 測試比對 ---------------------------------------------------------------

function withTest(report) {
  return baseTask({ completionTest: { id: 'test-1', status: 'completed', baseBranch: 'main', ...report } });
}

test('沒跑過測試比對時不顯示結論，也不擋住合併（維持既有行為）', () => {
  const view = completionView(baseTask(), baseReview());
  assert.equal(view.test, null);
  assert.equal(view.canMerge, true);
  assert.equal(view.canRunTest, true);
  assert.equal(view.stages.find(s => s.key === 'test').state, 'pending');
});

test('比對執行中：擋住合併，也不能重複觸發', () => {
  const view = completionView(withTest({ status: 'running', verdict: null }), baseReview());
  assert.equal(view.canMerge, false);
  assert.equal(view.canRunTest, false);
  assert.equal(view.test.running, true);
  assert.equal(view.stages.find(s => s.key === 'test').state, 'active');
  assert.ok(view.blockers.some(b => b.code === 'test_running'));
});

test('沒有新增失敗：放行，並說明基準上原本就有幾項失敗', () => {
  const view = completionView(withTest({
    verdict: 'no_regression',
    baseline: { ok: true, total: 344, passed: 341, failedCount: 3, failed: [] },
    current: { ok: true, total: 351, passed: 348, failedCount: 3, failed: [] },
  }), baseReview());
  assert.equal(view.canMerge, true);
  assert.equal(view.test.toneClass, 'completed');
  assert.equal(view.stages.find(s => s.key === 'test').state, 'done');
  assert.match(view.stages.find(s => s.key === 'test').detail, /既有 3 項/);
});

test('有新增失敗：擋住合併，並指名是哪幾項', () => {
  const view = completionView(withTest({
    verdict: 'regression',
    newFailures: ['tests/a.test.js > 新壞掉的測試', 'tests/b.test.js > 另一個'],
    newFailureCount: 2,
    baseline: { ok: true, total: 344, failedCount: 3, failed: [] },
    current: { ok: true, total: 344, failedCount: 5, failed: [] },
  }), baseReview());
  assert.equal(view.canMerge, false);
  assert.equal(view.test.toneClass, 'failed');
  assert.equal(view.stages.find(s => s.key === 'test').state, 'failed');
  const blocker = view.blockers.find(b => b.code === 'test_regression');
  assert.ok(blocker);
  assert.match(blocker.message, /新壞掉的測試/);
  assert.match(blocker.message, /2 項/);
});

test('讀不懂結果或拿不到基準：顯示警告但不自動擋住，也絕不宣稱通過', () => {
  for (const verdict of ['parse_failed', 'baseline_unavailable']) {
    const view = completionView(withTest({ verdict, current: { ok: false, reason: 'not_tap' } }), baseReview());
    assert.equal(view.canMerge, true, verdict);
    assert.equal(view.test.blocks, false, verdict);
    assert.equal(view.test.toneClass, 'paused', verdict);
    assert.equal(view.stages.find(s => s.key === 'test').state, 'blocked', verdict);
    assert.equal(view.blockers.some(b => b.code === 'test_regression'), false, verdict);
  }
});

test('解析失敗的原因要翻成看得懂的說明', () => {
  const view = completionView(withTest({ verdict: 'parse_failed', current: { ok: false, reason: 'summary_mismatch' } }), baseReview());
  assert.match(view.test.current.reasonText, /摘要不符/);
});

test('服務重啟中斷的比對顯示為已中斷，可以重跑', () => {
  const view = completionView(withTest({ status: 'interrupted', verdict: null, error: '上次的測試比對在服務重新啟動時中斷' }), baseReview());
  assert.equal(view.test.interrupted, true);
  assert.equal(view.canRunTest, true);
  assert.equal(view.canMerge, true);
});

test('已合併或工作副本清掉之後不再提供測試比對', () => {
  const merged = completionView(baseTask({ gitMerge: { commit: 'ab3e5853', baseBranch: 'main' } }), baseReview());
  assert.equal(merged.canRunTest, false);
  const cleaned = completionView(baseTask(), baseReview({ cleanedUp: true }));
  assert.equal(cleaned.canRunTest, false);
});

// --- 重新啟動正式 TaskFlow ----------------------------------------------------

const mergedSelf = (extra = {}) => baseTask({
  selfProject: true,
  guardianOnline: true,
  gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', at: '2026-09-19T01:30:00.000Z' },
  ...extra,
});

test('其他專案的任務不顯示「重新啟動正式 TaskFlow」', () => {
  const view = completionView(baseTask({ selfProject: false }), baseReview());
  assert.equal(view.restart, null);
  assert.equal(view.canRestart, false);
  assert.equal(view.stages.some(s => s.key === 'restart'), false);
});

test('TaskFlow 自己的任務合併後才給重新啟動按鈕', () => {
  const beforeMerge = completionView(baseTask({ selfProject: true, guardianOnline: true }), baseReview());
  assert.equal(beforeMerge.canRestart, false);
  assert.equal(beforeMerge.stages.find(s => s.key === 'restart').state, 'pending');

  const afterMerge = completionView(mergedSelf(), baseReview());
  assert.equal(afterMerge.canRestart, true);
  assert.equal(afterMerge.restart.status, 'none');
  assert.equal(afterMerge.stages.find(s => s.key === 'restart').detail, '等待你核准');
});

test('守護程式沒在跑就不假裝可以重啟，並指出要啟動哪一支', () => {
  const view = completionView(mergedSelf({ guardianOnline: false }), baseReview());
  assert.equal(view.canRestart, false);
  assert.match(view.restart.guardianNote, /Start-Service-Guardian/);
});

test('排隊中與執行中都算進行中，不能重複核准', () => {
  for (const status of ['pending', 'running']) {
    const view = completionView(mergedSelf({ completionRestart: { status, active: true, attempts: 1, maxAttempts: 2 } }), baseReview());
    assert.equal(view.canRestart, false, status);
    assert.equal(view.restart.active, true, status);
    assert.equal(view.stages.find(s => s.key === 'restart').state, 'active', status);
  }
});

test('因為有 AI 工作在跑而延後，要說成延後而不是失敗', () => {
  const view = completionView(mergedSelf({
    completionRestart: { status: 'pending', active: true, note: '目前仍有 AI 工作在執行，重新啟動已延後，稍後會自動再試。', attempts: 0, maxAttempts: 2 },
  }), baseReview());
  assert.match(view.restart.label, /延後/);
  assert.equal(view.restart.toneClass, 'queued');
  assert.equal(view.restart.error, null);
});

test('重啟成功顯示版本與服務網址；失敗顯示原因與重試上限', () => {
  const ok = completionView(mergedSelf({
    completionRestart: { status: 'success', active: false, expectedCommit: 'ab3e585333333333333333333333333333333333', url: 'https://taskflow.example.com', attempts: 1, maxAttempts: 2 },
  }), baseReview());
  assert.equal(ok.restart.toneClass, 'completed');
  assert.equal(ok.restart.expectedCommit, 'ab3e5853');
  assert.equal(ok.stages.find(s => s.key === 'restart').state, 'done');
  assert.equal(ok.canRestart, true); // 可以再重啟一次

  const bad = completionView(mergedSelf({
    completionRestart: { status: 'failed', active: false, error: 'Build failed with exit code 2', attempts: 2, maxAttempts: 2 },
  }), baseReview());
  assert.equal(bad.restart.toneClass, 'failed');
  assert.match(bad.restart.error, /Build failed/);
  assert.equal(bad.stages.find(s => s.key === 'restart').state, 'failed');
});

// --- 部署驗收 ----------------------------------------------------------------

const mergedTask = (extra = {}) => baseTask({
  gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', at: '2026-09-19T01:30:00.000Z' },
  ...extra,
});
const passedChecks = [
  { name: 'health', passed: true, expected: '200', actual: 'HTTP 200' },
  { name: 'login', passed: true, expected: '200', actual: 'HTTP 200' },
  { name: 'state', passed: true, expected: '200', actual: 'HTTP 200' },
  { name: 'preview_stopped', passed: true, expected: 'Preview 程序已結束', actual: '已結束' },
];

test('合併之前不提供部署驗收；合併之後才可以執行', () => {
  const before = completionView(baseTask(), baseReview());
  assert.equal(before.canValidate, false);
  assert.equal(before.validation, null);
  assert.equal(before.stages.find(s => s.key === 'validate').detail, '合併後才需要');

  const after = completionView(mergedTask(), baseReview());
  assert.equal(after.canValidate, true);
  assert.equal(after.stages.find(s => s.key === 'validate').detail, '合併後可執行');
});

test('四項全部通過才算通過，並把每一項的預期與實際攤出來', () => {
  const view = completionView(mergedTask({
    completionValidation: { id: 'v1', status: 'completed', passed: true, checks: passedChecks, url: 'http://127.0.0.1:61347', pid: 48216, previewStopped: true },
  }), baseReview());
  assert.equal(view.validation.passed, true);
  assert.equal(view.validation.toneClass, 'completed');
  assert.equal(view.validation.label, '通過');
  assert.equal(view.stages.find(s => s.key === 'validate').state, 'done');
  assert.deepEqual(view.validation.checks.map(c => c.label), ['/api/health', 'POST /api/login', '/api/state', 'Preview 程序已結束']);
});

test('Preview 程序沒有確認消失，就算三個 API 都通過也不算通過', () => {
  const checks = [...passedChecks.slice(0, 3), { name: 'preview_stopped', passed: false, expected: 'Preview 程序已結束', actual: '仍然存在', detail: '停止指令已送出，但這個 PID 仍然存在' }];
  const view = completionView(mergedTask({
    completionValidation: { id: 'v1', status: 'completed', passed: false, checks, pid: 48216, previewStopped: false },
  }), baseReview());
  assert.equal(view.validation.passed, false);
  assert.equal(view.validation.failedCount, 1);
  assert.equal(view.validation.previewStopped, false);
  assert.equal(view.stages.find(s => s.key === 'validate').state, 'failed');
});

test('驗收執行中不能重複觸發；被服務重啟打斷時顯示已中斷且可以重跑', () => {
  const running = completionView(mergedTask({ completionValidation: { id: 'v1', status: 'running', passed: false, checks: [] } }), baseReview());
  assert.equal(running.canValidate, false);
  assert.equal(running.stages.find(s => s.key === 'validate').state, 'active');

  const interrupted = completionView(mergedTask({
    completionValidation: { id: 'v1', status: 'interrupted', passed: false, checks: [], error: '上次的部署驗收在服務重新啟動時中斷' },
  }), baseReview());
  assert.equal(interrupted.canValidate, true);
  assert.equal(interrupted.validation.label, '已中斷');
  assert.equal(interrupted.stages.find(s => s.key === 'validate').state, 'blocked');
});

test('明講目前尚未涵蓋 Browser Validation，不把未實作畫成尚未開始', () => {
  const view = completionView(baseTask(), baseReview());
  assert.match(view.scopeNote, /尚未納入/);
  assert.equal(view.stages.some(s => /Browser/.test(s.label)), false);
});
