import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGitRunner, createGitWorkspace, GitSafetyError, pushBaseBranch, remoteStatus} from '../server/git-workspace.js';

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// 一個真的 repo 加一個真的 bare remote。推送這件事不能用假的 git 驗：
// 要確認的正是「真的推上去了沒有」。
function repoWithRemote(t, { withRemote = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git'), work = join(dir, 'work');

  mkdirSync(origin); run(origin, 'init', '--bare', '--initial-branch=main');
  mkdirSync(work);
  run(work, 'init', '--initial-branch=main');
  run(work, 'config', 'user.email', 'test@localhost');
  run(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'README.md'), '# 專案\n');
  run(work, 'add', '.');
  run(work, 'commit', '-m', 'chore: init');
  if (withRemote) {
    run(work, 'remote', 'add', 'origin', origin);
    run(work, 'push', '-q', 'origin', 'main');
  }
  return { dir, origin, work, git: createGitRunner() };
}

const commit = (work, name) => {
  writeFileSync(join(work, `${name}.md`), `${name}\n`);
  run(work, 'add', '.');
  run(work, 'commit', '-m', `feat: ${name}`);
};
const originHead = origin => run(origin, 'rev-parse', 'main');

test('推送把本機的 commit 真的送上遠端，並回報推了幾個', t => {
  const f = repoWithRemote(t);
  commit(f.work, 'one');
  commit(f.work, 'two');
  const before = originHead(f.origin);

  const outcome = pushBaseBranch({ repositoryPath: f.work, baseBranch: 'main', git: f.git });

  assert.equal(outcome.pushed, true);
  assert.equal(outcome.count, 2);
  assert.notEqual(originHead(f.origin), before);
  assert.equal(originHead(f.origin), run(f.work, 'rev-parse', 'main'));
});

test('沒有東西要推時不推，也不假裝推了', t => {
  const f = repoWithRemote(t);
  const outcome = pushBaseBranch({ repositoryPath: f.work, baseBranch: 'main', git: f.git });
  assert.equal(outcome.pushed, false);
  assert.equal(outcome.reason, 'up_to_date');
});

test('落後遠端時一律拒絕：TaskFlow 不替你決定 merge 還是 rebase', t => {
  const f = repoWithRemote(t);
  // 另一個人先推了東西上去
  const other = join(f.dir, 'other');
  mkdirSync(other);
  run(other, 'clone', f.origin, other);
  run(other, 'config', 'user.email', 'other@localhost');
  run(other, 'config', 'user.name', 'Other');
  commit(other, 'theirs');
  run(other, 'push', '-q', 'origin', 'main');

  commit(f.work, 'mine');
  const before = originHead(f.origin);

  assert.throws(
    () => pushBaseBranch({ repositoryPath: f.work, baseBranch: 'main', git: f.git }),
    error => error instanceof GitSafetyError && error.reason === 'behind_remote' && /merge 還是 rebase/.test(error.message),
  );
  // 遠端原封不動
  assert.equal(originHead(f.origin), before);
});

test('工作樹不乾淨時不推', t => {
  const f = repoWithRemote(t);
  commit(f.work, 'one');
  writeFileSync(join(f.work, 'scratch.txt'), '還沒提交\n');

  assert.throws(
    () => pushBaseBranch({ repositoryPath: f.work, baseBranch: 'main', git: f.git }),
    error => error.reason === 'dirty_working_tree',
  );
});

test('不在正式分支上時不推', t => {
  const f = repoWithRemote(t);
  run(f.work, 'checkout', '-q', '-b', 'somewhere-else');
  commit(f.work, 'one');

  assert.throws(
    () => pushBaseBranch({ repositoryPath: f.work, baseBranch: 'main', git: f.git }),
    error => error.reason === 'base_branch_not_checked_out',
  );
});

test('沒有設定遠端時照實說，不丟難懂的 git 錯誤', t => {
  const f = repoWithRemote(t, { withRemote: false });
  commit(f.work, 'one');

  assert.throws(
    () => pushBaseBranch({ repositoryPath: f.work, baseBranch: 'main', git: f.git }),
    error => error.reason === 'no_remote' && /沒有設定名為 origin 的遠端/.test(error.message),
  );
  assert.equal(remoteStatus({ repositoryPath: f.work, baseBranch: 'main', git: f.git }).configured, false);
});

test('遠端狀態供畫面顯示「領先幾個 commit」', t => {
  const f = repoWithRemote(t);
  assert.deepEqual(
    (({ configured, ahead, behind }) => ({ configured, ahead, behind }))(remoteStatus({ repositoryPath: f.work, baseBranch: 'main', git: f.git })),
    { configured: true, ahead: 0, behind: 0 },
  );
  commit(f.work, 'one');
  const status = remoteStatus({ repositoryPath: f.work, baseBranch: 'main', git: f.git });
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  assert.equal(status.url, f.origin);
});

test('授權通道的形狀是鎖死的：強推與任何旗標都送不出去', t => {
  const f = repoWithRemote(t);
  commit(f.work, 'one');
  const blocked = [
    ['push', '--force', 'origin', 'main'],
    ['push', 'origin', 'main', '--force'],
    ['push', '--mirror', 'origin'],
    ['push', 'origin', '--delete', 'main'],
    ['push', 'origin', 'HEAD:main'],
    ['push', 'origin', 'main', 'other'],
    ['push', '--tags', 'origin', 'main'],
  ];
  for (const args of blocked) {
    assert.throws(
      () => f.git(f.work, args, { authorizedAs: 'push_base_branch' }),
      error => error instanceof GitSafetyError && error.reason === 'forbidden_command',
      `應該擋下：git ${args.join(' ')}`,
    );
  }
  // 沒有授權通道時，連最普通的 push 都送不出去（既有的 denylist）
  assert.throws(() => f.git(f.work, ['push', 'origin', 'main']), error => error.reason === 'forbidden_command');
});

test('createGitWorkspace 有把推送與遠端狀態接出來', t => {
  const f = repoWithRemote(t);
  const workspace = createGitWorkspace();
  commit(f.work, 'one');
  assert.equal(workspace.remoteStatus({ repositoryPath: f.work, baseBranch: 'main' }).ahead, 1);
  assert.equal(workspace.push({ repositoryPath: f.work, baseBranch: 'main' }).pushed, true);
  assert.equal(originHead(f.origin), run(f.work, 'rev-parse', 'main'));
});
