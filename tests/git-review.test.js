import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { taskGitReview, decideGitReview, rollbackTaskMerge, closeTask } from '../server/git-review.js';
import { legacyWorkspaceStatus, migrateLegacyWorkspace } from '../server/git-migration.js';
import { taskDisplayStatus } from '../server/task-status.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
// 合併後由 git checkout 產生的檔案，在 core.autocrlf=true 的 Windows 上會被改寫成 CRLF；
// 這裡檢查的是內容，不是換行字元。
const readText = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
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

// 行為調整說明：合併不再「順便」清理 worktree／分支。這裡原本斷言合併後預設會
// 立刻清乾淨，現在整條生命週期把「開發完成」（completed）與「任務正式結束」（closed）
// 拆開了：合併只證明成果進了正式分支，worktree／分支要留到使用者按下「關閉任務」
// （closeTask）才會消失。這個測試改成驗證新的分工，並沿用同一段流程往下測 closeTask。
test('核准並 Merge：--no-ff 合併後進入 ready_to_close，worktree 與分支留到 Close 才清理', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });

  assert.equal(merged.gitMerge.baseBranch, 'main');
  assert.equal(merged.gitMerge.by, f.owner.id);
  assert.equal(merged.publishApproval.artifactVersion, f.task.artifactVersion);
  assert.equal(readText(join(f.source, 'result.md')), 'delivered\n', '成果必須真的進到專案');
  assert.equal(run(f.source, 'log', '-1', '--format=%P').split(' ').length, 2);
  assert.match(run(f.source, 'log', '-1', '--format=%b'), /成果版本/);

  // 合併驗證通過後直接進入 ready_to_close，不再停在 completed，但也還不是 closed。
  assert.equal(merged.status, 'ready_to_close');
  assert.ok(merged.readyToCloseAt);
  assert.equal(merged.workspace, f.task.workspace, 'worktree 要留到 Close 才移除');
  assert.ok(existsSync(f.task.workspace));
  assert.ok(run(f.source, 'branch', '--list', f.task.git.workingBranch), '分支要留到 Close 才刪除');
  assert.ok(f.store.events(f.task.id).some(e => e.kind === 'git_merged'));

  const review = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(review.status, 'merged');
  assert.equal(review.cleanedUp, false);
  assert.equal(review.merged, true);
  assert.equal(review.merge.commit, merged.gitMerge.commit);
  assert.equal(review.commits.length, 1, 'worktree 還在，仍照原本方式讀 commit');

  assert.throws(() => decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion }), /已經合併過/);

  const closed = await closeTask(f.store, f.owner, f.task.id, {}, {});
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closedBy, f.owner.id);
  assert.ok(closed.closedAt);
  assert.equal(closed.workspace, null);
  assert.equal(closed.git.cleanedUp, true);
  assert.equal(closed.git.branchDeleted, true);
  assert.equal(existsSync(f.task.workspace), false);
  assert.equal(run(f.source, 'branch', '--list', f.task.git.workingBranch), '');
  assert.ok(f.store.events(f.task.id).some(e => e.kind === 'task_closed'));

  // 清理後的審核畫面仍然看得到合併結果與變更清單，不會因為 worktree 消失就壞掉或變成空的。
  const afterClose = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(afterClose.cleanedUp, true);
  assert.equal(afterClose.commits.length, 1, 'worktree 清理後改用 baseCommit..gitMerge.commit 讀，不應該變成空清單');
});

// cleanup 這個輸入參數過去會讓合併「順便」立刻清理；行為調整後合併本身不再清理，
// 這個參數不再有作用，這裡驗證即使明確傳 cleanup:false 也一樣（避免有人以為還能靠它做別的事）。
test('merge 的 cleanup 參數不再影響清理時機：一律留給 Close', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion, cleanup: false });

  assert.equal(merged.status, 'ready_to_close');
  assert.equal(merged.workspace, f.task.workspace);
  assert.ok(existsSync(f.task.workspace));
  assert.ok(run(f.source, 'branch', '--list', f.task.git.workingBranch));
});

test('completed 不能直接呼叫 close：必須先合併驗證通過', async t => {
  const f = await completedTask(t);
  await assert.rejects(closeTask(f.store, f.owner, f.task.id, {}, {}), /尚未合併至正式分支/);
  assert.equal(f.store.task(f.task.id).status, 'completed');

  const other = await completedTask(t);
  const cancelled = other.store.task(other.task.id);
  cancelled.status = 'cancelled';
  other.store.saveTask(cancelled);
  await assert.rejects(closeTask(other.store, other.owner, other.task.id, {}, {}), /還不能關閉/);
});

test('合併會產生衝突時擋下合併，task 維持 completed 並列出衝突檔案', async t => {
  const f = await completedTask(t, { file: 'README.md', content: '# 任務的版本\n' });
  writeFileSync(join(f.source, 'README.md'), '# 使用者的版本\n');
  run(f.source, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', 'user edit');

  const blocked = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  assert.equal(blocked.status, 'completed');
  assert.deepEqual(blocked.gitConflict.files, ['README.md']);

  const review = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(review.hasConflict, true);
  assert.equal(review.status, 'conflict');
});

test('main 在任務期間前進：Git Delivery 即時反映，不沿用舊的 mergeability', async t => {
  const f = await completedTask(t);
  writeFileSync(join(f.source, 'unrelated.md'), '不影響合併的其他變更\n');
  run(f.source, 'add', 'unrelated.md');
  run(f.source, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-m', 'main 自己往前走');

  const review = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(review.mainAdvanced, true);
  assert.equal(review.mergeable, true, 'main 前進但沒有衝突時仍然可以合併');

  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  assert.equal(merged.status, 'ready_to_close');
});

// 行為調整說明：重新整理 Git Delivery 狀態（GET /git/review）本身就是 Server Domain 層
// reconciliation 唯一的觸發點——不能只在回傳物件裡假裝任務已經整合，資料庫的 task.status
// 必須跟畫面看到的事實一致（前一輪修正被使用者要求補上的架構原則）。因此這裡改成驗證：
// 呼叫一次 taskGitReview() 之後，store 裡的 task.status 已經被持久化推進為 ready_to_close，
// 不是只有這次呼叫回傳的 review 物件看起來像而已；重複呼叫也不會再次觸發或報錯。
test('手動在外部完成 git merge：重新讀取會偵測到並持久化為 ready_to_close，close 不需要再合併一次', async t => {
  const f = await completedTask(t);
  // 使用者自己在終端機做完 merge，TaskFlow 完全不知情（沒有 t.gitMerge）。
  run(f.source, 'merge', '--no-ff', '--no-edit', f.task.git.workingBranch);
  assert.equal(f.store.task(f.task.id).status, 'completed');
  assert.equal(f.store.task(f.task.id).gitMerge, undefined);

  const review = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(review.externallyMerged, true);
  assert.equal(review.merged, true, '偵測到之後應立即持久化，回傳物件要反映最新狀態');
  assert.equal(review.status, 'merged');

  const persisted = f.store.task(f.task.id);
  assert.equal(persisted.status, 'ready_to_close', '不能只有 review 物件看起來已整合，task.status 也必須被寫回');
  assert.ok(persisted.readyToCloseAt);
  assert.equal(persisted.gitMerge.external, true);
  const firstMergeAt = persisted.gitMerge.at;

  // 對同一任務重複呼叫：已經是 ready_to_close，純讀取，不應該再次觸發 reconcile 或改變既有 metadata。
  const second = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(second.merged, true);
  assert.equal(f.store.task(f.task.id).gitMerge.at, firstMergeAt, '重複讀取不應改動已經成立的 merge 時間');

  assert.equal(taskDisplayStatus(f.store.task(f.task.id)), 'ready_to_close', '對應 Task Queue 應顯示「等待關閉」，不是「等待整合」');

  const closed = await closeTask(f.store, f.owner, f.task.id, {}, {});
  assert.equal(closed.status, 'closed');
  assert.equal(closed.gitMerge.external, true, '即使是外部合併，也要留下 merge metadata');
});

test('worktree 有未提交變更時 close 會被擋下，不會強制刪除', async t => {
  const f = await completedTask(t);
  decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  writeFileSync(join(f.task.workspace, 'unstaged.md'), '還沒 commit 的東西\n');

  const result = await closeTask(f.store, f.owner, f.task.id, {}, {});
  assert.match(result.cleanupWarning, /工作副本仍有未提交變更/);
  assert.equal(f.store.task(f.task.id).status, 'ready_to_close', '清不掉就不能變成 closed');
  assert.ok(existsSync(f.task.workspace), '不得強制刪除');
});

test('已合併但尚未清理的任務維持 ready_to_close，close 時才真正清理', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  assert.equal(merged.status, 'ready_to_close');
  assert.ok(existsSync(f.task.workspace));

  const closed = await closeTask(f.store, f.owner, f.task.id, {}, {});
  assert.equal(closed.status, 'closed');
  assert.equal(existsSync(f.task.workspace), false);
});

test('closed 任務保留完整歷史：原始需求、commits、merge metadata 仍可查詢', async t => {
  const f = await completedTask(t);
  decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  const closed = await closeTask(f.store, f.owner, f.task.id, {}, {});

  assert.equal(closed.title, 'Document task');
  assert.equal(closed.description, 'Create a document and validate it.');
  assert.ok(closed.plan);
  assert.ok(closed.gitMerge);
  const review = taskGitReview(f.store, f.owner, f.task.id);
  assert.equal(review.commits.length, 1);
});

// 相容舊資料（計畫書第三十一章）：這次改造上線之前就合併過的任務，status 從沒被
// 推進過，一直停在 completed，而且照舊行為早就在合併當下清掉了 worktree 與分支。
test('相容舊任務：合併發生在這次改造之前，close 時重新驗證後直接視為 ready_to_close', async t => {
  const f = await completedTask(t);
  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion });
  // 模擬舊行為：合併後 status 沒被推進，且立刻清理過 worktree 與分支。
  const legacy = f.store.task(f.task.id);
  legacy.status = 'completed';
  legacy.readyToCloseAt = null;
  f.store.saveTask(legacy);
  run(f.source, 'worktree', 'prune');
  assert.equal(f.store.task(f.task.id).status, 'completed');
  assert.ok(f.store.task(f.task.id).gitMerge, '舊資料仍然留著 merge metadata');

  const closed = await closeTask(f.store, f.owner, f.task.id, {}, {});
  assert.equal(closed.status, 'closed');
  assert.equal(closed.gitMerge.commit, merged.gitMerge.commit, '沿用舊的 merge metadata，不會重新造一份');
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

test('情境 4／使用者已自行解決衝突並手動完成 merge commit：重新核對後視為合併完成，不再丟 409', async t => {
  const f = await completedTask(t, { file: 'README.md', content: '# 任務的版本\n' });
  writeFileSync(join(f.source, 'README.md'), '# 使用者的版本\n');
  run(f.source, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', 'user edit');

  // 使用者不透過 TaskFlow，自己在專案目錄手動解決衝突並完成 merge commit。
  const attempt = (() => { try { run(f.source, 'merge', '--no-ff', '--no-commit', f.task.git.workingBranch); return true; } catch { return false; } })();
  assert.equal(attempt, false, '這一步本來就預期會產生衝突');
  writeFileSync(join(f.source, 'README.md'), '# 手動解決後的版本\n');
  run(f.source, 'add', 'README.md');
  run(f.source, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '--no-edit');
  const manualMergeCommit = run(f.source, 'rev-parse', 'HEAD');
  assert.equal(existsSync(join(f.source, '.git', 'MERGE_HEAD')), false, '使用者已經自行完成 commit，不應再處於進行中的 merge');

  const merged = decideGitReview(f.store, f.owner, f.task.id, { decision: 'merge', artifactVersion: f.task.artifactVersion, cleanup: false });

  assert.equal(merged.gitConflict, null);
  assert.ok(merged.gitMerge, '必須重新核對 Git 狀態後視為合併完成，而不是丟 409 擋住使用者');
  assert.equal(merged.gitMerge.reconciled, true);
  assert.equal(merged.gitMerge.commit, manualMergeCommit);
  assert.equal(merged.gitMerge.baseBranch, 'main');
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 手動解決後的版本\n', '不得覆蓋使用者手動解決的內容');
  assert.equal(run(f.source, 'rev-parse', 'HEAD'), manualMergeCommit, '不得產生額外的 commit');
  assert.ok(f2events(f.store, f.task.id).some(m => m.includes('重新核對') && m.includes('視為合併完成')));
  assert.equal(taskGitReview(f.store, f.owner, f.task.id).status, 'merged');
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
