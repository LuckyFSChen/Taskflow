import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { taskGitReview, decideGitReview, rollbackTaskMerge } from '../server/git-review.js';
import { legacyWorkspaceStatus, migrateLegacyWorkspace } from '../server/git-migration.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const f2events = (store, tid) => store.events(tid).map(e => e.message);

// 跑完一個真實的任務流程（規劃 → 核准 → 執行 → 獨立驗證），停在「已完成、等待人工審核」。
async function completedTask(t, { file = 'result.md', content = 'delivered\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-review-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), '# 原始專案\n');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  let calls = 0;
  const runner = createRunner(store, {
    dataDir: join(dir, 'runs'), recover: false,
    adapter: async o => { calls++; if (o.readOnly) return { result: plan }; if (calls === 2) writeFileSync(join(o.cwd, file), content); return { result: good }; },
  });
  t.after(() => runner.stop());
  store.setSetting('runnerEnabled', true);

  const task = createTask(store, owner, { title: 'Document task', description: 'Create a document and validate it.', projectId, type: 'research', priority: 1, planner: 'claude', executor: 'codex', reviewer: 'claude' });
  await runner.tick();
  approveTask(store, owner, task.id, 1);
  await runner.tick();
  await runner.tick();
  assert.equal(store.task(task.id).status, 'completed');
  return { dir, store, owner, source, projectId, runner, task: store.task(task.id) };
}

test('審核資訊：分支、commit、各階段驗收結果與正式分支狀態', async t => {
  const f = await completedTask(t);
  const review = taskGitReview(f.store, f.owner, f.task.id);

  assert.equal(review.available, true);
  assert.equal(review.status, 'ready');
  assert.equal(review.baseBranch, 'main');
  assert.equal(review.workingBranch, f.task.git.workingBranch);
  assert.equal(review.commits.length, 1);
  assert.match(review.commits[0].subject, /^taskflow\(execute\)/);
  assert.equal(review.artifactCommit, f.task.git.headCommit);
  assert.deepEqual(review.validation.map(v => v.phase), ['plan', 'execute', 'review']);
  assert.deepEqual(review.validation.map(v => v.passed), [null, true, true]);
  assert.deepEqual(review.repository, { branch: 'main', clean: true, onBaseBranch: true, dirty: [] });
  assert.equal(review.merge, null);
});

test('核准並 Merge：--no-ff 合併後預設清理分支與工作目錄', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });

  assert.equal(merged.gitMerge.baseBranch, 'main');
  assert.equal(merged.gitMerge.by, f.owner.id);
  assert.equal(merged.publishApproval.artifactVersion, f.task.artifactVersion);
  assert.equal(readFileSync(join(f.source, 'result.md'), 'utf8'), 'delivered\n', '成果必須真的進到專案');
  assert.equal(run(f.source, 'log', '-1', '--format=%P').split(' ').length, 2);
  assert.match(run(f.source, 'log', '-1', '--format=%b'), /成果版本/);

  // 預設清理：worktree 移除、分支刪除，任務不再指向已不存在的目錄。
  assert.equal(merged.workspace, null);
  assert.equal(merged.git.cleanedUp, true);
  assert.equal(merged.git.branchDeleted, true);
  assert.equal(existsSync(f.task.workspace), false);
  assert.equal(run(f.source, 'branch', '--list', f.task.git.workingBranch), '');
  assert.ok(f.store.events(f.task.id).some(e => e.kind === 'git_merged'));

  // 清理後的審核畫面仍然看得到合併結果，不會壞掉。
  const review = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(review.status, 'merged');
  assert.equal(review.cleanedUp, true);
  assert.equal(review.merge.commit, merged.gitMerge.commit);

  assert.throws(() => decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion }), /已經合併過/);
});

test('cleanup:false 時保留分支與工作目錄', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion, cleanup: false });

  assert.equal(merged.workspace, f.task.workspace);
  assert.ok(existsSync(f.task.workspace));
  assert.ok(run(f.source, 'branch', '--list', f.task.git.workingBranch));
});

test('只有真的通過驗證、且成果版本相符才能合併', async t => {
  const f = await completedTask(t);
  assert.throws(() => decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: 'wrong-version' }), /成果版本不符/);

  const manual = f.store.task(f.task.id);
  manual.manualCompletion = { by: f.owner.id, at: new Date().toISOString(), previousStatus: 'running' };
  f.store.saveTask(manual);
  assert.throws(() => decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion }), /手動標記完成不代表驗收通過/);
  assert.equal(run(f.source, 'rev-list', '--count', 'HEAD'), '1', '被擋下時正式分支不得有任何新 commit');
});

test('合併衝突：停在待處理，不動正式分支，也不自行解衝突', async t => {
  const f = await completedTask(t, { file: 'README.md', content: '# 任務的版本\n' });
  writeFileSync(join(f.source, 'README.md'), '# 使用者的版本\n');
  run(f.source, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', 'user edit');
  const head = run(f.source, 'rev-parse', 'HEAD');

  const blocked = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });

  assert.equal(blocked.gitMerge, undefined);
  assert.deepEqual(blocked.gitConflict.files, ['README.md']);
  assert.match(blocked.gitConflict.hint, /不會自行決定 ours／theirs/);
  assert.equal(run(f.source, 'rev-parse', 'HEAD'), head);
  assert.equal(run(f.source, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 使用者的版本\n');
  assert.equal(taskGitReview(f.store, f.owner, f.task.id).status, 'conflict');
  assert.ok(f.store.events(f.task.id).some(e => e.kind === 'git_conflict'));

  // 衝突後仍可改走「要求修改」，而且分支不變。
  const revised = decideGitReview(f.store, f.owner, f.task.id, { decision: 'changes', answer: '請以使用者版本為基礎重做' });
  assert.equal(revised.gitConflict, null);
  assert.equal(revised.git.workingBranch, f.task.git.workingBranch, '要求修改不得換一條新分支');
  assert.equal(revised.planVersion, 2);
  assert.equal(revised.status, 'planning');
  assert.ok(existsSync(f.task.workspace), '工作目錄必須保留給後續修改使用');
});

test('拒絕：預設保留分支，明確選擇才刪除', async t => {
  const f = await completedTask(t);
  const kept = decideGitReview(f.store, f.owner, f.task.id, { decision: 'reject' });

  assert.equal(kept.status, 'cancelled');
  assert.equal(kept.gitReview.keepBranch, true);
  assert.ok(existsSync(f.task.workspace), '預設不得讓開發成果消失');
  assert.ok(run(f.source, 'branch', '--list', f.task.git.workingBranch));
  assert.equal(run(f.source, 'rev-list', '--count', 'HEAD'), '1', '拒絕不得合併任何東西');

  const removed = decideGitReview(f.store, f.owner, f.task.id, { decision: 'reject', keepBranch: false });
  assert.equal(removed.workspace, null);
  assert.equal(existsSync(f.task.workspace), false);
  assert.equal(run(f.source, 'branch', '--list', f.task.git.workingBranch), '', '未合併的分支只有在明確要求下才會被刪除');
});

test('Rollback：撤銷已合併的成果，歷史保留，成果核准同時失效', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  const mergeCommit = merged.gitMerge.commit;

  assert.throws(() => rollbackTaskMerge(f.store, f.owner, f.task.id, { mergeCommit: 'deadbeef' }), /合併版本不符/);

  const rolled = rollbackTaskMerge(f.store, f.owner, f.task.id, { mergeCommit });
  assert.equal(rolled.gitRollback.mergeCommit, mergeCommit);
  assert.equal(rolled.publishApproval, null, '撤銷後成果核准必須失效');
  assert.equal(existsSync(join(f.source, 'result.md')), false);
  assert.equal(run(f.source, 'status', '--porcelain'), '');
  assert.ok(run(f.source, 'cat-file', '-t', mergeCommit), '原本的 merge commit 仍留在歷史中');

  assert.throws(() => rollbackTaskMerge(f.store, f.owner, f.task.id, { mergeCommit }), /已經撤銷過/);
});

test('非 Git 模式的任務沒有可審核的分支', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-review-legacy-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), pid = id(), tid = id();
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid, 'demo', 'Demo', dir);
  store.saveTask({ id: tid, ownerId: owner.id, projectId: pid, status: 'completed', priority: 1, position: 0, planVersion: 1, workspace: join(dir, 'workspaces', tid, 'v1') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.deepEqual(taskGitReview(store, owner, tid), { available: false, reason: 'legacy_workspace', validation: [], merge: null, conflict: null });
  assert.throws(() => decideGitReview(store, owner, tid, { decision: 'merge', artifactVersion: 'x' }), /不是以 Git 模式執行/);
});

test('Legacy migration：舊工作副本轉進任務分支，原資料夾保留不刪', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-migrate-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), pid = id(), tid = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), '# 原始專案\n');
  writeFileSync(join(source, 'legacy-only.txt'), 'will be deleted by AI\n');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid, 'demo', 'Demo', source);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  // 舊模式的工作副本：專案的複本 + AI 的修改（新增、修改、刪除）+ TaskFlow 自己的暫存檔。
  const legacy = join(dir, 'runs', 'workspaces', tid, 'v1');
  mkdirSync(join(legacy, '.taskflow'), { recursive: true });
  writeFileSync(join(legacy, 'README.md'), '# 被 AI 改過\n');
  writeFileSync(join(legacy, 'new-file.md'), 'AI 新增\n');
  writeFileSync(join(legacy, '.taskflow', 'handoff.json'), '{}');
  store.saveTask({ id: tid, ownerId: owner.id, projectId: pid, status: 'waiting_input', priority: 1, position: 0, planVersion: 1, round: 0, title: 'Legacy task', workspace: legacy });

  assert.deepEqual(legacyWorkspaceStatus(store, owner, tid), { legacy: true, migratable: true, workspaceExists: true, migratedFrom: null });

  const migrated = migrateLegacyWorkspace(store, owner, tid, { dataDir: join(dir, 'runs') });

  assert.equal(migrated.git.mode, 'worktree');
  assert.equal(migrated.git.migratedFromLegacy, true);
  assert.equal(migrated.legacyWorkspace, legacy);
  assert.equal(migrated.workspace, join(dir, 'runs', 'worktrees', tid));
  assert.equal(readFileSync(join(migrated.workspace, 'README.md'), 'utf8'), '# 被 AI 改過\n');
  assert.equal(readFileSync(join(migrated.workspace, 'new-file.md'), 'utf8'), 'AI 新增\n');
  assert.equal(existsSync(join(migrated.workspace, '.taskflow')), false, 'TaskFlow 自己的暫存檔不搬進版本控制');
  // 分不出「AI 刪掉的」與「快照之後才加入的」，就一律不刪，只把清單交給使用者。
  assert.ok(existsSync(join(migrated.workspace, 'legacy-only.txt')), '判斷不了的檔案不得自行刪除');
  assert.ok(f2events(store, tid).some(m => m.includes('legacy-only.txt') && m.includes('不會自行刪除')));

  const files = run(migrated.workspace, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['README.md', 'new-file.md']);
  assert.match(run(migrated.workspace, 'log', '-1', '--format=%s'), /taskflow\(migrate\)/);
  assert.equal(run(source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '轉換不得動到專案目錄');

  assert.ok(existsSync(join(legacy, 'new-file.md')), '舊資料夾必須原封不動保留');
  assert.throws(() => migrateLegacyWorkspace(store, owner, tid, { dataDir: join(dir, 'runs') }), /已經在 Git 模式/);
});
