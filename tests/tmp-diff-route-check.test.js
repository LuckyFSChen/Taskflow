import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, hash, id } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createTask } from '../server/domain.js';
import { createGitRunner, prepareTaskWorkspace } from '../server/git-workspace.js';

const git = createGitRunner();
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const initRepo = path => {
  run(path, 'init');
  run(path, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  run(path, 'config', 'user.email', 'dev@example.test');
  run(path, 'config', 'user.name', 'Dev');
};

test('diff routes: list + content, security checks, legacy mode, empty diff', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tf-diff-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'index.js'), 'console.log(1);\n');
  initRepo(project);
  run(project, 'add', 'index.js');
  run(project, 'commit', '-m', 'init');

  const s = createStore(join(root, 'db.sqlite'));
  const u = s.addUser('Owner', 'owner', 'fixture-password');
  const pid = id();
  s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid, 'demo', 'Demo', project);
  s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id, pid);
  s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('sess'), u.id, Date.now() + 60000);

  const task = createTask(s, u, { title: 'Diff Task', description: 'diff test fixture', projectId: pid, type: 'code' });
  const prepared = prepareTaskWorkspace({ projectPath: project, taskId: task.id, title: task.title, worktreesDir: join(root, 'wt'), git });
  Object.assign(task, { status: 'running', workspace: prepared.git.workingDirectory, git: prepared.git });
  s.saveTask(task);

  // 修改一個已追蹤檔案、新增一個 untracked 檔案，皆尚未 commit。
  writeFileSync(join(prepared.git.workingDirectory, 'index.js'), 'console.log(2);\n');
  writeFileSync(join(prepared.git.workingDirectory, 'new.js'), 'export const x=1;\n');
  writeFileSync(join(prepared.git.workingDirectory, '.env'), 'SECRET=leak\n');

  const legacyTask = createTask(s, u, { title: 'Legacy Task', description: 'diff test fixture', projectId: pid, type: 'code' });
  Object.assign(legacyTask, { status: 'completed', workspace: project, git: null });
  s.saveTask(legacyTask);

  const server = createApp(s, { status: {} }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); s.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = { headers: { cookie: 'tf_session=sess' } };

  const list = await (await fetch(`${base}/api/tasks/${task.id}/diff`, opts)).json();
  assert.equal(list.available, true);
  const paths = list.files.map(f => f.path).sort();
  assert.deepEqual(paths, ['index.js', 'new.js'], '.env 必須被過濾掉，不得出現在清單中');
  assert.equal(list.files.find(f => f.path === 'index.js').status, 'modified');
  assert.equal(list.files.find(f => f.path === 'new.js').status, 'added');

  const modifiedDiff = await (await fetch(`${base}/api/tasks/${task.id}/diff/content?path=index.js`, opts)).json();
  assert.equal(modifiedDiff.available, true);
  assert.match(modifiedDiff.diff, /console\.log\(2\)/);

  const addedDiff = await (await fetch(`${base}/api/tasks/${task.id}/diff/content?path=new.js`, opts)).json();
  assert.equal(addedDiff.available, true);
  assert.match(addedDiff.diff, /export const x=1/);

  const envAttempt = await fetch(`${base}/api/tasks/${task.id}/diff/content?path=.env`, opts);
  assert.equal(envAttempt.status, 403, '.env 內容不得透過 diff API 讀取');

  const traversalAttempt = await fetch(`${base}/api/tasks/${task.id}/diff/content?path=${encodeURIComponent('../../secrets.txt')}`, opts);
  assert.equal(traversalAttempt.status, 403, '路徑逃逸必須被拒絕');

  const gitDirAttempt = await fetch(`${base}/api/tasks/${task.id}/diff/content?path=${encodeURIComponent('.git/config')}`, opts);
  assert.equal(gitDirAttempt.status, 403, '.git 內部檔案不得被讀取');

  // legacy（非 Git 模式）任務：不應報錯，應明確回報降級狀態。
  const legacyList = await (await fetch(`${base}/api/tasks/${legacyTask.id}/diff`, opts)).json();
  assert.equal(legacyList.available, false);
  assert.equal(legacyList.reason, 'not_git');
  const legacyContent = await (await fetch(`${base}/api/tasks/${legacyTask.id}/diff/content?path=index.js`, opts)).json();
  assert.equal(legacyContent.available, false);
  assert.equal(legacyContent.reason, 'not_git');

  // 沒有任何變更的任務：清單應為空陣列而非誤報。
  const cleanWorkspace = join(root, 'clean-project');
  mkdirSync(cleanWorkspace, { recursive: true });
  writeFileSync(join(cleanWorkspace, 'a.js'), '1\n');
  initRepo(cleanWorkspace);
  run(cleanWorkspace, 'add', 'a.js');
  run(cleanWorkspace, 'commit', '-m', 'init');
  const cleanHead = run(cleanWorkspace, 'rev-parse', 'HEAD');
  const cleanTask = createTask(s, u, { title: 'Clean Task', description: 'diff test fixture', projectId: pid, type: 'code' });
  Object.assign(cleanTask, {
    status: 'running', workspace: cleanWorkspace,
    git: { mode: 'worktree', repositoryPath: cleanWorkspace, workingDirectory: cleanWorkspace, baseBranch: 'main', workingBranch: 'main', baseCommit: cleanHead, headCommit: cleanHead },
  });
  s.saveTask(cleanTask);
  const cleanList = await (await fetch(`${base}/api/tasks/${cleanTask.id}/diff`, opts)).json();
  assert.equal(cleanList.available, true);
  assert.deepEqual(cleanList.files, []);
});
