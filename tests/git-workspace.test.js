import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGitRunner, createGitWorkspace, GitSafetyError, taskBranchName,
  isProtectedBranch, isUnsafeToCommit, inspectRepository, prepareTaskWorkspace, assertWorkingBranch,
} from '../server/git-workspace.js';

const git = createGitRunner();
const workspace = createGitWorkspace({ git });
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sandbox = t => { const root = mkdtempSync(join(tmpdir(), 'tf-git-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const project = root => { const path = join(root, 'project'); mkdirSync(path, { recursive: true }); return path; };
const taskId = '184abcde-0000-4000-8000-000000000001';

function seedProject(path) {
  writeFileSync(join(path, 'index.js'), 'console.log(1);\n');
  mkdirSync(join(path, 'server'), { recursive: true });
  writeFileSync(join(path, 'server', 'app.js'), 'export const app=1;\n');
  writeFileSync(join(path, '.env'), 'SECRET=do-not-commit\n');
  mkdirSync(join(path, 'server', 'config'), { recursive: true });
  writeFileSync(join(path, 'server', 'config', '.env.production'), 'TOKEN=nope\n');
  writeFileSync(join(path, 'server', 'private.pem'), 'KEY\n');
  mkdirSync(join(path, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(path, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1;\n');
}

function existingRepo(path, { branch = 'main' } = {}) {
  run(path, 'init');
  run(path, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  run(path, 'config', 'user.email', 'dev@example.test');
  run(path, 'config', 'user.name', 'Dev');
  writeFileSync(join(path, 'README.md'), '# existing\n');
  run(path, 'add', '.');
  run(path, 'commit', '-m', 'initial');
}

test('新專案：建立版本庫與初始 commit，機密與相依套件不會進入歷史', t => {
  const root = sandbox(t), path = project(root);
  seedProject(path);

  const prepared = workspace.prepare({ projectPath: path, taskId, title: 'Fix LINE webhook', worktreesDir: join(root, 'worktrees') });

  assert.equal(prepared.git.mode, 'worktree');
  assert.equal(prepared.git.baseBranch, 'main');
  assert.equal(prepared.git.workingBranch, 'taskflow/184abcde-fix-line-webhook');
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '專案目錄必須留在 main，不被任務切換分支');

  const committed = run(path, 'ls-files').split('\n');
  assert.ok(committed.includes('index.js') && committed.includes('server/app.js'));
  for (const secret of ['.env', 'server/config/.env.production', 'server/private.pem']) {
    assert.ok(!committed.includes(secret), `${secret} 不得進入初始 commit`);
  }
  assert.ok(!committed.some(f => f.startsWith('node_modules/')), 'node_modules 不得進入初始 commit');
  assert.ok(readFileSync(join(path, '.gitignore'), 'utf8').includes('.env'));
  assert.ok(prepared.events.some(e => e.kind === 'git_init'));

  // 工作目錄是獨立 worktree：改動它不會動到專案目錄，但共用同一份 .git 歷史。
  writeFileSync(join(prepared.git.workingDirectory, 'index.js'), 'console.log(2);\n');
  assert.equal(readFileSync(join(path, 'index.js'), 'utf8'), 'console.log(1);\n');
  assert.equal(run(prepared.git.workingDirectory, 'rev-parse', 'HEAD'), prepared.git.baseCommit);
});

test('既有專案：不重新 init、不改 main，從目前分支開出任務分支', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const before = run(path, 'rev-parse', 'HEAD');

  const prepared = workspace.prepare({ projectPath: path, taskId, title: 'Admin filter', worktreesDir: join(root, 'worktrees') });

  assert.equal(prepared.git.baseCommit, before, '既有 repository 的 HEAD 不得被改動');
  assert.equal(run(path, 'rev-parse', 'HEAD'), before);
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(run(path, 'rev-list', '--count', 'HEAD'), '1', '不得產生額外 commit');
  assert.equal(prepared.git.workingBranch, 'taskflow/184abcde-admin-filter');
  assert.equal(run(prepared.git.workingDirectory, 'rev-parse', '--abbrev-ref', 'HEAD'), prepared.git.workingBranch);
  assert.ok(!prepared.events.some(e => e.kind === 'git_init'));
});

test('未提交修改：停止任務並列出檔案，不清除也不 stash 使用者的內容', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  writeFileSync(join(path, 'README.md'), '# edited by user\n');
  writeFileSync(join(path, 'scratch.txt'), 'wip\n');

  let error = null;
  try { workspace.prepare({ projectPath: path, taskId, title: 'anything', worktreesDir: join(root, 'worktrees') }); } catch (e) { error = e; }
  assert.ok(error instanceof GitSafetyError && error.reason === 'dirty_working_tree');
  assert.match(error.message, /目前專案存在未提交修改/);
  assert.ok(error.details.files.some(f => f.includes('README.md')));
  assert.ok(error.details.files.some(f => f.includes('scratch.txt')));

  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), '# edited by user\n', '使用者的修改必須原封不動');
  assert.ok(existsSync(join(path, 'scratch.txt')));
  assert.equal(run(path, 'stash', 'list'), '');
  assert.ok(!existsSync(join(root, 'worktrees')) || !existsSync(join(root, 'worktrees', taskId)));
});

test('重複執行同一任務會沿用既有 worktree，且不再被未提交修改擋住', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const first = workspace.prepare({ projectPath: path, taskId, title: 'Reuse', worktreesDir: join(root, 'worktrees') });
  writeFileSync(join(path, 'README.md'), '# user edits after task started\n');

  const second = workspace.prepare({ projectPath: path, taskId, title: 'Reuse', worktreesDir: join(root, 'worktrees') });
  assert.equal(second.git.workingDirectory, first.git.workingDirectory);
  assert.equal(second.git.workingBranch, first.git.workingBranch);
});

test('受保護分支守門：main 或 detached HEAD 一律不執行 Agent', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const prepared = workspace.prepare({ projectPath: path, taskId, title: 'Guard', worktreesDir: join(root, 'worktrees') });
  const wd = prepared.git.workingDirectory;

  assert.equal(workspace.assertWorkingBranch({ workingDirectory: wd, workingBranch: prepared.git.workingBranch }), prepared.git.workingBranch);

  run(wd, 'switch', '--detach');
  assert.throws(() => workspace.assertWorkingBranch({ workingDirectory: wd, workingBranch: prepared.git.workingBranch }),
    e => e.code === 'GIT_SAFETY' && e.reason === 'detached_head');

  run(wd, 'switch', '-c', 'release');
  assert.throws(() => workspace.assertWorkingBranch({ workingDirectory: wd, workingBranch: prepared.git.workingBranch }),
    e => e.reason === 'protected_branch' && /不允許直接修改正式 branch/.test(e.message));

  run(wd, 'switch', '-c', 'somewhere-else');
  assert.throws(() => workspace.assertWorkingBranch({ workingDirectory: wd, workingBranch: prepared.git.workingBranch }),
    e => e.reason === 'branch_changed');

  rmSync(wd, { recursive: true, force: true });
  assert.throws(() => workspace.assertWorkingBranch({ workingDirectory: wd, workingBranch: prepared.git.workingBranch }),
    e => e.reason === 'worktree_missing');
});

test('破壞性 git 指令無法從 TaskFlow 自動化流程送出', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const forbidden = [['reset', '--hard'], ['clean', '-fd'], ['push', 'origin', 'main'], ['stash'], ['restore', '.'], ['checkout', '--', '.'], ['branch', '-D', 'x'], ['rm', '-r', 'server']];
  for (const args of forbidden) {
    assert.throws(() => git(path, args), e => e.code === 'GIT_SAFETY' && e.reason === 'forbidden_command', `git ${args.join(' ')} 必須被擋下`);
  }
  assert.ok((git(path, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', 'nothing'], { allowFailure: true })) !== undefined, 'git rm --cached 仍可用於初始 commit 過濾');
});

test('巢狀 repository、無 commit 與 detached HEAD 的專案會停止並說明原因', t => {
  const root = sandbox(t);
  const outer = join(root, 'outer'); mkdirSync(outer, { recursive: true }); existingRepo(outer);
  const inner = join(outer, 'packages', 'app'); mkdirSync(inner, { recursive: true }); writeFileSync(join(inner, 'a.js'), '1\n');
  assert.throws(() => workspace.prepare({ projectPath: inner, taskId, title: 'nested', worktreesDir: join(root, 'wt') }),
    e => e.reason === 'nested_repository');

  const empty = join(root, 'empty'); mkdirSync(empty, { recursive: true });
  run(empty, 'init'); run(empty, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(empty, 'a.js'), '1\n');
  assert.throws(() => workspace.prepare({ projectPath: empty, taskId, title: 'no commits', worktreesDir: join(root, 'wt2') }),
    e => e.reason === 'no_commits');

  const detached = join(root, 'detached'); mkdirSync(detached, { recursive: true }); existingRepo(detached);
  run(detached, 'switch', '--detach');
  assert.throws(() => workspace.prepare({ projectPath: detached, taskId, title: 'detached', worktreesDir: join(root, 'wt3') }),
    e => e.reason === 'detached_head');
});

test('分支命名與受保護清單', () => {
  assert.equal(taskBranchName({ taskId: '184abcde-1111-4000-8000-000000000001', title: 'Fix LINE webhook 修正' }), 'taskflow/184abcde-fix-line-webhook');
  assert.equal(taskBranchName({ taskId: '185abcde-1111-4000-8000-000000000001', title: '修正通知設定' }), 'taskflow/185abcde');
  assert.equal(taskBranchName({ taskId: '186abcde-1111-4000-8000-000000000001', title: '  ...  ' }), 'taskflow/186abcde');
  assert.ok(!taskBranchName({ taskId: 'abc', title: 'a..b' }).includes('..'));
  assert.ok(isProtectedBranch('MAIN') && isProtectedBranch('develop') && !isProtectedBranch('taskflow/1-x'));
  assert.ok(isProtectedBranch('qa', ['qa']) && !isProtectedBranch('main', ['qa']));
  assert.ok(isUnsafeToCommit('.env.local') && isUnsafeToCommit('node_modules') && isUnsafeToCommit('taskflow.sqlite') && !isUnsafeToCommit('index.js'));
});

test('inspectRepository 回報非版本庫、乾淨與髒污狀態', t => {
  const root = sandbox(t), path = project(root);
  writeFileSync(join(path, 'a.js'), '1\n');
  assert.deepEqual(inspectRepository(path, { git }), { isRepository: false, repositoryPath: null, nested: false });
  existingRepo(path);
  const clean = inspectRepository(path, { git });
  assert.ok(clean.isRepository && clean.branch === 'main' && clean.dirty.length === 0 && !clean.nested);
  writeFileSync(join(path, 'a.js'), '2\n');
  assert.equal((inspectRepository(path, { git })).dirty.length, 1);
  assert.throws(() => inspectRepository(join(root, 'missing'), { git }), e => e.reason === 'project_missing');
});

test('直接呼叫 prepareTaskWorkspace 可注入自訂受保護分支', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path, { branch: 'trunk' });
  const prepared = prepareTaskWorkspace({ projectPath: path, taskId, title: 'Custom', worktreesDir: join(root, 'wt'), protectedBranches: ['trunk'], git });
  assert.equal(prepared.git.baseBranch, 'trunk');
  assert.throws(() => assertWorkingBranch({ workingDirectory: path, workingBranch: null, protectedBranches: ['trunk'], git }),
    e => e.reason === 'protected_branch');
});

test('階段 commit：有修改才 commit，機密與執行期檔案不進版', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const prepared = workspace.prepare({ projectPath: path, taskId, title: 'Commit', worktreesDir: join(root, 'worktrees') });
  const wd = prepared.git.workingDirectory, branch = prepared.git.workingBranch;
  const commit = (subject, body) => workspace.commit({ workingDirectory: wd, workingBranch: branch, subject, body });

  // 沒有任何修改 → 不留空 commit。
  assert.deepEqual(commit('taskflow(execute): nothing'), { committed: false, reason: 'no_changes', files: [], skipped: [] });

  writeFileSync(join(wd, 'result.md'), 'delivered\n');
  mkdirSync(join(wd, '.taskflow'), { recursive: true });
  writeFileSync(join(wd, '.taskflow', 'npm-cache.json'), '{}');
  writeFileSync(join(wd, 'secret.pem'), 'KEY\n');

  const first = commit('taskflow(execute): 撰寫文件', 'passed=true');
  assert.equal(first.committed, true);
  assert.deepEqual(first.files, ['result.md']);
  assert.ok(first.skipped.some(p => p.startsWith('.taskflow')) && first.skipped.includes('secret.pem'));
  assert.equal(run(wd, 'log', '-1', '--format=%s'), 'taskflow(execute): 撰寫文件');
  assert.match(run(wd, 'log', '-1', '--format=%b'), /passed=true/);
  assert.equal(run(wd, 'rev-parse', 'HEAD'), first.commit);

  // 只剩下被排除的變動 → 仍然不 commit，也不會把它們留在索引裡。
  writeFileSync(join(wd, '.taskflow', 'npm-cache.json'), '{"x":1}');
  const second = commit('taskflow(execute): only excluded');
  assert.equal(second.committed, false);
  assert.equal(second.reason, 'only_excluded_changes');
  assert.equal(run(wd, 'rev-parse', 'HEAD'), first.commit);
  assert.equal(run(wd, 'diff', '--cached', '--name-only'), '');
  assert.ok(!run(wd, 'ls-files').split('\n').includes('secret.pem'));

  // 刪除與改名也要被保存。
  run(wd, 'mv', 'result.md', 'delivered.md');
  rmSync(join(wd, 'README.md'));
  const third = commit('taskflow(repair): 調整檔名');
  assert.equal(third.committed, true);
  const tracked = run(wd, 'ls-files').split('\n');
  assert.ok(tracked.includes('delivered.md') && !tracked.includes('result.md') && !tracked.includes('README.md'));

  // 專案目錄完全不受影響：commit 只發生在任務分支上。
  assert.equal(run(path, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(workspace.commits({ workingDirectory: wd, baseCommit: prepared.git.baseCommit }).length, 2);
});

test('階段 commit 前仍然重跑分支守門', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const prepared = workspace.prepare({ projectPath: path, taskId, title: 'Guarded commit', worktreesDir: join(root, 'worktrees') });
  const wd = prepared.git.workingDirectory;
  writeFileSync(join(wd, 'result.md'), 'delivered\n');
  run(wd, 'switch', '-c', 'somewhere-else');

  assert.throws(() => workspace.commit({ workingDirectory: wd, workingBranch: prepared.git.workingBranch, subject: 'taskflow(execute): x' }),
    e => e.code === 'GIT_SAFETY' && e.reason === 'branch_changed');
  assert.equal(run(wd, 'rev-parse', 'HEAD'), prepared.git.baseCommit, '守門擋下時不得產生 commit');
});

function taskWithCommit(root, path, { title = 'Merge me', file = 'result.md', content = 'delivered\n' } = {}) {
  const prepared = workspace.prepare({ projectPath: path, taskId, title, worktreesDir: join(root, 'worktrees') });
  writeFileSync(join(prepared.git.workingDirectory, file), content);
  const outcome = workspace.commit({ workingDirectory: prepared.git.workingDirectory, workingBranch: prepared.git.workingBranch, subject: 'taskflow(execute): 完成工作' });
  return { ...prepared.git, taskCommit: outcome.commit };
}

test('核准合併：--no-ff 保留任務邊界，成果進入正式分支', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path);

  const outcome = workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: task.baseBranch, workingBranch: task.workingBranch, subject: `taskflow: 合併 ${task.workingBranch}`, body: '經使用者核准' });

  assert.equal(outcome.merged, true);
  assert.equal(readFileSync(join(path, 'result.md'), 'utf8'), 'delivered\n');
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(run(path, 'rev-list', '--count', '--merges', 'HEAD'), '1', '必須是 merge commit，不是 fast-forward');
  assert.equal(run(path, 'rev-list', '--count', '--parents', '-1', 'HEAD').split(' ').length, 1);
  assert.equal(run(path, 'log', '-1', '--format=%P').split(' ').length, 2, 'merge commit 必須有兩個 parent');
  assert.match(run(path, 'log', '-1', '--format=%s'), /taskflow: 合併/);
  assert.equal(run(path, 'status', '--porcelain'), '');

  // 合併過就不再重複合併。
  assert.deepEqual(workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: task.baseBranch, workingBranch: task.workingBranch, subject: 'again' }),
    { merged: false, reason: 'already_merged', baseBranch: 'main', workingBranch: task.workingBranch });
});

test('正式分支未就緒時不合併：不乾淨、不在 base branch、分支已消失', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path);
  const merge = () => workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: task.baseBranch, workingBranch: task.workingBranch, subject: 'taskflow: merge' });
  const head = run(path, 'rev-parse', 'HEAD');

  writeFileSync(join(path, 'user-wip.txt'), 'wip\n');
  assert.throws(merge, e => e.code === 'GIT_SAFETY' && e.reason === 'dirty_working_tree');
  assert.ok(existsSync(join(path, 'user-wip.txt')), '使用者的檔案不得被清掉');
  rmSync(join(path, 'user-wip.txt'));

  run(path, 'switch', '-c', 'my-own-branch');
  assert.throws(merge, e => e.reason === 'base_branch_not_checked_out');
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'my-own-branch', 'TaskFlow 不得替使用者切換分支');
  run(path, 'switch', 'main');

  assert.equal(run(path, 'rev-parse', 'HEAD'), head, '任何一次被擋下都不得改動正式分支');
  assert.throws(() => workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: 'main', workingBranch: 'taskflow/does-not-exist', subject: 'x' }),
    e => e.reason === 'branch_missing');
});

test('合併衝突：回報衝突檔案，正式分支一個字都不動', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path, { file: 'README.md', content: '# 任務的版本\n' });

  // 任務開始後，使用者自己也改了同一個檔案並提交。
  writeFileSync(join(path, 'README.md'), '# 使用者的版本\n');
  run(path, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', 'user edit');
  const head = run(path, 'rev-parse', 'HEAD');

  const outcome = workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: 'main', workingBranch: task.workingBranch, subject: 'taskflow: merge' });

  assert.equal(outcome.merged, false);
  assert.equal(outcome.reason, 'conflict');
  assert.deepEqual(outcome.files, ['README.md']);
  assert.match(outcome.hint, /不會自行決定 ours／theirs/);
  assert.equal(run(path, 'rev-parse', 'HEAD'), head, '衝突時不得產生任何 commit');
  assert.equal(run(path, 'status', '--porcelain'), '', '不得把正式分支丟在解到一半的 merge 狀態');
  assert.equal(existsSync(join(path, '.git', 'MERGE_HEAD')), false);
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), '# 使用者的版本\n');
});

test('清理：合併後移除 worktree 與分支；有未提交內容時拒絕移除', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path);
  workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: 'main', workingBranch: task.workingBranch, subject: 'taskflow: merge' });

  writeFileSync(join(task.workingDirectory, 'leftover.txt'), 'not committed\n');
  const blocked = workspace.cleanup({ repositoryPath: task.repositoryPath, workingDirectory: task.workingDirectory, workingBranch: task.workingBranch });
  assert.equal(blocked.removed, false);
  assert.equal(blocked.reason, 'worktree_not_removable');
  assert.ok(existsSync(join(task.workingDirectory, 'leftover.txt')), '拒絕移除時不得丟掉任何內容');

  rmSync(join(task.workingDirectory, 'leftover.txt'));
  const done = workspace.cleanup({ repositoryPath: task.repositoryPath, workingDirectory: task.workingDirectory, workingBranch: task.workingBranch });
  assert.equal(done.removed, true);
  assert.equal(done.branchDeleted, true);
  assert.equal(existsSync(task.workingDirectory), false);
  assert.ok(!run(path, 'branch', '--list', task.workingBranch));
});

test('拒絕後刪除未合併分支需要明確授權；一般路徑刪不掉', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path);

  const safe = workspace.cleanup({ repositoryPath: task.repositoryPath, workingDirectory: task.workingDirectory, workingBranch: task.workingBranch });
  assert.equal(safe.removed, true);
  assert.equal(safe.branchDeleted, false, '未合併的分支不得被安全刪除路徑刪掉');
  assert.ok(run(path, 'branch', '--list', task.workingBranch));

  const forced = workspace.cleanup({ repositoryPath: task.repositoryPath, workingDirectory: null, workingBranch: task.workingBranch, deleteUnmerged: true });
  assert.equal(forced.branchDeleted, true);
  assert.ok(!run(path, 'branch', '--list', task.workingBranch));

  // 授權通道只放行它自己那一個指令，其餘照樣擋。
  assert.throws(() => git(path, ['reset', '--hard'], { authorizedAs: 'delete_rejected_branch' }), e => e.reason === 'forbidden_command');
  assert.throws(() => git(path, ['branch', '-D', 'x'], { authorizedAs: 'abort_merge' }), e => e.reason === 'forbidden_command');
  assert.throws(() => git(path, ['branch', '-D', 'x'], { authorizedAs: 'nonsense' }), e => e.reason === 'forbidden_command');
});

test('Rollback：撤銷 merge commit，不必回頭找舊資料夾', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path);
  const merged = workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: 'main', workingBranch: task.workingBranch, subject: 'taskflow: merge' });
  assert.ok(existsSync(join(path, 'result.md')));

  const outcome = workspace.revert({ repositoryPath: task.repositoryPath, baseBranch: 'main', mergeCommit: merged.commit, subject: `taskflow: 撤銷 ${task.workingBranch}` });

  assert.equal(outcome.reverted, true);
  assert.equal(existsSync(join(path, 'result.md')), false, '成果必須被撤銷');
  assert.equal(run(path, 'status', '--porcelain'), '');
  assert.match(run(path, 'log', '-1', '--format=%s'), /撤銷/);
  assert.ok(run(path, 'cat-file', '-t', merged.commit), '原本的 merge commit 仍留在歷史中');
  assert.equal(run(path, 'rev-list', '--count', 'HEAD'), '4');
});
