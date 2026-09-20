// 「成果」分頁的圖形化 diff 檢視：GET /api/tasks/:id/diff（清單）與
// GET /api/tasks/:id/diff/content（單一檔案內容）。這裡只測 HTTP 層本身的職責——
// 路由是否正確接上 gitWorkspace.diffFiles／fileDiff、路徑安全檢查（resolveDiffPath，
// 比照既有 /download 規則）、以及非 Git／工作副本已不存在時的明確降級——狀態判斷的
// 細節（新增／修改／刪除／重新命名如何分類）已在 tests/git-workspace.test.js 涵蓋。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id, hash } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { createApp } from '../server/app.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-diffapi-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), '# 原始專案\n');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const f = { dir, store, owner, source, projectId };
  f.create = (title = 'Document task') => createTask(store, owner, { title, description: 'Create a document and validate it.', projectId, type: 'research', priority: 1, planner: 'claude', executor: 'codex', reviewer: 'claude' });
  f.runner = adapter => { const r = createRunner(store, { adapter, dataDir: join(dir, 'runs'), recover: false }); t.after(() => r.stop()); store.setSetting('runnerEnabled', true); return r; };
  f.serve = async () => {
    const sessionCode = 'diff-api-session';
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(sessionCode), owner.id, Date.now() + 60000);
    const server = createApp(store, { status: {}, stopTask() {} }, { dist: join(dir, 'no-dist') }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = { cookie: `tf_session=${sessionCode}` };
    return {
      diff: async taskId => (await fetch(`${base}/api/tasks/${taskId}/diff`, { headers: cookie })).json(),
      content: async (taskId, params) => {
        const res = await fetch(`${base}/api/tasks/${taskId}/diff/content?${new URLSearchParams(params)}`, { headers: cookie });
        return { status: res.status, body: await res.json() };
      },
    };
  };
  return f;
}

// 跑完一個真實任務（規劃 → 核准 → 執行 → 審核），停在 completed，git worktree 仍在。
// seedFiles 寫進專案原始資料夾，會被第一個任務自動 git init 時一併 commit，成為 baseCommit
// 的一部分（用來測試「修改既有檔案」）；taskFiles 則是 execute 階段才由 agent 寫入並 commit
// 的全新檔案，baseCommit 沒有它，relative 到 baseCommit 一定是「新增」（用來測試「已 commit
// 的階段成果」）。兩者不能混用同一批檔案，否則測不出 modified／deleted／renamed。
async function completedGitTask(t, { seedFiles = {}, taskFiles = {} } = {}) {
  const f = fixture(t);
  for (const [name, content] of Object.entries(seedFiles)) writeFileSync(join(f.source, name), content);
  let calls = 0;
  const runner = f.runner(async o => {
    calls++;
    if (o.readOnly) return { result: plan };
    if (calls === 2) for (const [name, content] of Object.entries(taskFiles)) writeFileSync(join(o.cwd, name), content);
    return { result: good };
  });
  const task = f.create();
  await runner.tick();
  approveTask(f.store, f.owner, task.id, 1);
  await runner.tick();
  await runner.tick();
  const completed = f.store.task(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.git.mode, 'worktree');
  return { ...f, task: completed };
}

test('GET /diff 與 /diff/content：清單與內容正確反映尚未 commit 的變更，機密路徑一律拒絕', async t => {
  const f = await completedGitTask(t, { seedFiles: { 'modify-me.md': 'original content\n' }, taskFiles: { 'result.md': 'delivered\n' } });
  const api = await f.serve();

  // 任務執行完成後又有尚未 commit 的變更：修改既有檔案、新增未追蹤檔案、以及機密檔案。
  writeFileSync(join(f.task.workspace, 'modify-me.md'), 'changed content\n');
  writeFileSync(join(f.task.workspace, 'new-work.md'), 'brand new\n');
  writeFileSync(join(f.task.workspace, '.env'), 'SECRET=leak\n');

  const list = await api.diff(f.task.id);
  assert.equal(list.available, true);
  const paths = list.files.map(x => x.path);
  assert.ok(paths.includes('result.md'), '已 commit 的階段成果必須出現');
  assert.ok(paths.includes('modify-me.md') && paths.includes('new-work.md'), '尚未 commit 的修改與新增也要出現');
  assert.ok(!paths.includes('.env'), '機密檔案不得出現在清單');
  assert.equal(list.files.find(x => x.path === 'result.md').status, 'added');
  assert.equal(list.files.find(x => x.path === 'modify-me.md').status, 'modified');
  assert.equal(list.files.find(x => x.path === 'new-work.md').status, 'added');

  const modified = await api.content(f.task.id, { path: 'modify-me.md' });
  assert.equal(modified.status, 200);
  assert.equal(modified.body.available, true);
  assert.match(modified.body.diff, /-original content/);
  assert.match(modified.body.diff, /\+changed content/);

  const untracked = await api.content(f.task.id, { path: 'new-work.md' });
  assert.equal(untracked.status, 200);
  assert.equal(untracked.body.available, true);
  assert.match(untracked.body.diff, /\+brand new/);

  // 路徑安全檢查：沿用 /download 既有規則，直接讀取機密檔名、逃逸出 workspace、或伸進 .git 都要被拒絕。
  for (const unsafePath of ['.env', '../../../../etc/passwd', '.git/config', 'server/private.pem']) {
    const rejected = await api.content(f.task.id, { path: unsafePath });
    assert.equal(rejected.status, 403, `${unsafePath} 必須被拒絕`);
  }
});

test('GET /diff：非 Git 模式（legacy 快照）任務回傳明確降級狀態，不會出錯', async t => {
  const f = fixture(t);
  f.store.setSetting('gitWorkspaceEnabled', false);
  const runner = f.runner(async () => ({ result: plan }));
  const task = f.create();
  await runner.tick();
  assert.equal(f.store.task(task.id).git, null, '測試前提：這是非 Git 模式任務');

  const api = await f.serve();
  const list = await api.diff(task.id);
  assert.equal(list.available, false);
  assert.equal(list.reason, 'not_git');
  assert.deepEqual(list.files, []);

  const content = await api.content(task.id, { path: 'README.md' });
  assert.equal(content.status, 200, '非 Git 模式不得回傳錯誤狀態碼');
  assert.equal(content.body.available, false);
  assert.equal(content.body.reason, 'not_git');
});

test('GET /diff：工作副本已不存在時回傳明確降級狀態', async t => {
  const f = await completedGitTask(t, { taskFiles: { 'result.md': 'delivered\n' } });
  rmSync(f.task.workspace, { recursive: true, force: true });
  assert.equal(existsSync(f.task.workspace), false, '測試前提：工作副本已被移除');

  const api = await f.serve();
  const list = await api.diff(f.task.id);
  assert.equal(list.available, false);
  assert.equal(list.reason, 'workspace_missing');
  assert.deepEqual(list.files, []);
});

test('GET /diff：清單依路徑排序，且重新命名的檔案帶有 oldPath', async t => {
  const f = await completedGitTask(t, { seedFiles: { 'rename-me.md': 'keep this content\n' } });
  run(f.task.workspace, 'mv', 'rename-me.md', 'renamed.md');

  const api = await f.serve();
  const list = await api.diff(f.task.id);
  const entry = list.files.find(x => x.path === 'renamed.md');
  assert.ok(entry, '重新命名後的新路徑必須出現在清單');
  assert.equal(entry.status, 'renamed');
  assert.equal(entry.oldPath, 'rename-me.md');
  assert.ok(!list.files.some(x => x.path === 'rename-me.md'), '舊路徑不得再獨立出現一次');

  const content = await api.content(f.task.id, { path: 'renamed.md', oldPath: 'rename-me.md' });
  assert.equal(content.status, 200);
  assert.equal(content.body.available, true);
  assert.match(content.body.diff, /rename from rename-me\.md/);
});
