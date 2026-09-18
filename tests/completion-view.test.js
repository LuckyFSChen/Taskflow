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
  assert.deepEqual(stages.map(s => s.key), ['implementation', 'review', 'merge', 'cleanup']);
  assert.equal(stages.find(s => s.key === 'implementation').state, 'pending');
  assert.equal(stages.find(s => s.key === 'review').state, 'pending');
  assert.equal(stages.find(s => s.key === 'cleanup').state, 'pending');
});

test('獨立驗證未通過時階段標記為未通過', () => {
  const review = baseReview({ validation: [{ phase: 'review', role: '獨立驗證', passed: false, browserValidation: 'failed' }] });
  const stages = completionStages(baseTask({ status: 'running' }), review);
  assert.equal(stages.find(s => s.key === 'review').state, 'failed');
});

test('明講目前尚未涵蓋重啟與 Browser Validation，不把未實作畫成尚未開始', () => {
  const view = completionView(baseTask(), baseReview());
  assert.match(view.scopeNote, /尚未納入/);
  assert.equal(view.stages.some(s => /重新啟動|Browser/.test(s.label)), false);
});
