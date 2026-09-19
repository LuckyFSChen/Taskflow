import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id } from '../server/db.js';
import { createCompletionValidations, completionValidationPublic, recoverCompletionValidations } from '../server/completion-validation.js';

// 一個已經合併、可以做部署驗收的任務。這裡不需要真的跑 git：驗收要的前提只有
// 「是 worktree 模式」「已經有 gitMerge」「專案目錄存在」。
function mergedTask(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-validation-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), '# 專案\n');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const taskId = id();
  store.saveTask({
    id: taskId, ownerId: owner.id, projectId, status: 'completed', priority: 1, position: 0, planVersion: 1,
    title: '部署驗收測試', workspace: source,
    git: { mode: 'worktree', baseBranch: 'main', workingBranch: 'taskflow/abc', repositoryPath: source, baseCommit: 'c17453a', headCommit: '3052fe8' },
    gitMerge: { commit: 'ab3e585', baseBranch: 'main', workingBranch: 'taskflow/abc', at: new Date().toISOString() },
  });
  return { dir, store, owner, source, projectId, taskId };
}

// 假的 Preview：記錄 start/stop，回傳一次性帳密與 PID。
function fakePreviews({ pid = 48216, url = 'http://127.0.0.1:61347' } = {}) {
  const calls = [];
  return {
    calls,
    start: async (key, path) => { calls.push({ op: 'start', key, path }); return { url, pid, kind: 'fullstack', credentials: { username: 'taskflow-preview', password: 'one-time' } }; },
    stop: async key => { calls.push({ op: 'stop', key }); },
  };
}

const passing = {
  passed: true,
  checks: [
    { name: 'health', method: 'GET', path: '/api/health', expected: '200', actual: 'HTTP 200', passed: true, detail: '' },
    { name: 'login', method: 'POST', path: '/api/login', expected: '200', actual: 'HTTP 200', passed: true, detail: '' },
    { name: 'state', method: 'GET', path: '/api/state', expected: '200', actual: 'HTTP 200', passed: true, detail: '' },
  ],
};

test('驗收會在合併後的專案目錄上開 Preview、驗 API、停掉它，並確認 PID 消失', async t => {
  const f = mergedTask(t);
  const previews = fakePreviews();
  let received = null;
  const validations = createCompletionValidations({
    previews,
    validate: async options => { received = options; return passing; },
    wait: async () => true,
  });

  validations.start(f.store, f.owner, f.taskId);
  assert.equal(f.store.task(f.taskId).completionValidation.status, 'running');
  await validations.settled();

  // Preview 開在專案目錄（合併後的正式分支），不是任務的 worktree
  assert.deepEqual(previews.calls.map(c => c.op), ['start', 'stop']);
  assert.equal(previews.calls[0].key, f.projectId);
  assert.equal(previews.calls[0].path, f.source);
  // 驗收用的是 Preview 自己的一次性帳密，不是任何真實帳號
  assert.equal(received.url, 'http://127.0.0.1:61347');
  assert.equal(received.credentials.username, 'taskflow-preview');

  const report = f.store.task(f.taskId).completionValidation;
  assert.equal(report.status, 'completed');
  assert.equal(report.passed, true);
  assert.equal(report.previewStopped, true);
  assert.equal(report.checks.at(-1).name, 'preview_stopped');
  assert.equal(report.checks.at(-1).passed, true);
  assert.ok(f.store.events(f.taskId).some(e => e.kind === 'completion_validation_result'));
});

test('Preview 停不掉時，就算三個 API 都通過也不得判定通過', async t => {
  const f = mergedTask(t);
  const validations = createCompletionValidations({
    previews: fakePreviews(),
    validate: async () => passing,
    wait: async () => false, // PID 還在
  });

  validations.start(f.store, f.owner, f.taskId);
  await validations.settled();

  const report = f.store.task(f.taskId).completionValidation;
  assert.equal(report.passed, false);
  assert.equal(report.previewStopped, false);
  const stopped = report.checks.find(c => c.name === 'preview_stopped');
  assert.equal(stopped.passed, false);
  assert.match(stopped.detail, /仍然存在/);
});

test('API 驗收未通過時如實回報，並仍然把 Preview 停掉', async t => {
  const f = mergedTask(t);
  const previews = fakePreviews();
  const validations = createCompletionValidations({
    previews,
    validate: async () => ({
      passed: false,
      checks: [{ name: 'login', method: 'POST', path: '/api/login', expected: '200', actual: 'HTTP 404', passed: false, detail: '這個路徑不存在：服務缺少該 API，屬於架構缺陷' }],
    }),
    wait: async () => true,
  });

  validations.start(f.store, f.owner, f.taskId);
  await validations.settled();

  assert.ok(previews.calls.some(c => c.op === 'stop'));
  const report = f.store.task(f.taskId).completionValidation;
  assert.equal(report.passed, false);
  assert.match(report.checks[0].detail, /架構缺陷/);
});

test('驗收過程中丟例外也會把 Preview 停掉，並記為未完成', async t => {
  const f = mergedTask(t);
  const previews = fakePreviews();
  const validations = createCompletionValidations({
    previews,
    validate: async () => { throw new Error('preview build failed'); },
    wait: async () => true,
  });

  validations.start(f.store, f.owner, f.taskId);
  await validations.settled();

  assert.ok(previews.calls.some(c => c.op === 'stop'));
  const report = f.store.task(f.taskId).completionValidation;
  assert.equal(report.status, 'failed');
  assert.equal(report.passed, false);
  assert.match(report.error, /preview build failed/);
});

test('尚未合併就不提供部署驗收（驗的是合併後的正式分支）', t => {
  const f = mergedTask(t);
  const task = f.store.task(f.taskId);
  task.gitMerge = null;
  f.store.saveTask(task);
  const validations = createCompletionValidations({ previews: fakePreviews(), validate: async () => passing });

  assert.throws(() => validations.start(f.store, f.owner, f.taskId), /尚未合併/);
});

test('同一時間只跑一組驗收', async t => {
  const f = mergedTask(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const validations = createCompletionValidations({
    previews: fakePreviews(),
    validate: async () => { await gate; return passing; },
    wait: async () => true,
  });

  validations.start(f.store, f.owner, f.taskId);
  assert.throws(() => validations.start(f.store, f.owner, f.taskId), /正在執行中/);
  release();
  await validations.settled();
});

test('服務重啟後，中斷的驗收不會永遠停在執行中', t => {
  const f = mergedTask(t);
  const task = f.store.task(f.taskId);
  task.completionValidation = { id: 'v1', status: 'running', startedAt: new Date().toISOString() };
  f.store.saveTask(task);

  recoverCompletionValidations(f.store);

  const report = f.store.task(f.taskId).completionValidation;
  assert.equal(report.status, 'interrupted');
  assert.equal(report.passed, false);
  assert.match(report.error, /重新啟動/);
});

test('送到瀏覽器的版本不含帳密，並說明這一段沒有涵蓋畫面互動', () => {
  const report = completionValidationPublic({
    completionValidation: {
      id: 'v1', status: 'completed', passed: true, url: 'http://127.0.0.1:61347', pid: 48216, previewStopped: true,
      checks: passing.checks, startedBy: 'user-1',
    },
  });
  assert.equal(JSON.stringify(report).includes('password'), false);
  assert.equal(JSON.stringify(report).includes('taskflow-preview'), false);
  assert.match(report.note, /不包含實際的畫面互動/);
  assert.equal(completionValidationPublic({}), null);
});
