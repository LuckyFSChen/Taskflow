import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/db.js';
import {
  MAX_RESTART_ATTEMPTS,
  guardianAlive,
  handleControlRequests,
  initControlRequests,
  latestRestart,
  recoverStuckRestarts,
  requestRestart,
  restartBlockReason,
  restartView,
} from '../server/control-requests.js';

function freshStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-control-'));
  const store = createStore(join(dir, 'db.sqlite'));
  initControlRequests(store.db);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const aliveGuardian = store => store.setSetting('guardianLastSuccess', new Date().toISOString());
const mergedTask = (extra = {}) => ({ id: 'task-1', gitMerge: { commit: 'ab3e5853', baseBranch: 'main' }, ...extra });

test('守護程式每五秒寫一次心跳；超過一分鐘沒寫就當它沒在跑', t => {
  const store = freshStore(t);
  assert.equal(guardianAlive(store), false);
  store.setSetting('guardianLastSuccess', new Date(Date.now() - 5 * 60000).toISOString());
  assert.equal(guardianAlive(store), false);
  aliveGuardian(store);
  assert.equal(guardianAlive(store), true);
});

test('只有 TaskFlow 自己的專案、而且已經合併，才可以要求重新啟動', t => {
  const store = freshStore(t);
  aliveGuardian(store);
  const root = 'F:\\TaskFlow';

  assert.equal(restartBlockReason(store, mergedTask(), { taskflowRoot: root, projectPath: root }), null);
  assert.equal(restartBlockReason(store, mergedTask(), { taskflowRoot: root, projectPath: 'F:\\Other' }).code, 'not_self_project');
  assert.equal(restartBlockReason(store, { id: 'task-1' }, { taskflowRoot: root, projectPath: root }).code, 'not_merged');
});

test('守護程式沒在跑時，網頁不假裝可以重新啟動，並說明要去啟動哪一支', t => {
  const store = freshStore(t);
  const reason = restartBlockReason(store, mergedTask(), { taskflowRoot: 'F:\\TaskFlow', projectPath: 'F:\\TaskFlow' });
  assert.equal(reason.code, 'guardian_offline');
  assert.match(reason.message, /Start-Service-Guardian/);
});

test('已經有一個請求在進行中時不重複建立', t => {
  const store = freshStore(t);
  aliveGuardian(store);
  requestRestart(store, { taskId: 'task-1', expectedCommit: 'ab3e5853' });
  const reason = restartBlockReason(store, mergedTask(), { taskflowRoot: 'F:\\TaskFlow', projectPath: 'F:\\TaskFlow' });
  assert.equal(reason.code, 'already_requested');
});

test('守護程式取走請求、重啟成功後寫回結果', async t => {
  const store = freshStore(t);
  requestRestart(store, { taskId: 'task-1', expectedCommit: 'ab3e5853' });

  const seen = [];
  const row = await handleControlRequests(store, {
    restart: async options => { seen.push(options); return { ok: true, url: 'https://taskflow.example.com' }; },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].expectedCommit, 'ab3e5853');
  assert.equal(row.status, 'success');
  assert.equal(row.attempts, 1);
  assert.equal(restartView(row).url, 'https://taskflow.example.com');
  assert.equal(restartView(row).active, false);
});

test('有 AI 工作在執行時是「延後」不是「失敗」：不消耗重試次數，下一輪再試', async t => {
  const store = freshStore(t);
  requestRestart(store, { taskId: 'task-1' });

  const postponed = await handleControlRequests(store, {
    restart: async () => { const error = new Error('x'); error.stderr = 'Active AI work found; service restart postponed.'; throw error; },
  });
  assert.equal(postponed.status, 'pending');
  assert.equal(postponed.attempts, 0);
  assert.match(postponed.note, /延後/);

  const done = await handleControlRequests(store, { restart: async () => ({ ok: true, url: 'https://x.example.com' }) });
  assert.equal(done.status, 'success');
  assert.equal(done.attempts, 1);
});

test('真正的失敗會重試，但有上限，不會變成無限重啟迴圈', async t => {
  const store = freshStore(t);
  requestRestart(store, { taskId: 'task-1' });
  const fail = () => handleControlRequests(store, { restart: async () => { throw new Error('TaskFlow exited during startup.'); } });

  const first = await fail();
  assert.equal(first.status, 'pending');
  assert.equal(first.attempts, 1);
  assert.match(first.error, /exited during startup/);

  const second = await fail();
  assert.equal(second.status, 'failed');
  assert.equal(second.attempts, MAX_RESTART_ATTEMPTS);

  // 已經失敗的請求不會再被取走執行
  let called = 0;
  await handleControlRequests(store, { restart: async () => { called++; return {}; } });
  assert.equal(called, 0);
});

test('重試次數存在資料庫，服務重啟後仍然有效', async t => {
  const store = freshStore(t);
  requestRestart(store, { taskId: 'task-1' });
  await handleControlRequests(store, { restart: async () => { throw new Error('boom'); } });

  // 模擬守護程式／主服務重新啟動：換一個 store 物件讀同一個資料庫
  const reopened = latestRestart(store, 'task-1');
  assert.equal(reopened.attempts, 1);
  const second = await handleControlRequests(store, { restart: async () => { throw new Error('boom again'); } });
  assert.equal(second.status, 'failed');
});

test('一直被延後也不會永遠等下去', async t => {
  const store = freshStore(t);
  const request = requestRestart(store, { taskId: 'task-1', clock: () => Date.now() - 31 * 60000 });
  let called = 0;
  const row = await handleControlRequests(store, { restart: async () => { called++; return {}; } });
  assert.equal(called, 0);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /等待太久/);
  assert.equal(row.id, request.id);
});

test('守護程式中途掛掉留下的「執行中」請求會被收掉，畫面不會永遠停在重新啟動中', async t => {
  const store = freshStore(t);
  requestRestart(store, { taskId: 'task-1' });
  // 取走請求但永遠不回報結果
  const hang = handleControlRequests(store, { restart: () => new Promise(() => {}) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(latestRestart(store, 'task-1').status, 'running');

  assert.equal(recoverStuckRestarts(store, { stuckMs: 0 }), 1);
  const row = latestRestart(store, 'task-1');
  assert.equal(row.status, 'failed');
  assert.match(row.error, /守護程式可能已經停止/);
  void hang;
});

test('送到瀏覽器的形狀只有結論，沒有內部欄位', t => {
  const store = freshStore(t);
  const row = requestRestart(store, { taskId: 'task-1', userId: 'user-1', expectedCommit: 'ab3e5853' });
  const view = restartView(row);
  assert.deepEqual(Object.keys(view).sort(), ['active', 'attempts', 'error', 'expectedCommit', 'finishedAt', 'id', 'maxAttempts', 'note', 'requestedAt', 'status', 'url']);
  assert.equal(view.active, true);
  assert.equal(view.status, 'pending');
  assert.equal(restartView(null), null);
});
