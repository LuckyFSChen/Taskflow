import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGitRunner, createGitWorkspace, GitSafetyError, taskBranchName,
  isProtectedBranch,
  isUnsafeToCommit,
  inspectRepository,
  inspectMergeState,
  mergeTaskBranch,
  prepareTaskWorkspace,
  assertWorkingBranch,
  ensureProjectRepository,
} from '../server/git-workspace.js';
import { detectRepositoryInfo, evaluateRepositoryPolicy, samePath } from '../server/git-repository.js';

const git = createGitRunner();
const workspace = createGitWorkspace({ git });
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
// 經過 git checkout（worktree、merge）才出現的檔案，在 core.autocrlf=true 的 Windows 上會被
// 改寫成 CRLF。這些斷言檢查的是「內容對不對」，不是換行字元，所以比對前統一換行。
const readText = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
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

test('使用者確認過的未提交修改：指紋相同才放行，而且一個檔案都不動', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  writeFileSync(join(path, 'README.md'), '# edited by user\n');
  writeFileSync(join(path, 'scratch.txt'), 'wip\n');

  const blocked = (() => { try { workspace.prepare({ projectPath: path, taskId, title: 'Approved', worktreesDir: join(root, 'worktrees') }); return null; } catch (e) { return e; } })();
  const approvedFingerprint = blocked.details.fingerprint;
  assert.ok(approvedFingerprint, '守門必須提供可以再次比對的指紋');
  assert.equal(blocked.details.fileCount, 2);

  // 指紋不符（例如舊的核准）不得放行。
  assert.throws(
    () => workspace.prepare({ projectPath: path, taskId, title: 'Approved', worktreesDir: join(root, 'worktrees'), approvedDirtyFingerprint: 'stale-fingerprint' }),
    e => e.reason === 'dirty_working_tree',
  );

  // 指紋相符：任務可以開始，使用者的未提交修改留在原處，不進入任務分支。
  const prepared = workspace.prepare({ projectPath: path, taskId, title: 'Approved', worktreesDir: join(root, 'worktrees'), approvedDirtyFingerprint: approvedFingerprint });
  assert.equal(prepared.git.mode, 'worktree');
  assert.ok(prepared.events.some(e => e.kind === 'git_dirty_approved' && /不 reset、不 clean、不 stash、不刪除、不覆蓋/.test(e.message)));
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), '# edited by user\n', '使用者的修改必須原封不動');
  assert.ok(existsSync(join(path, 'scratch.txt')));
  assert.equal(run(path, 'stash', 'list'), '');
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(readText(join(prepared.git.workingDirectory, 'README.md')), '# existing\n', '任務分支自最後一次 commit 開出，未提交修改不會被帶進去');
  assert.ok(!existsSync(join(prepared.git.workingDirectory, 'scratch.txt')));

  // 之後又有新修改：因為 worktree 已存在（reusing），這個任務不再重跑 dirty 守門，
  // 但使用者的新檔案同樣不會被動到。
  writeFileSync(join(path, 'later.txt'), 'more\n');
  workspace.prepare({ projectPath: path, taskId, title: 'Approved', worktreesDir: join(root, 'worktrees') });
  assert.ok(existsSync(join(path, 'later.txt')));
});

test('git status 讀取失敗時不得回報「乾淨」', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const failing = (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, stdout: `${path}\n`, stderr: '' };
    if (args[0] === 'status') return { ok: false, stdout: '', stderr: 'fatal: detected dubious ownership' };
    return { ok: true, stdout: '', stderr: '' };
  };
  assert.throws(() => inspectRepository(path, { git: failing }), e => e.reason === 'git_status_failed' && /不會假設工作目錄是乾淨的/.test(e.message));
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
  const absent = inspectRepository(path, { git });
  assert.equal(absent.isRepository, false);
  assert.equal(absent.repositoryPath, null);
  assert.equal(absent.nested, false);
  assert.equal(absent.repository.repositoryType, 'non-git');
  assert.equal(absent.policy.nextAction, 'git-init');
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
  assert.equal(readText(join(path, 'result.md')), 'delivered\n');
  assert.equal(run(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(run(path, 'rev-list', '--count', '--merges', 'HEAD'), '1', '必須是 merge commit，不是 fast-forward');
  assert.equal(run(path, 'rev-list', '--count', '--parents', '-1', 'HEAD').split(' ').length, 1);
  assert.equal(run(path, 'log', '-1', '--format=%P').split(' ').length, 2, 'merge commit 必須有兩個 parent');
  assert.match(run(path, 'log', '-1', '--format=%s'), /taskflow: 合併/);
  assert.equal(run(path, 'status', '--porcelain'), '');

  // 情境 1／clean merge：新的 inspector 必須確認乾淨、無進行中的 merge、HEAD 真的包含 workingBranch，
  // 不是只看 merge command 有沒有回報成功。
  const inspected = inspectMergeState({ repositoryPath: task.repositoryPath, git });
  assert.equal(inspected.clean, true);
  assert.equal(inspected.mergeInProgress, false);
  assert.deepEqual(inspected.unresolvedFiles, []);
  assert.equal(inspected.branch, 'main');
  assert.equal(inspected.head, outcome.commit);
  assert.ok(git(task.repositoryPath, ['merge-base', '--is-ancestor', task.workingBranch, 'HEAD'], { allowFailure: true }).ok, 'HEAD 必須真的包含 workingBranch');

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

  // 情境 2／conflict：新的 inspector 也必須確認 baseBranch 事後乾淨、無 MERGE_HEAD 殘留。
  const inspected = inspectMergeState({ repositoryPath: task.repositoryPath, git });
  assert.equal(inspected.clean, true);
  assert.equal(inspected.mergeInProgress, false);
  assert.deepEqual(inspected.unresolvedFiles, []);
});

test('情境 3／衝突已解決但尚未 commit：inspectMergeState 判斷為 mergeInProgress，assertMergeReady 回報 merge_in_progress 而非籠統的 dirty_working_tree', t => {
  const root = sandbox(t), path = project(root);
  existingRepo(path);
  const task = taskWithCommit(root, path, { file: 'README.md', content: '# 任務的版本\n' });

  writeFileSync(join(path, 'README.md'), '# 使用者的版本\n');
  run(path, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', 'user edit');

  // 直接在正式分支上觸發一次真的衝突，並像使用者一樣手動解決它：寫入解決後的內容、git add，
  // 但刻意不 commit——這正是「衝突已解決但尚未 commit」的狀態，MERGE_HEAD 仍然存在。
  const attempt = git(path, ['merge', '--no-ff', '--no-commit', task.workingBranch], { allowFailure: true });
  assert.equal(attempt.ok, false, '這一步本來就預期會產生衝突');
  writeFileSync(join(path, 'README.md'), '# 手動解決後的版本\n');
  git(path, ['add', 'README.md']);

  const inspected = inspectMergeState({ repositoryPath: path, git });
  assert.equal(inspected.mergeInProgress, true, 'MERGE_HEAD 仍在，必須被判斷為進行中的 merge');
  assert.deepEqual(inspected.unresolvedFiles, [], '已經 git add 過，不再是未解決檔案');
  assert.equal(inspected.clean, false);

  assert.throws(
    () => workspace.merge({ repositoryPath: task.repositoryPath, baseBranch: 'main', workingBranch: task.workingBranch, subject: 'taskflow: merge' }),
    e => e.code === 'GIT_SAFETY' && e.reason === 'merge_in_progress' && /衝突已經解決但尚未完成 commit/.test(e.message) && Array.isArray(e.details.unresolvedFiles) && e.details.unresolvedFiles.length === 0,
  );
});

test('情境 5／command 回報成功但 repository 仍有 unresolved files：mergeTaskBranch 不信任這個旗標，一律用 inspector 的實際狀態判斷並自動 abort', t => {
  // repositoryPath 只需要在檔案系統上存在（inspectRepository 的第一道檢查），底下所有 git 指令
  // 都由 lyingGit 接管、完全不會真的執行，所以這裡不需要是一個真的 git repository。
  const repositoryPath = sandbox(t);
  const baseBranch = 'main';
  const workingBranch = 'taskflow/fake-branch';
  let mergeCommandExecuted = false;
  let abortCalled = false;

  const lyingGit = (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, stdout: `${repositoryPath}\n`, stderr: '' };
    if (args[0] === 'branch' && args[1] === '--show-current') return { ok: true, stdout: `${baseBranch}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    if (args[0] === 'status' && args[1] === '--porcelain') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
      // 一開始沒有進行中的衝突；「merge」執行過之後，repository 實際上仍卡在未解決狀態。
      return mergeCommandExecuted ? { ok: true, stdout: 'README.md\n', stderr: '' } : { ok: true, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args.includes('-q') && args.includes('--verify') && args.includes('MERGE_HEAD')) {
      return { ok: mergeCommandExecuted, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('--quiet') && args.includes(`refs/heads/${workingBranch}`)) {
      return { ok: true, stdout: '', stderr: '' };
    }
    if (args[0] === 'merge-base' && args.includes('--is-ancestor')) return { ok: false, stdout: '', stderr: '' };
    // pre-check（merge-tree）宣稱沒有衝突：這正是「pre-check 通過後，真正執行仍可能失敗」的情境。
    if (args[0] === 'merge-tree') return { ok: true, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    // 真正執行的 merge 前面會被加上 -c user.email=…／-c user.name=… 身分旗標（見 commitArgs），
    // 所以不能只看 args[0]，得看整組參數是否包含 merge --no-ff --no-edit。
    if (args.includes('merge') && args.includes('--no-ff') && args.includes('--no-edit')) {
      mergeCommandExecuted = true;
      // 指令本身謊稱成功，即使 repository 實際上仍未完成合併。
      return { ok: true, stdout: 'Merge made by the recursive strategy.\n', stderr: '' };
    }
    if (args[0] === 'merge' && args.includes('--abort')) { abortCalled = true; return { ok: true, stdout: '', stderr: '' }; }
    if (args[0] === 'config') return { ok: false, stdout: '', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };

  const outcome = mergeTaskBranch({ repositoryPath, baseBranch, workingBranch, subject: 'taskflow: merge', git: lyingGit });

  assert.equal(mergeCommandExecuted, true, '測試前提：真正執行的 merge 指令必須被呼叫過');
  assert.equal(outcome.merged, false, 'command 回報成功不得直接視為合併完成');
  assert.equal(outcome.reason, 'conflict');
  assert.deepEqual(outcome.files, ['README.md']);
  assert.equal(abortCalled, true, '偵測到仍有未解決檔案時，必須自動 abort 讓 baseBranch 回到乾淨狀態');
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

// ── Repository topology 回歸測試 ────────────────────────────────────────────────
//
// 這一組測試釘住 git-repository.js 的 canonical model。每一個 case 都對應一種真實會遇到的
// 目錄結構，重點在於「Git 語意」與「TaskFlow 產品語意」不一致時，誰說了算：
//   - working tree root 一律以 `git rev-parse --show-toplevel` 為準（不向上找 .git）
//   - 唯一的例外是 TaskFlow 自己管理、但還沒 git init 的專案 root（managed-uninitialized）
//
// tmpdir 在部分平台上是 symlink（macOS 的 /tmp → /private/tmp），而 git 回報的是 realpath，
// 所以這裡的 sandbox 一律先 realpath 再使用，否則路徑比對會假性失敗。
const realSandbox = t => realpathSync(sandbox(t));

/** F:\TaskFlow 的縮影：外層 repository + 被忽略的 Projects/ 與 data/ 兩個資料夾。 */
function taskflowLayout(root) {
  const taskflow = join(root, 'TaskFlow');
  mkdirSync(taskflow, { recursive: true });
  existingRepo(taskflow);
  writeFileSync(join(taskflow, '.gitignore'), 'data/\nProjects/\n');
  run(taskflow, 'add', '.');
  run(taskflow, 'commit', '-m', 'ignore generated folders');
  const projectsRoot = join(taskflow, 'Projects');
  const worktreesDir = join(taskflow, 'data', 'worktrees');
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  return { taskflow, projectsRoot, worktreesDir };
}

test('topology A：TaskFlow 管理的專案尚未 git init，不得判成巢狀版本庫', t => {
  const root = realSandbox(t);
  const { taskflow, projectsRoot } = taskflowLayout(root);
  const managed = join(projectsRoot, 'new-project');
  mkdirSync(managed, { recursive: true });

  // 純 Git 語意：--show-toplevel 會一路解析到 F:\TaskFlow。這個結果本身沒有錯……
  assert.equal(run(managed, 'rev-parse', '--show-toplevel'), taskflow.replaceAll('\\', '/'));
  assert.equal(detectRepositoryInfo(managed, { git }).repositoryType, 'subdirectory',
    '沒有 TaskFlow context 時，它在 Git 語意上確實只是子目錄');

  // ……但帶上 TaskFlow 自己的 project metadata 之後，它是一個尚未初始化的獨立專案 root。
  const info = detectRepositoryInfo(managed, { git, projectRoot: managed, managedProjectsRoot: projectsRoot });
  assert.equal(info.repositoryType, 'managed-uninitialized');
  assert.equal(info.isGit, false);
  assert.equal(info.isManagedProject, true);
  assert.equal(info.isRepositoryRoot, true);
  assert.equal(info.isSubdirectory, false);
  assert.equal(info.needsGitInit, true);
  assert.equal(info.branch, null, '不得把上層版本庫的分支當成這個專案的分支');
  assert.ok(samePath(info.inheritedOuterRepository, taskflow));

  assert.deepEqual(evaluateRepositoryPolicy(info),
    { blocked: false, requiresUserAction: false, nextAction: 'git-init', blockReason: null });

  const state = inspectRepository(managed, { git, projectRoot: managed, managedProjectsRoot: projectsRoot });
  assert.equal(state.nested, false, '這正是先前誤判成 nested_repository 的來源');
});

test('topology B：managed project 派工時自行初始化版本庫，之後是正常的 repository root', t => {
  const root = realSandbox(t);
  const { taskflow, projectsRoot } = taskflowLayout(root);
  const managed = join(projectsRoot, 'new-project');
  mkdirSync(managed, { recursive: true });
  const outerHead = run(taskflow, 'rev-parse', 'HEAD');

  const prepared = workspace.prepare({
    projectPath: managed, taskId, title: 'managed project', worktreesDir: join(root, 'wt'),
    projectRoot: managed, managedProjectsRoot: projectsRoot,
  });

  assert.ok(existsSync(join(managed, '.git')), '專案必須取得自己的版本庫');
  assert.equal(run(managed, 'rev-parse', '--show-toplevel'), managed.replaceAll('\\', '/'));
  assert.equal(prepared.git.repositoryPath, managed);
  assert.equal(prepared.git.baseBranch, 'main');
  assert.ok(prepared.events.some(e => e.kind === 'git_init' && e.message.includes('上層版本庫')),
    '工作紀錄要說明為什麼這裡多出一個版本庫');
  assert.equal(run(taskflow, 'rev-parse', 'HEAD'), outerHead, '上層版本庫不得被改動');
  assert.equal(run(taskflow, 'status', '--porcelain'), '', '上層版本庫的工作樹不得出現新的變更');

  // 初始化之後就是一個合法的獨立 repository root（實體上仍在 TaskFlow 底下，故為 nested-independent）。
  const after = detectRepositoryInfo(managed, { git, projectRoot: managed, managedProjectsRoot: projectsRoot });
  assert.equal(after.repositoryType, 'nested-independent');
  assert.equal(after.isRepositoryRoot, true);
  assert.equal(after.needsGitInit, false);
  assert.equal(evaluateRepositoryPolicy(after).blocked, false);
});

test('topology C：真正的 repository 子目錄仍然被擋，且不會被 managed context 放行', t => {
  const root = realSandbox(t);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  existingRepo(repo);
  const frontend = join(repo, 'frontend');
  mkdirSync(frontend, { recursive: true });
  writeFileSync(join(frontend, 'a.js'), '1\n');

  const info = detectRepositoryInfo(frontend, { git });
  assert.equal(info.repositoryType, 'subdirectory');
  assert.equal(info.isSubdirectory, true);
  assert.equal(info.isRepositoryRoot, false);
  assert.deepEqual(evaluateRepositoryPolicy(info),
    { blocked: true, requiresUserAction: true, nextAction: 'user-action', blockReason: 'repository-subdirectory' });

  // 就算它被登記成專案，只要不在 TaskFlow 管理的專案存放位置底下，就不是 managed project。
  const registered = detectRepositoryInfo(frontend, { git, projectRoot: frontend, managedProjectsRoot: join(root, 'elsewhere') });
  assert.equal(registered.repositoryType, 'subdirectory');
  assert.equal(registered.isManagedProject, false);

  assert.throws(() => workspace.prepare({
    projectPath: frontend, taskId, title: 'subdirectory', worktreesDir: join(root, 'wt'),
    projectRoot: frontend, managedProjectsRoot: join(root, 'elsewhere'),
  }), e => e.reason === 'nested_repository');
  // 被擋下來時絕對不能就地 git init：那會在別人追蹤中的工作樹裡塞一個內嵌版本庫。
  assert.ok(!existsSync(join(frontend, '.git')));
  assert.equal(ensureProjectRepository(frontend, { git, projectRoot: frontend, managedProjectsRoot: join(root, 'elsewhere') }).initialized, false);
});

test('topology D：linked worktree 實體位於另一個 repository 底下，仍是合法的 worktree root', t => {
  const root = realSandbox(t);
  const { taskflow, projectsRoot, worktreesDir } = taskflowLayout(root);
  const source = join(projectsRoot, 'idv-web');
  mkdirSync(source, { recursive: true });
  existingRepo(source);
  const worktree = join(worktreesDir, '77fe4c5a-3b76-4667-a1fe-9fa4426a3132');
  run(source, 'worktree', 'add', '-b', 'taskflow/77fe4c5a', worktree);

  const info = detectRepositoryInfo(worktree, { git });
  assert.equal(info.repositoryType, 'linked-worktree');
  assert.equal(info.isLinkedWorktree, true);
  assert.equal(info.isRepositoryRoot, true);
  assert.equal(info.isSubdirectory, false);
  assert.ok(samePath(info.worktreeRoot, worktree));
  assert.ok(samePath(info.commonGitDir, join(source, '.git')));
  assert.ok(!samePath(info.gitDir, info.commonGitDir), 'linked worktree 有自己的 git-dir');
  assert.ok(samePath(info.mainWorktree, source));
  assert.ok(samePath(info.physicalParentRepository, taskflow), '實體父版本庫只當診斷資訊');
  assert.equal(evaluateRepositoryPolicy(info).blocked, false,
    `F:\\TaskFlow\\.git 存在也不得影響結果`);
  assert.equal(inspectRepository(worktree, { git }).nested, false);
});

test('topology E／F：nested independent repository 合法，純資料夾為 non-git', t => {
  const root = realSandbox(t);
  const outer = join(root, 'outer');
  mkdirSync(outer, { recursive: true });
  existingRepo(outer);
  const inner = join(outer, 'inner');
  mkdirSync(inner, { recursive: true });
  existingRepo(inner);

  const nested = detectRepositoryInfo(inner, { git });
  assert.equal(nested.repositoryType, 'nested-independent');
  assert.equal(nested.isRepositoryRoot, true);
  assert.equal(nested.isSubdirectory, false);
  assert.ok(samePath(nested.physicalParentRepository, outer));
  assert.equal(evaluateRepositoryPolicy(nested).blocked, false);

  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  const nonGit = detectRepositoryInfo(plain, { git });
  assert.equal(nonGit.repositoryType, 'non-git');
  assert.equal(nonGit.isGit, false);
  assert.equal(nonGit.needsGitInit, true);
  assert.equal(evaluateRepositoryPolicy(nonGit).nextAction, 'git-init');

  const normal = detectRepositoryInfo(outer, { git });
  assert.equal(normal.repositoryType, 'normal');
  assert.equal(normal.isRepositoryRoot, true);
  assert.equal(evaluateRepositoryPolicy(normal).nextAction, 'continue');
});

test('topology G：專案建立時就取得自己的版本庫（ensureProjectRepository）', t => {
  const root = realSandbox(t);
  const { taskflow, projectsRoot } = taskflowLayout(root);
  const managed = join(projectsRoot, 'brand-new');
  mkdirSync(managed, { recursive: true });

  const outcome = ensureProjectRepository(managed, { git, projectRoot: managed, managedProjectsRoot: projectsRoot });
  assert.equal(outcome.initialized, true);
  assert.equal(run(managed, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(run(taskflow, 'status', '--porcelain'), '', '上層版本庫不得看到任何新變更');

  // 已經初始化過就不再重複動作。
  assert.equal(ensureProjectRepository(managed, { git, projectRoot: managed, managedProjectsRoot: projectsRoot }).initialized, false);

  // 之後派工走的是既有 repository 路徑，不會再 init 一次。
  const prepared = workspace.prepare({
    projectPath: managed, taskId, title: 'brand new', worktreesDir: join(root, 'wt'),
    projectRoot: managed, managedProjectsRoot: projectsRoot,
  });
  assert.ok(!prepared.events.some(e => e.kind === 'git_init'));
  assert.equal(prepared.git.repositoryPath, managed);
});

test('舊版 git（沒有 merge-tree --write-tree）：專案未設定 git 身分時仍能正確試算合併', t => {
  const root = realSandbox(t);
  const path = join(root, 'repo');
  mkdirSync(path, { recursive: true });
  // 刻意不設定 user.email／user.name：TaskFlow 明確支援這種專案（commitArgs 會補上暫時身分）。
  run(path, 'init');
  run(path, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  run(path, 'add', '.');
  run(path, '-c', 'user.email=seed@example.test', '-c', 'user.name=Seed', 'commit', '-m', 'initial');

  // git < 2.38 沒有 `merge-tree --write-tree`，會退回「真的試一次合併再 abort」那條路徑。
  const oldGit = (cwd, args, options) => args[0] === 'merge-tree'
    ? { ok: false, stdout: '', stderr: 'usage: git merge-tree <base-tree> <branch1> <branch2>\n' }
    : git(cwd, args, options);
  const oldWorkspace = createGitWorkspace({ git: oldGit });

  const prepared = oldWorkspace.prepare({ projectPath: path, taskId, title: 'old git merge', worktreesDir: join(root, 'wt') });
  writeFileSync(join(prepared.git.workingDirectory, 'b.txt'), 'two\n');
  const committed = oldWorkspace.commit({
    workingDirectory: prepared.git.workingDirectory, workingBranch: prepared.git.workingBranch,
    subject: 'taskflow(execute): add b',
  });
  assert.equal(committed.committed, true);

  // 沒有 committer identity 時，這一步以前會失敗並被誤判成「有衝突、但沒有任何衝突檔案」，
  // 於是合併永遠被擋住。現在必須正常完成。
  const merged = oldWorkspace.merge({
    repositoryPath: path, baseBranch: 'main', workingBranch: prepared.git.workingBranch,
    subject: 'taskflow(merge): add b',
  });
  assert.equal(merged.merged, true, '沒有設定 git 身分不得被誤判成合併衝突');
  assert.ok(existsSync(join(path, 'b.txt')));
  assert.equal(run(path, 'log', '-1', '--format=%P').split(' ').length, 2, '必須是 --no-ff 合併');

  // 真正的衝突在同一條退路上仍要被認出來，而且正式分支不得留在解到一半的狀態。
  const second = '284abcde-0000-4000-8000-000000000002';
  const conflicting = oldWorkspace.prepare({ projectPath: path, taskId: second, title: 'conflict', worktreesDir: join(root, 'wt') });
  writeFileSync(join(conflicting.git.workingDirectory, 'a.txt'), 'from task\n');
  oldWorkspace.commit({
    workingDirectory: conflicting.git.workingDirectory, workingBranch: conflicting.git.workingBranch,
    subject: 'taskflow(execute): rewrite a',
  });
  writeFileSync(join(path, 'a.txt'), 'from main\n');
  run(path, 'add', '.');
  run(path, '-c', 'user.email=seed@example.test', '-c', 'user.name=Seed', 'commit', '-m', 'main edits a');

  const blocked = oldWorkspace.merge({
    repositoryPath: path, baseBranch: 'main', workingBranch: conflicting.git.workingBranch,
    subject: 'taskflow(merge): rewrite a',
  });
  assert.equal(blocked.merged, false);
  assert.equal(blocked.reason, 'conflict');
  assert.ok(blocked.files.includes('a.txt'));
  assert.equal(readText(join(path, 'a.txt')), 'from main\n', '正式分支的內容不得被動到');
  assert.equal(run(path, 'status', '--porcelain'), '', '不得留在解到一半的 merge 狀態');
});
