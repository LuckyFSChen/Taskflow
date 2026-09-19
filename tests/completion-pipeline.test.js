import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore, id} from '../server/db.js';
import {
  advanceCompletion,
  completionPublic,
  createCompletion,
  createCompletionPipeline,
  nextStage,
  plannedStages,
  tickCompletions,
} from '../server/completion-pipeline.js';

// 這個狀態機不自己執行任何操作：合併、測試、重啟、驗收、清理全部注入。
// 所以這裡可以用假的協作者把每一種順序與每一種失敗都跑過一遍。
function fixture(t, { selfProject = true, options = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-pipeline-'));
  const store = createStore(join(dir, 'db.sqlite'));
  const user = store.addUser('Lucky', 'lucky', 'password-lucky-123');
  const projectId = id(), taskId = id();
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const task = {
    id: taskId, ownerId: user.id, projectId, status: 'completed', priority: 1, position: 0,
    planVersion: 1, artifactVersion: 'artifact-1', title: '部署測試',
    git: { mode: 'worktree', baseBranch: 'main', workingBranch: 'taskflow/abc' },
  };
  task.completion = createCompletion({ task, user, selfProject, options });
  store.saveTask(task);
  return { store, user, taskId, projectId };
}

// 預設一路成功的協作者；每個測試再覆寫自己要的那一個。
function deps(store, overrides = {}) {
  const calls = [];
  const base = {
    calls,
    tests: {
      start(s, u, taskId) {
        calls.push('test.start');
        const task = s.task(taskId);
        task.completionTest = { status: 'completed', verdict: 'no_regression', startedAt: new Date().toISOString(), newFailures: [] };
        s.saveTask(task);
      },
      startMain(s, u, taskId) {
        calls.push('test_main.start');
        const task = s.task(taskId);
        task.completionMainTest = { status: 'completed', verdict: 'no_regression', startedAt: new Date().toISOString(), newFailures: [] };
        s.saveTask(task);
      },
    },
    validations: {
      start(s, u, taskId) {
        calls.push('validate.start');
        const task = s.task(taskId);
        task.completionValidation = { status: 'completed', passed: true, checks: [{ name: 'health', passed: true }], startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
    merge(s, u, task) {
      calls.push('merge');
      const latest = s.task(task.id);
      latest.gitMerge = { commit: 'ab3e585', baseBranch: 'main', at: new Date().toISOString() };
      s.saveTask(latest);
      return latest;
    },
    restart(s, u, task) {
      calls.push('restart.request');
      const latest = s.task(task.id);
      latest.restartRequest = { status: 'success', requestedAt: new Date().toISOString(), url: 'https://taskflow.example.com', attempts: 1 };
      s.saveTask(latest);
      return null; // null = 沒有阻擋原因
    },
    restartStatus: (s, task) => s.task(task.id).restartRequest || null,
    push(s, u, task) {
      calls.push('push');
      const latest = s.task(task.id);
      latest.gitPush = { remote: 'origin', baseBranch: 'main', count: 3, at: new Date().toISOString() };
      s.saveTask(latest);
      return latest;
    },
    cleanup(s, task) { calls.push('cleanup'); return { removed: true, branchDeleted: true }; },
  };
  // tests／validations 做子物件合併：測試通常只想換掉其中一個方法，
  // 整個物件覆蓋會讓它意外丟掉其他方法（新增協作者方法時就會踩到）。
  return {
    ...base, ...overrides,
    tests: { ...base.tests, ...overrides.tests },
    validations: { ...base.validations, ...overrides.validations },
  };
}

// 推進到指定階段開始等待為止。每個階段可能要兩個 tick：一個送出／啟動，一個讀結果。
function runUntilStage(store, taskId, d, stage, limit = 25) {
  for (let i = 0; i < limit; i++) {
    const task = advanceCompletion(store, taskId, d);
    if (task.completion.stage === stage || task.completion.status !== 'running') return task;
  }
  return store.task(taskId);
}

// 一直推進到停下來為止（完成、失敗，或連續幾次都沒有進展）。
function runToCompletion(store, taskId, d, limit = 25) {
  for (let i = 0; i < limit; i++) {
    const task = advanceCompletion(store, taskId, d);
    if (task.completion.status !== 'running') return task;
  }
  return store.task(taskId);
}

test('TaskFlow 自己的專案跑完整五個階段；其他專案只跑測試、合併、清理', () => {
  // 推送預設不排：它是唯一會影響本機以外的動作
  assert.deepEqual(plannedStages({ selfProject: true }), ['test', 'merge', 'test_main', 'restart', 'validate', 'cleanup']);
  assert.deepEqual(plannedStages({ selfProject: true, options: { push: true } }), ['test', 'merge', 'test_main', 'restart', 'validate', 'push', 'cleanup']);
  // 合併後重測與專案是誰無關：semantic conflict 每個專案都會發生
  assert.deepEqual(plannedStages({ selfProject: false }), ['test', 'merge', 'test_main', 'cleanup']);
  assert.deepEqual(plannedStages({ selfProject: true, options: { restart: false, validate: false } }), ['test', 'merge', 'test_main', 'cleanup']);
  assert.deepEqual(plannedStages({ selfProject: false, options: { cleanup: false } }), ['test', 'merge', 'test_main']);
  assert.deepEqual(plannedStages({ selfProject: false, options: { testMain: false } }), ['test', 'merge', 'cleanup']);
});

test('一次核准就依序跑完，順序不會亂', t => {
  const f = fixture(t);
  const d = deps(f.store);
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'completed');
  assert.deepEqual(d.calls, ['test.start', 'merge', 'test_main.start', 'restart.request', 'validate.start', 'cleanup']);
  for (const stage of ['test', 'merge', 'test_main', 'restart', 'validate', 'cleanup']) {
    assert.equal(task.completion.results[stage].ok, true, stage);
  }
  assert.ok(f.store.events(f.taskId).some(e => e.kind === 'completion_finished'));

  // reconcileCompletionState 彙整整條 pipeline 的 results，沒有任何 blockingReasons，
  // nextAction 說明已經可以視為完成。
  const view = completionPublic(task);
  assert.deepEqual(view.blockingReasons, []);
  assert.match(view.nextAction, /已通過或不適用/);
});

test('測試出現新的失敗時，整條流程在那裡停住，絕不繼續合併', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    tests: {
      start(s, u, taskId) {
        const task = s.task(taskId);
        task.completionTest = { status: 'completed', verdict: 'regression', newFailureCount: 2, startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'failed');
  assert.equal(task.completion.failure.stage, 'test');
  assert.match(task.completion.failure.message, /2 項新的失敗/);
  assert.equal(task.gitMerge, undefined);
  assert.equal(d.calls.includes('merge'), false);

  // reconcileCompletionState 的 blockingReasons 同樣點出是測試比對發現新的失敗，
  // 而不是只給一個籠統的「失敗」。
  const view = completionPublic(task);
  assert.ok(view.blockingReasons.some(reason => reason.includes('2 項新的失敗')));
});

test('基準不可用時通過但留下警告，不假裝證明了沒有 regression', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    tests: {
      start(s, u, taskId) {
        const task = s.task(taskId);
        task.completionTest = { status: 'completed', verdict: 'baseline_unavailable', startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'completed');
  assert.equal(task.completion.results.test.ok, true);
  assert.match(task.completion.results.test.note, /未能證明沒有 regression/);
});

test('失敗之後重試只從失敗的那一階段開始，已完成的階段不重跑', t => {
  const f = fixture(t);
  let failValidation = true;
  const d = deps(f.store, {
    validations: {
      start(s, u, taskId) {
        d.calls.push('validate.start');
        const task = s.task(taskId);
        task.completionValidation = failValidation
          ? { status: 'completed', passed: false, checks: [{ name: 'login', passed: false }], startedAt: new Date().toISOString() }
          : { status: 'completed', passed: true, checks: [{ name: 'login', passed: true }], startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
  });

  const stopped = runToCompletion(f.store, f.taskId, d);
  assert.equal(stopped.completion.status, 'failed');
  assert.equal(stopped.completion.failure.stage, 'validate');
  assert.match(stopped.completion.failure.message, /login/);
  assert.deepEqual(d.calls, ['test.start', 'merge', 'test_main.start', 'restart.request', 'validate.start']);

  // 使用者按下「從失敗階段重試」：合併與重啟的結果都還在，不會再做一次。
  failValidation = false;
  const task = f.store.task(f.taskId);
  task.completion = { ...task.completion, status: 'running', failure: null, approvedAt: new Date().toISOString() };
  f.store.saveTask(task);
  const finished = runToCompletion(f.store, f.taskId, d);

  assert.equal(finished.completion.status, 'completed');
  assert.deepEqual(d.calls, ['test.start', 'merge', 'test_main.start', 'restart.request', 'validate.start', 'validate.start', 'cleanup']);
  assert.equal(d.calls.filter(c => c === 'merge').length, 1);
  assert.equal(d.calls.filter(c => c === 'restart.request').length, 1);
});

test('已經合併過的任務不會再合併一次', t => {
  const f = fixture(t);
  const task = f.store.task(f.taskId);
  task.gitMerge = { commit: 'earlier1', baseBranch: 'main', at: new Date().toISOString() };
  f.store.saveTask(task);

  const d = deps(f.store);
  const finished = runToCompletion(f.store, f.taskId, d);

  assert.equal(finished.completion.status, 'completed');
  assert.equal(d.calls.includes('merge'), false);
  assert.equal(finished.completion.results.merge.commit, 'earlier1');
  assert.equal(finished.completion.results.merge.skipped, true);
});

test('合併會產生衝突時停下來，並指名衝突的檔案', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    merge(s, u, task) {
      const latest = s.task(task.id);
      latest.gitConflict = { files: ['server/app.js'], at: new Date().toISOString() };
      s.saveTask(latest);
      return latest;
    },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'failed');
  assert.equal(task.completion.failure.stage, 'merge');
  assert.match(task.completion.failure.message, /server\/app\.js/);

  // reconcileCompletionState 把 Git 合併衝突同時列進 blockingReasons，
  // 這是給 API／前端顯示用的統一格式，不是 pipeline 自己另一套判斷。
  const view = completionPublic(task);
  assert.ok(view.blockingReasons.some(reason => reason.includes('server/app.js')));
});

test('別的任務正在跑測試不是失敗，是等待，下一個 tick 再試', t => {
  const f = fixture(t);
  let busy = true;
  const d = deps(f.store, {
    tests: {
      start(s, u, taskId) {
        d.calls.push('test.start');
        if (busy) { const error = new Error('目前已有另一個任務在執行測試比對'); error.status = 409; throw error; }
        const task = s.task(taskId);
        task.completionTest = { status: 'completed', verdict: 'no_regression', startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
  });

  const waitingTask = advanceCompletion(f.store, f.taskId, d);
  assert.equal(waitingTask.completion.status, 'running');
  assert.match(waitingTask.completion.notes.at(-1), /另一個任務/);

  busy = false;
  const finished = runToCompletion(f.store, f.taskId, d);
  assert.equal(finished.completion.status, 'completed');
});

test('重新啟動被守護程式回報失敗時，流程停在那裡，不會接著驗收', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    restart(s, u, task) {
      const latest = s.task(task.id);
      latest.restartRequest = { status: 'failed', requestedAt: new Date().toISOString(), error: 'Build failed with exit code 2' };
      s.saveTask(latest);
      return null;
    },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'failed');
  assert.equal(task.completion.failure.stage, 'restart');
  assert.match(task.completion.failure.message, /Build failed/);
  assert.equal(d.calls.includes('validate.start'), false);
});

test('守護程式沒在跑時，流程停下來並說明原因，不會無限等待', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    restart: () => ({ retryable: false, message: '找不到正在執行的 Service Guardian（守護程式）。' }),
    restartStatus: () => null,
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'failed');
  assert.equal(task.completion.failure.stage, 'restart');
  assert.match(task.completion.failure.message, /Service Guardian/);
});

test('重啟階段跨越服務重新啟動：狀態存在任務資料裡，新的行程接著跑完', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    restart(s, u, task) {
      d.calls.push('restart.request');
      const latest = s.task(task.id);
      // 只送出請求；結果由守護程式稍後寫入（模擬這個行程在這裡被殺掉）
      latest.restartRequest = { status: 'pending', requestedAt: new Date().toISOString() };
      s.saveTask(latest);
      return null;
    },
  });

  // 第一個行程：推進到重啟階段送出請求之後就「死掉」
  runUntilStage(f.store, f.taskId, d, 'restart');
  assert.equal(f.store.task(f.taskId).completion.stage, 'restart');
  assert.equal(f.store.task(f.taskId).completion.results.merge.ok, true);

  // 守護程式完成重啟並寫回結果
  const mid = f.store.task(f.taskId);
  mid.restartRequest = { ...mid.restartRequest, status: 'success', url: 'https://taskflow.example.com' };
  f.store.saveTask(mid);

  // 新的行程接手：不需要任何額外的復原邏輯
  const finished = runToCompletion(f.store, f.taskId, d);
  assert.equal(finished.completion.status, 'completed');
  assert.equal(d.calls.filter(c => c === 'restart.request').length, 1);
});

test('清理失敗不會把已經完成的部署變成失敗', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    cleanup() { throw new Error('工作目錄仍有未提交的內容，已保留不動'); },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'completed');
  assert.match(task.completion.results.cleanup.note, /未提交的內容/);
});

test('使用者中途取消之後，tick 不會再推進它', t => {
  const f = fixture(t);
  const d = deps(f.store);
  runUntilStage(f.store, f.taskId, d, 'merge'); // 測試階段已經完成

  const task = f.store.task(f.taskId);
  task.completion = { ...task.completion, status: 'cancelled' };
  f.store.saveTask(task);

  const before = d.calls.length;
  tickCompletions(f.store, d);
  assert.equal(d.calls.length, before);
  // 已完成的階段結果原樣保留
  assert.equal(f.store.task(f.taskId).completion.results.test.ok, true);
});

test('合併後重測抓到新的失敗時停住，並指出那是合併造成的、可以撤銷', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    tests: {
      start(s, u, taskId) {
        d.calls.push('test.start');
        const task = s.task(taskId);
        task.completionTest = { status: 'completed', verdict: 'no_regression', startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
      startMain(s, u, taskId) {
        d.calls.push('test_main.start');
        const task = s.task(taskId);
        task.completionMainTest = { status: 'completed', verdict: 'regression', newFailureCount: 1, startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'failed');
  assert.equal(task.completion.failure.stage, 'test_main');
  assert.match(task.completion.failure.message, /合併本身造成的/);
  assert.match(task.completion.failure.message, /撤銷這次合併/);
  // 合併已經發生，流程不會自作主張退回去；也不會繼續往重啟走。
  assert.ok(f.store.task(f.taskId).gitMerge);
  assert.equal(d.calls.includes('restart.request'), false);
});

test('沒有合併前的基準時通過但留下警告，不假裝證明了合併沒問題', t => {
  const f = fixture(t);
  const d = deps(f.store, {
    tests: {
      start(s, u, taskId) {
        const task = s.task(taskId);
        task.completionTest = { status: 'completed', verdict: 'no_regression', startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
      startMain(s, u, taskId) {
        const task = s.task(taskId);
        task.completionMainTest = { status: 'completed', verdict: 'baseline_unavailable', startedAt: new Date().toISOString() };
        s.saveTask(task);
      },
    },
  });
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'completed');
  assert.match(task.completion.results.test_main.note, /未能證明合併沒有造成新的失敗/);
});

test('可以關掉合併後重測，但預設是開著的', t => {
  const f = fixture(t, { options: { testMain: false } });
  const d = deps(f.store);
  const task = runToCompletion(f.store, f.taskId, d);

  assert.equal(task.completion.status, 'completed');
  assert.equal(d.calls.includes('test_main.start'), false);
  assert.equal(task.completion.options.testMain, false);
});

test('勾選推送時才會推，且落後遠端就停住等人', t => {
  const pushed = fixture(t, { options: { push: true } });
  const ok = deps(pushed.store);
  const done = runToCompletion(pushed.store, pushed.taskId, ok);
  assert.equal(done.completion.status, 'completed');
  assert.equal(ok.calls.includes('push'), true);
  assert.equal(done.completion.results.push.count, 3);

  const blocked = fixture(t, { options: { push: true } });
  const refusing = deps(blocked.store, {
    push() { throw new Error('origin/main 有 2 個你本機還沒有的 commit。TaskFlow 不會替你決定要用 merge 還是 rebase'); },
  });
  const stopped = runToCompletion(blocked.store, blocked.taskId, refusing);
  assert.equal(stopped.completion.status, 'failed');
  assert.equal(stopped.completion.failure.stage, 'push');
  assert.match(stopped.completion.failure.message, /merge 還是 rebase/);
  // 推送失敗不影響已經完成的階段
  assert.equal(stopped.completion.results.merge.ok, true);
});

test('預設的一次核准不會推送任何東西到遠端', t => {
  const f = fixture(t);
  const d = deps(f.store);
  const task = runToCompletion(f.store, f.taskId, d);
  assert.equal(task.completion.status, 'completed');
  assert.equal(d.calls.includes('push'), false);
  assert.equal(task.completion.options.push, false);
});

test('nextStage 會跳過已經成功的階段', () => {
  assert.equal(nextStage({ stages: ['test', 'merge'], results: {} }), 'test');
  assert.equal(nextStage({ stages: ['test', 'merge'], results: { test: { ok: true } } }), 'merge');
  assert.equal(nextStage({ stages: ['test', 'merge'], results: { test: { ok: true }, merge: { ok: true } } }), null);
});

test('送到瀏覽器的形狀：每個階段的標籤、完成與否、目前在哪一階段', t => {
  const f = fixture(t);
  const d = deps(f.store);
  runUntilStage(f.store, f.taskId, d, 'merge');

  const view = completionPublic(f.store.task(f.taskId));
  assert.equal(view.status, 'running');
  assert.deepEqual(view.stages.map(s => s.key), ['test', 'merge', 'test_main', 'restart', 'validate', 'cleanup']);
  assert.equal(view.stages[0].label, '測試比對');
  assert.equal(view.stages[0].ok, true);
  assert.equal(view.approvedByName, 'Lucky');
  assert.equal(completionPublic({}), null);

  // reconcileCompletionState 彙整目前的 pipeline 狀態：合併階段還在跑，
  // blockingReasons/warnings/evidence/nextAction 都要有可顯示的內容，
  // 而不是只有 completion.status='running' 這個內部欄位。
  assert.ok(Array.isArray(view.blockingReasons) && view.blockingReasons.length > 0);
  assert.ok(Array.isArray(view.warnings));
  assert.ok(Array.isArray(view.evidence));
  assert.equal(view.nextAction, '等待合併到正式分支完成。');
});

// 這條是回歸測試，不是假設性的：計時器原本放在 createApp() 裡，而那個函式在測試中
// 會被建立很多次、跑完就關掉資料庫。計時器於是在資料庫關閉後繼續跳並丟例外，
// 把三個完全不相干的測試檔弄成失敗（而且只有執行超過三秒的檔案會中招）。
test('推進器預設不建立計時器：createApp() 不得留下會在資料庫關閉後繼續跳的東西', async () => {
  let scanned = 0;
  const store = { tasks: () => { scanned++; return []; } };

  const quiet = createCompletionPipeline(store, {});
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(scanned, 0);
  quiet.stop();

  // 明確要求時才會有計時器，而且 stop() 之後不再推進。
  const ticking = createCompletionPipeline(store, {}, { intervalMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(scanned > 0);
  ticking.stop();
  const afterStop = scanned;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(scanned, afterStop);
  assert.deepEqual(ticking.tick(), []);
});
