import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { projectRemovalPlan, removeProject } from '../server/project-removal.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-gitrunner-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), 'Original');
  writeFileSync(join(source, '.env'), 'TOP_SECRET');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    dir, store, owner, source, projectId,
    create: () => createTask(store, owner, { title: 'Document task', description: 'Create a document and validate it.', projectId, type: 'research', priority: 1, planner: 'claude', executor: 'codex', reviewer: 'claude' }),
    runner: (adapter) => { const r = createRunner(store, { adapter, dataDir: join(dir, 'runs'), recover: false }); t.after(() => r.stop()); store.setSetting('runnerEnabled', true); return r; },
  };
}

test('新任務在 git worktree 內執行；專案目錄留在 main，秘密不進入歷史', async t => {
  const f = fixture(t); let calls = 0;
  const runner = f.runner(async o => { calls++; if (o.readOnly) return { result: plan }; if (calls === 2) writeFileSync(join(o.cwd, 'result.md'), 'Delivered'); return { result: good }; });

  const task = f.create();
  await runner.tick();
  const planned = f.store.task(task.id);

  assert.equal(planned.git.mode, 'worktree');
  assert.equal(planned.git.baseBranch, 'main');
  assert.equal(planned.git.workingBranch, `taskflow/${task.id.split('-')[0]}-document-task`);
  assert.ok(planned.git.baseCommit && planned.git.headCommit);
  assert.equal(planned.workspace, planned.git.workingDirectory);
  assert.equal(planned.workspace, join(f.dir, 'runs', 'worktrees', task.id));
  assert.equal(run(f.source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '專案目錄不得被切換分支');
  assert.equal(run(planned.workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), planned.git.workingBranch);
  assert.ok(!existsSync(join(planned.workspace, '.env')), '秘密不得出現在工作目錄');
  assert.ok(!run(f.source, 'ls-files').split('\n').includes('.env'));

  approveTask(f.store, f.owner, task.id, 1);
  await runner.tick();
  // 成果寫在 worktree，原專案資料夾一個字都沒被改到。
  assert.equal(readFileSync(join(f.store.task(task.id).workspace, 'result.md'), 'utf8'), 'Delivered');
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), 'Original');
  assert.equal(existsSync(join(f.source, 'result.md')), false);
});

test('專案有未提交修改：不呼叫 Agent、停在 waiting_input，使用者處理後才繼續', async t => {
  const f = fixture(t); let calls = 0;
  const runner = f.runner(async () => { calls++; return { result: plan }; });

  // 先跑一個任務讓專案成為乾淨的 Git repository（它會停在 awaiting_approval，之後不再派工）。
  const warmup = f.create();
  await runner.tick();
  assert.equal(f.store.task(warmup.id).status, 'awaiting_approval');

  // 再模擬使用者自己留下未提交修改，然後才建立新任務。
  writeFileSync(join(f.source, 'README.md'), '# 使用者自己的修改');
  writeFileSync(join(f.source, 'scratch.txt'), 'wip');
  const task = f.create();
  const before = calls;
  await runner.tick();

  const blocked = f.store.task(task.id);
  assert.equal(calls, before, '守門觸發時不得呼叫任何 Agent');
  assert.equal(blocked.status, 'waiting_input');
  assert.equal(blocked.gitIssue.reason, 'dirty_working_tree');
  assert.match(blocked.gitIssue.message, /目前專案存在未提交修改/);
  assert.ok(blocked.gitIssue.files.some(x => x.includes('scratch.txt')));
  assert.equal(blocked.workspace, null, '未通過守門前不得建立工作目錄');
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 使用者自己的修改', 'TaskFlow 不得清除使用者的修改');
  assert.equal(run(f.source, 'stash', 'list'), '');

  await runner.tick();
  assert.equal(calls, before, 'gitIssue 未處理前不得重試');

  // 使用者自己處理完（這裡以 commit 代表），再由 /api/tasks/:id/git/recheck 清除旗標。
  run(f.source, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', 'user work');
  rmSync(join(f.source, 'scratch.txt'));
  const retry = f.store.task(task.id); retry.gitIssue = null; retry.status = 'planning'; f.store.saveTask(retry);
  await runner.tick();
  assert.equal(calls, before + 1);
  assert.equal(f.store.task(task.id).git.mode, 'worktree');
});

test('工作目錄被切到受保護分支時停止執行，不在 main 上跑 Agent', async t => {
  const f = fixture(t); let calls = 0;
  const runner = f.runner(async o => { calls++; return { result: o.readOnly ? plan : good }; });
  const task = f.create();
  await runner.tick();
  const planned = f.store.task(task.id);
  approveTask(f.store, f.owner, task.id, 1);

  // 模擬有人在工作目錄手動切換到正式分支：deterministic guard 必須直接擋下。
  run(planned.workspace, 'switch', '-c', 'production');
  const before = calls;
  await runner.tick();

  const blocked = f.store.task(task.id);
  assert.equal(calls, before);
  assert.equal(blocked.status, 'waiting_input');
  assert.equal(blocked.gitIssue.reason, 'protected_branch');
  assert.match(blocked.gitIssue.message, /不允許直接修改正式 branch/);
});

test('gitWorkspaceEnabled=false 時沿用舊版工作副本快照', async t => {
  const f = fixture(t);
  f.store.setSetting('gitWorkspaceEnabled', false);
  const runner = f.runner(async () => ({ result: plan }));
  const task = f.create();
  await runner.tick();

  const planned = f.store.task(task.id);
  assert.equal(planned.git, null);
  assert.equal(planned.workspace, join(f.dir, 'runs', 'workspaces', task.id, 'v1'));
  assert.ok(existsSync(join(planned.workspace, 'README.md')));
  assert.equal(existsSync(join(planned.workspace, '.env')), false);
  assert.equal(existsSync(join(f.source, '.git')), false, '關閉 Git 模式時不得動到專案');
});

test('刪除專案會一併清除 Git 模式的 worktree 目錄', async t => {
  const f = fixture(t);
  const runner = f.runner(async () => ({ result: plan }));
  const task = f.create();
  await runner.tick();

  const worktree = f.store.task(task.id).workspace;
  assert.ok(existsSync(worktree));

  const options = { dataDir: join(f.dir, 'runs'), appRoot: join(f.dir, 'app') };
  mkdirSync(options.appRoot, { recursive: true });
  const stub = { status: { activeTaskIds: [] } }, previews = { hasProjectActivity: () => false };
  const plans = () => projectRemovalPlan(f.store, stub, previews, f.projectId, options);

  assert.ok(plans().paths.some(p => p.path === worktree && p.kind.includes('worktree')), '刪除計畫必須涵蓋 worktree 目錄');
  removeProject(f.store, stub, previews, f.projectId, { confirmCode: 'demo', fingerprint: plans().fingerprint }, options);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(f.source), false);
});

test('有檔案修改的階段才 commit；commit 保存成果但不代表驗收通過', async t => {
  const f = fixture(t); let calls = 0;
  const runner = f.runner(async o => {
    calls++;
    if (o.readOnly) return { result: plan };
    if (calls === 2) writeFileSync(join(o.cwd, 'result.md'), 'Delivered');
    return { result: good };   // 驗證階段不改任何檔案
  });

  const task = f.create();
  await runner.tick();
  const base = f.store.task(task.id).git.baseCommit;
  approveTask(f.store, f.owner, task.id, 1);
  await runner.tick();   // execute
  await runner.tick();   // review

  const done = f.store.task(task.id);
  assert.equal(done.status, 'completed');
  const subjects = run(done.workspace, 'log', '--format=%s', `${base}..HEAD`).split('\n').filter(Boolean);
  assert.deepEqual(subjects, ['taskflow(execute): 撰寫文件'], '只有真的改了檔案的階段才留下 commit');

  const threads = f.store.threads(task.id);
  const execute = threads.find(x => x.phase === 'execute'), review = threads.find(x => x.phase === 'review');
  assert.equal(execute.commit.fileCount, 1);
  assert.deepEqual(execute.commit.files, ['result.md']);
  assert.equal(review.commit, undefined, '沒有修改的階段不得產生 commit');
  assert.equal(done.git.headCommit, execute.commit.commit);
  assert.equal(done.artifactCommit, execute.commit.commit, '成果版本必須對應得到 commit');
  assert.ok(f.store.events(task.id).some(e => e.kind === 'git_commit'));

  // 規劃階段是唯讀的，永遠不會 commit。
  assert.equal(threads.find(x => x.phase === 'plan').commit, undefined);
});

test('驗收未通過與執行失敗的階段一樣保存成果，但任務不會變成完成', async t => {
  const f = fixture(t); let calls = 0;
  const runner = f.runner(async o => {
    calls++;
    if (o.readOnly) return { result: plan };
    writeFileSync(join(o.cwd, `step-${calls}.md`), 'partial work');
    if (calls === 2) return { result: { ...good, passed: false, summary: '步驟尚未通過驗收' } };
    throw new Error('引擎中途失敗');
  });

  const task = f.create();
  await runner.tick();
  const base = f.store.task(task.id).git.baseCommit;
  approveTask(f.store, f.owner, task.id, 1);
  await runner.tick();   // execute，passed=false

  const afterFail = f.store.task(task.id);
  assert.notEqual(afterFail.status, 'completed');
  const first = f.store.threads(task.id).find(x => x.phase === 'execute');
  assert.equal(first.commit.fileCount, 1);
  assert.match(run(afterFail.workspace, 'log', '-1', '--format=%b'), /passed=false/);
  assert.match(run(afterFail.workspace, 'log', '-1', '--format=%b'), /不代表驗收通過/);

  // 讓同一步驟重跑一次，這次引擎直接丟出錯誤：已經寫出的檔案仍然要被保存。
  const retry = f.store.task(task.id); retry.questions = []; retry.status = 'queued'; f.store.saveTask(retry);
  await runner.tick();

  const commits = run(f.store.task(task.id).workspace, 'log', '--format=%s', `${base}..HEAD`).split('\n').filter(Boolean);
  assert.equal(commits.length, 2, '失敗的階段也要保存已寫出的檔案');
  assert.match(run(f.store.task(task.id).workspace, 'log', '-1', '--format=%b'), /本階段以錯誤結束：引擎中途失敗/);
  assert.notEqual(f.store.task(task.id).status, 'completed');
});
