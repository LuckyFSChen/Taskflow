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

// 生命週期改造：合併驗證通過後 task.status 會被後端推進到 ready_to_close，
// 這裡不再只看 gitMerge 存不存在——task.status 是唯一的權威來源（計畫書第二十八章）。
test('合併驗證通過後 status=ready_to_close：隱藏 Merge 按鈕，改顯示關閉任務', () => {
  const task = baseTask({ status: 'ready_to_close', readyToCloseAt: '2026-09-19T01:31:00.000Z', gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', workingBranch: 'taskflow/20415e0f-login', at: '2026-09-19T01:30:00.000Z' } });
  const view = completionView(task, baseReview({ cleanedUp: false }));
  assert.equal(view.state, 'ready_to_close');
  assert.equal(view.badgeClass, 'queued');
  assert.equal(view.canMerge, false);
  assert.equal(view.canClose, true);
  assert.equal(view.canRollback, true);
  assert.match(view.message, /按下「關閉任務」/);
});

test('使用者關閉任務後 status=closed：不再提供撤銷或關閉按鈕', () => {
  const task = baseTask({ status: 'closed', closedAt: '2026-09-19T02:00:00.000Z', closedBy: 'user-1', gitMerge: { commit: 'ab3e585333333333333333333333333333333333', baseBranch: 'main', workingBranch: 'taskflow/20415e0f-login', at: '2026-09-19T01:30:00.000Z' } });
  const view = completionView(task, baseReview({ cleanedUp: true }));
  assert.equal(view.state, 'closed');
  assert.equal(view.badgeClass, 'completed');
  assert.equal(view.canMerge, false);
  assert.equal(view.canClose, false);
  assert.equal(view.canRollback, false, 'closed 是 archive，不再提供撤銷');
  // 關閉後歷史仍然完整可查：commits／merge metadata 都還在畫面資料裡。
  assert.ok(view.merge);
  assert.equal(view.commits.length, 1);
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
    [completionView(baseTask({ status: 'ready_to_close', gitMerge: merged }), baseReview()), 'ready_to_close', 'queued'],
    [completionView(baseTask({ status: 'closed', gitMerge: merged }), baseReview()), 'closed', 'completed'],
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
  assert.deepEqual(stages.map(s => s.key), ['implementation', 'review', 'test', 'merge', 'test_main', 'validate', 'cleanup']);
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

test('沒有新增失敗但基準有既有失敗：回傳 existingFailureCount／unchangedFailureCount 供畫面顯示', () => {
  const view = completionView(withTest({
    verdict: 'no_regression',
    newFailures: [], newFailureCount: 0,
    existingFailures: ['tests/a.test.js > 舊壞掉的測試', 'tests/b.test.js > 另一個舊的'],
    existingFailureCount: 2,
    unchangedFailures: ['tests/a.test.js > 舊壞掉的測試', 'tests/b.test.js > 另一個舊的'],
    unchangedFailureCount: 2,
    baseline: { ok: true, total: 147, passed: 145, failedCount: 2, failed: [] },
    current: { ok: true, total: 153, passed: 151, failedCount: 2, failed: [] },
  }), baseReview());
  assert.equal(view.canMerge, true);
  assert.equal(view.test.verdict, 'no_regression');
  assert.equal(view.test.newFailureCount, 0);
  assert.equal(view.test.existingFailureCount, 2);
  assert.equal(view.test.unchangedFailureCount, 2);
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

// --- 一次核准的部署流程 --------------------------------------------------------

const pipeline = (extra = {}) => ({
  id: 'pipe-1', status: 'running', stage: 'merge',
  stages: [
    { key: 'test', label: '測試比對', ok: true, current: false, failed: false },
    { key: 'merge', label: '合併到正式分支', ok: false, current: true, failed: false },
    { key: 'cleanup', label: '清理工作副本與分支', ok: false, current: false, failed: false },
  ],
  approvedByName: 'Lucky', approvedAt: '2026-09-19T05:00:00.000Z', failure: null,
  ...extra,
});

test('沒有流程在跑時提供「一次核准」，時機與可以合併一致', () => {
  const ready = completionView(baseTask(), baseReview());
  assert.equal(ready.canApprovePipeline, true);
  assert.equal(ready.pipeline, null);

  // 被任何原因擋住合併時，也不該提供一次核准
  const blocked = completionView(baseTask({ status: 'running' }), baseReview());
  assert.equal(blocked.canApprovePipeline, false);
});

test('流程進行中時，單顆按鈕一律停用，避免兩條路徑同時動同一個任務', () => {
  const view = completionView(baseTask({ completion: pipeline() }), baseReview());
  assert.equal(view.pipeline.running, true);
  assert.equal(view.canApprovePipeline, false);
  assert.equal(view.canMerge, false);
  assert.equal(view.canRunTest, false);
  assert.equal(view.canValidate, false);
});

test('階段標記由後端狀態機決定，畫面不做第二套判斷', () => {
  const view = completionView(baseTask({ completion: pipeline() }), baseReview());
  assert.deepEqual(view.pipeline.stages.map(s => s.state), ['done', 'active', 'pending']);
  assert.deepEqual(view.pipeline.stages.map(s => s.mark), ['✓', '→', '○']);
  assert.equal(view.pipeline.approvedByName, 'Lucky');
});

test('停在失敗階段時改為提供重試與停止，不再提供重新核准', () => {
  const view = completionView(baseTask({
    completion: pipeline({
      status: 'failed', stage: 'test',
      stages: [{ key: 'test', label: '測試比對', ok: false, current: false, failed: true }],
      failure: { stage: '測試比對', message: '測試比對發現 2 項新的失敗。' },
    }),
  }), baseReview());

  assert.equal(view.pipeline.failed, true);
  assert.equal(view.canApprovePipeline, false);
  assert.match(view.pipeline.failure.message, /2 項新的失敗/);
  assert.equal(view.pipeline.stages[0].state, 'failed');
});

// --- reconcileCompletionState 的權威判定（server/completion-state.js）附加在 pipeline 上 ---

test('後端附加的 blockingReasons／warnings／evidence／nextAction 攤成純文字給畫面用', () => {
  const view = completionView(baseTask({
    completion: pipeline({
      blockingReasons: ['Git 合併會產生衝突：server/app.js'],
      warnings: ['沒有部署驗收（preview/runtime）結果（不適用或尚未執行）。'],
      evidence: ['executor／reviewer 回報 passed=true'],
      nextAction: '需要先解決 Git 合併衝突，衝突未解決前不得合併或視為完成。',
    }),
  }), baseReview());
  assert.deepEqual(view.pipeline.blockingReasons, ['Git 合併會產生衝突：server/app.js']);
  assert.deepEqual(view.pipeline.warnings, ['沒有部署驗收（preview/runtime）結果（不適用或尚未執行）。']);
  assert.deepEqual(view.pipeline.evidence, ['executor／reviewer 回報 passed=true']);
  assert.match(view.pipeline.nextAction, /需要先解決 Git 合併衝突/);
});

test('沒有阻擋原因時是空陣列，不是 undefined', () => {
  const view = completionView(baseTask({ completion: pipeline({ status: 'completed', stage: null, blockingReasons: [], warnings: [], evidence: ['部署流程（測試比對／合併／重測／重啟／驗收／推送／清理）已全部完成。'], nextAction: '所有必要的 deterministic 檢查皆已通過或不適用，且沒有待處理事項，可視為完成。' }) }), baseReview());
  assert.deepEqual(view.pipeline.blockingReasons, []);
  assert.deepEqual(view.pipeline.warnings, []);
  assert.match(view.pipeline.nextAction, /可視為完成/);
});

test('後端沒有附加這些欄位（舊資料）時回傳空陣列與 null，不丟例外', () => {
  const view = completionView(baseTask({ completion: pipeline() }), baseReview());
  assert.deepEqual(view.pipeline.blockingReasons, []);
  assert.deepEqual(view.pipeline.warnings, []);
  assert.deepEqual(view.pipeline.evidence, []);
  assert.equal(view.pipeline.nextAction, null);
});

test('流程結束或停止之後不再擋住單顆按鈕', () => {
  for (const status of ['completed', 'cancelled']) {
    const view = completionView(baseTask({ completion: pipeline({ status, stage: null }) }), baseReview());
    assert.equal(view.pipeline.running, false, status);
    assert.equal(view.canRunTest, true, status);
  }
});

test('合併之前不提供合併後重測；合併之後才可以執行', () => {
  const before = completionView(baseTask(), baseReview());
  assert.equal(before.canRunMainTest, false);
  assert.equal(before.mainTest, null);
  assert.equal(before.stages.find(s => s.key === 'test_main').detail, '合併後才需要');

  const after = completionView(mergedTask(), baseReview());
  assert.equal(after.canRunMainTest, true);
});

test('合併後重測抓到新的失敗：階段標記未通過，數字照實顯示', () => {
  const view = completionView(mergedTask({
    completionMainTest: {
      id: 'm1', status: 'completed', verdict: 'regression',
      newFailures: ['tests/a.test.js > 合起來才壞'], newFailureCount: 1,
      baseline: { ok: true, total: 344, failedCount: 3 }, current: { ok: true, total: 344, failedCount: 4 },
    },
  }), baseReview());

  assert.equal(view.mainTest.verdict, 'regression');
  assert.equal(view.mainTest.newFailureCount, 1);
  assert.equal(view.mainTest.toneClass, 'failed');
  assert.equal(view.stages.find(s => s.key === 'test_main').state, 'failed');
});

test('沒有合併前基準時，原因要翻成看得懂的說明', () => {
  const view = completionView(mergedTask({
    completionMainTest: { id: 'm1', status: 'completed', verdict: 'baseline_unavailable', baseline: { ok: false, reason: 'no_pre_merge_baseline' }, current: { ok: true, total: 344 } },
  }), baseReview());
  assert.match(view.mainTest.baseline.reasonText, /沒有合併前的基準/);
  assert.equal(view.stages.find(s => s.key === 'test_main').state, 'blocked');
});

// --- 推送遠端 ------------------------------------------------------------------

const remote = (extra = {}) => ({ configured: true, remote: 'origin', baseBranch: 'main', url: 'git@example.com:me/taskflow.git', ahead: 0, behind: 0, ...extra });

test('沒有設定遠端時照實說，也不給按鈕', () => {
  const view = completionView(mergedTask(), baseReview({ remote: { configured: false, remote: 'origin', reason: 'no_remote' } }));
  assert.equal(view.push.configured, false);
  assert.equal(view.canPush, false);
  assert.match(view.push.note, /沒有設定 origin/);
});

test('領先遠端時才提供推送，並顯示領先幾個 commit', () => {
  const ahead = completionView(mergedTask(), baseReview({ remote: remote({ ahead: 5 }) }));
  assert.equal(ahead.canPush, true);
  assert.match(ahead.push.label, /領先 origin\/main 5 個 commit/);

  const synced = completionView(mergedTask(), baseReview({ remote: remote() }));
  assert.equal(synced.canPush, false);
  assert.equal(synced.push.label, '與遠端同步');
});

test('落後遠端時擋住推送，並說明 TaskFlow 不替你選 merge 還是 rebase', () => {
  const view = completionView(mergedTask(), baseReview({ remote: remote({ ahead: 2, behind: 3 }) }));
  assert.equal(view.canPush, false);
  assert.equal(view.push.blockedByBehind, true);
  assert.match(view.push.note, /merge 還是 rebase/);
});

test('尚未合併就不顯示推送；推送過後顯示推了幾個', () => {
  assert.equal(completionView(baseTask(), baseReview({ remote: remote({ ahead: 2 }) })).canPush, false);

  const view = completionView(mergedTask({ gitPush: { remote: 'origin', baseBranch: 'main', count: 5, at: '2026-09-19T06:00:00.000Z' } }), baseReview({ remote: remote() }));
  assert.equal(view.push.pushed.count, 5);
});

test('明講目前尚未涵蓋 Browser Validation，不把未實作畫成尚未開始', () => {
  const view = completionView(baseTask(), baseReview());
  assert.match(view.scopeNote, /尚未納入/);
  assert.equal(view.stages.some(s => /Browser/.test(s.label)), false);
});
