// POST /api/tasks/:id/close 這條路由本身的接線：schema、驗證、回傳格式。
// closeTask() 的完整生命週期邏輯（ready_to_close 判定、外部合併偵測、worktree dirty
// 保護、legacy 相容）已經在 tests/git-review.test.js 逐項覆蓋，這裡不重複。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id, hash } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { createApp } from '../server/app.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-close-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), '# 原始專案\n');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  let calls = 0;
  const runner = createRunner(store, {
    dataDir: join(dir, 'runs'), recover: false,
    adapter: async o => { calls++; if (o.readOnly) return { result: plan }; if (calls === 2) writeFileSync(join(o.cwd, 'result.md'), 'delivered\n'); return { result: good }; },
  });
  t.after(() => runner.stop());
  store.setSetting('runnerEnabled', true);

  const task = createTask(store, owner, { title: 'Document task', description: 'Create a document and validate it.', projectId, type: 'research', priority: 1, planner: 'claude', executor: 'codex', reviewer: 'claude' });
  await runner.tick();
  approveTask(store, owner, task.id, 1);
  await runner.tick();
  await runner.tick();
  assert.equal(store.task(task.id).status, 'completed');

  const server = createApp(store, runner).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'test-session-close';
  store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), owner.id, Date.now() + 60000);
  const call = (path, options = {}) => fetch(base + path, { ...options, headers: { cookie: `tf_session=${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });

  return { dir, store, owner, source, projectId, task: store.task(task.id), call };
}

test('POST /api/tasks/:id/close：completed 尚未合併時回 409', async t => {
  const f = await fixture(t);
  const res = await f.call(`/api/tasks/${f.task.id}/close`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /尚未合併至正式分支/);
});

test('POST /api/tasks/:id/close：非法欄位被 schema 擋下', async t => {
  const f = await fixture(t);
  const res = await f.call(`/api/tasks/${f.task.id}/close`, { method: 'POST', body: JSON.stringify({ notAllowed: true }) });
  assert.equal(res.status, 400);
});

test('POST /api/tasks/:id/close：合併後成功關閉，回傳 displayStatus=closed', async t => {
  const f = await fixture(t);
  const mergeRes = await f.call(`/api/tasks/${f.task.id}/git/decision`, { method: 'POST', body: JSON.stringify({ decision: 'merge', artifactVersion: f.task.artifactVersion }) });
  assert.equal(mergeRes.status, 200);
  assert.equal((await mergeRes.json()).status, 'ready_to_close');

  const res = await f.call(`/api/tasks/${f.task.id}/close`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'closed');
  assert.equal(body.displayStatus, 'closed');
  assert.equal(body.closedBy, f.owner.id);
});

test('POST /api/tasks/:id/close：需要登入', async t => {
  const f = await fixture(t);
  const res = await f.call(`/api/tasks/${f.task.id}/close`, { method: 'POST', body: '{}', headers: { cookie: '' } });
  assert.equal(res.status, 401);
});
