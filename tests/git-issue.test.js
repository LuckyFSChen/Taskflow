// Git 守門被擋下之後的人工處理閉環。
//
// 這個檔案的每一個測試都對應一個曾經真實發生的失效：任務被未提交修改擋住之後，
// UI 沒有任何可按的動作、recheck 只是清旗標所以下一輪又被同一組修改擋住、
// 已取消的任務還顯示「待我處理」。因此這裡檢查的不只是狀態欄位，也包含
// 「使用者的檔案有沒有被動到」與「同一組修改會不會被重複詢問」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id, hash } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { createApp } from '../server/app.js';
import { decideGitIssue, gitIssueRequest, gitIssuePending, closePendingRequestsOnCancel } from '../server/git-issue.js';
import { manualActionRequest } from '../server/manual-action.js';
import { changeTaskStatus, taskDisplayStatus } from '../server/task-status.js';
import { dirtyFingerprint, inspectRepository, GitSafetyError } from '../server/git-workspace.js';
import { threadPresentation } from '../server/thread-presentation.js';
import { attentionCategory } from '../src/attention.js';
import { pendingActions } from '../src/task-detail-view.js';
import { gitIssueView, parseDirtyEntry } from '../src/git-issue-view.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commitAll = (cwd, message) => run(cwd, '-c', 'user.email=dev@example.test', '-c', 'user.name=Dev', 'commit', '-am', message);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-gitissue-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Lucky', 'lucky', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), 'Original');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = {
    dir, store, owner, source, projectId, calls: 0,
    create: (title = 'Document task') => createTask(store, owner, { title, description: 'Create a document and validate it.', projectId, type: 'research', priority: 1, planner: 'claude', executor: 'codex', reviewer: 'claude' }),
    task: tid => store.task(tid),
    events: tid => store.events(tid).map(e => `${e.kind}:${e.message}`),
  };
  f.runner = () => {
    const r = createRunner(store, { adapter: async o => { f.calls++; return { result: o.readOnly ? plan : good }; }, dataDir: join(dir, 'runs'), recover: false });
    t.after(() => r.stop());
    store.setSetting('runnerEnabled', true);
    return r;
  };
  // 讓專案先成為一個乾淨的 Git repository（這個任務會停在 awaiting_approval，之後不再派工）。
  f.warmup = async runner => { const warm = f.create('Warmup'); await runner.tick(); assert.equal(store.task(warm.id).status, 'awaiting_approval'); return warm; };
  // 使用者自己留下未提交修改。
  f.dirty = () => { writeFileSync(join(f.source, 'README.md'), '# 使用者自己的修改'); writeFileSync(join(f.source, 'scratch.txt'), 'wip'); };
  return f;
}

// --- Case 1：dirty working tree → 待使用者處理，不是失敗，而且畫面上一定有可按的動作 -----
test('Case 1：未提交修改讓任務進入待確認，UI 有三個可操作選項，且不呼叫任何 Agent', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create(), before = f.calls;
  await runner.tick();

  const blocked = f.task(task.id);
  assert.equal(f.calls, before, '守門觸發時不得呼叫任何 Agent');
  assert.equal(blocked.status, 'waiting_input');
  assert.notEqual(blocked.status, 'failed', 'Git dirty 不是執行失敗');
  assert.equal(blocked.gitIssue.reason, 'dirty_working_tree');
  assert.equal(blocked.gitIssue.status, 'pending');
  assert.equal(blocked.gitIssue.fileCount, 2);
  assert.ok(blocked.gitIssue.fingerprint, '必須留下指紋，否則無法判斷是否為同一組修改');
  assert.equal(blocked.gitIssue.resumeStatus, 'planning', '必須記住被擋下來之前的狀態');
  assert.equal(blocked.resumeStatus, 'planning');
  assert.equal(blocked.workspace, null, '未通過守門前不得建立工作目錄');
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 使用者自己的修改', '不得清除使用者的修改');
  assert.equal(run(f.source, 'stash', 'list'), '', '不得 stash 使用者的修改');

  // 被擋下的工作階段不是「失敗」，而是「等你確認」。
  const thread = f.store.threads(task.id).at(-1);
  assert.equal(thread.stoppedReason, 'git_blocked');
  assert.notEqual(thread.status, 'failed');
  assert.equal(threadPresentation(thread).statusLabel, '等待你確認 Git 狀態');

  // 後端送給前端的請求與顯示狀態。
  const request = gitIssueRequest(f.store, blocked);
  assert.equal(request.approvable, true);
  assert.equal(request.title, '需要確認 Git 修改');
  assert.equal(taskDisplayStatus(blocked), 'waiting_git_confirmation');

  // 前端：待我處理有專屬分類，詳情頁列出這件事，而且有三個按鈕。
  const decorated = { ...blocked, gitRequest: request, displayStatus: taskDisplayStatus(blocked) };
  const category = attentionCategory(decorated);
  assert.equal(category.type, 'git_issue');
  assert.equal(category.title, '需要確認 Git 修改');
  assert.match(category.reason, /2 個檔案尚未提交/);
  assert.ok(pendingActions(decorated).some(a => a.id === 'git_issue'));
  const view = gitIssueView(decorated);
  assert.deepEqual(view.actions.map(a => a.action), ['approve', 'recheck', 'cancel']);
  assert.deepEqual(view.guarantees, ['不會刪除這些修改', '不會執行 git reset', '不會執行 git clean', '不會執行 git stash', '不會覆蓋這些檔案']);
  assert.deepEqual(view.files.map(x => x.label).sort(), ['已修改', '未追蹤（新檔案）']);
  assert.ok(f.events(task.id).some(e => /^git_blocked:Git 工作目錄存在 2 個未提交修改，等待使用者確認/.test(e)));
});

// --- Case 2 + Case 9：確認保留修改後可以繼續，同一組修改不再被重複詢問 --------------------
test('Case 2／9：保留修改並繼續後任務恢復原狀態，相同指紋不再阻塞，也不刪除任何檔案', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();

  const blocked = f.task(task.id), request = gitIssueRequest(f.store, blocked);
  const approved = decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'approve' });
  assert.equal(approved.status, 'planning', '必須回到被擋下來之前的狀態');
  assert.equal(approved.resumeStatus, null);
  assert.equal(approved.gitIssue.status, 'approved');
  assert.equal(approved.gitDirtyApproval.fingerprint, blocked.gitIssue.fingerprint);
  assert.equal(approved.gitDirtyApproval.fileCount, 2);
  assert.equal(gitIssuePending(approved), false);
  assert.equal(gitIssueRequest(f.store, approved), null, '確認後不應再顯示待處理請求');
  assert.ok(f.events(task.id).some(e => /^git_dirty_approved:Lucky 已確認目前 Git working tree 的 2 項未提交修改/.test(e)));

  // 確認後真的可以繼續；使用者的修改一個字都沒被動到。
  const before = f.calls;
  await runner.tick();
  const planned = f.task(task.id);
  assert.equal(f.calls, before + 1, '確認後必須真的開始工作');
  assert.equal(planned.git.mode, 'worktree');
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 使用者自己的修改');
  assert.ok(existsSync(join(f.source, 'scratch.txt')));
  assert.equal(run(f.source, 'stash', 'list'), '');
  assert.equal(run(f.source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '專案目錄不得被切換分支');
  assert.ok(f.events(task.id).some(e => /^git_dirty_approved:已依你的確認保留專案目錄中的 2 項未提交修改/.test(e)));

  // Case 9：之後每一輪都不得再用同一組修改阻塞任務。
  approveTask(f.store, f.owner, task.id, 1);
  await runner.tick();
  await runner.tick();
  const later = f.task(task.id);
  assert.equal(gitIssuePending(later), false, '同一組已確認的修改不得再次阻塞');
  assert.equal(later.gitIssue.status, 'approved');
});

// --- Case 3 + Case 10：確認之後又有新的修改 → 新指紋 → 再問一次 --------------------------
test('Case 3／10：確認後又新增未提交檔案會產生新指紋並重新要求確認', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();

  const first = f.task(task.id);
  decideGitIssue(f.store, f.owner, task.id, { issueId: gitIssueRequest(f.store, first).requestId, action: 'approve' });
  const approvedFingerprint = f.task(task.id).gitDirtyApproval.fingerprint;

  // 在任務真正開始前，使用者又多放了一個未追蹤檔案。
  writeFileSync(join(f.source, 'another.txt'), 'new work');
  await runner.tick();

  const again = f.task(task.id);
  assert.equal(again.status, 'waiting_input');
  assert.equal(again.gitIssue.status, 'pending');
  assert.equal(again.gitIssue.fileCount, 3);
  assert.notEqual(again.gitIssue.fingerprint, approvedFingerprint, 'untracked 檔案也必須改變指紋');
  assert.equal(again.gitDirtyApproval.fingerprint, approvedFingerprint, '舊的確認紀錄保留原樣，不自動放行新的修改');
  // 同一時間只會有一筆待確認請求：已處理完的那一筆進入歷程，不會與新的並存。
  assert.equal(again.gitIssueHistory.length, 1);
  assert.equal(again.gitIssueHistory[0].decision, 'approve');
  assert.equal(again.gitIssueHistory[0].approvedFingerprint, approvedFingerprint);

  // 重新確認新的那一組修改之後才會繼續。
  const before = f.calls;
  decideGitIssue(f.store, f.owner, task.id, { issueId: gitIssueRequest(f.store, f.task(task.id)).requestId, action: 'approve' });
  assert.equal(f.task(task.id).gitDirtyApproval.fileCount, 3);
  await runner.tick();
  assert.equal(f.calls, before + 1);
  assert.equal(f.task(task.id).git.mode, 'worktree');
  assert.ok(existsSync(join(f.source, 'another.txt')), '使用者新增的檔案必須still在原處');
});

// --- Case 4：使用者自己 commit 之後「重新檢查」就解除 -------------------------------------
test('Case 4：使用者自行 commit 後重新檢查，blocker 關閉並恢復原本狀態', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();
  assert.equal(f.task(task.id).status, 'waiting_input');

  // 先按一次「重新檢查」但還沒處理：只更新清單，維持等待，不建立第二個 blocker。
  const stale = gitIssueRequest(f.store, f.task(task.id));
  const still = decideGitIssue(f.store, f.owner, task.id, { issueId: stale.requestId, action: 'recheck' });
  assert.equal(still.status, 'waiting_input');
  assert.equal(still.gitIssue.status, 'pending');
  assert.equal(still.gitIssue.id, stale.id);
  assert.equal(still.gitIssue.fileCount, 2);
  assert.ok(f.events(task.id).some(e => /^git_rechecked:Lucky 要求重新檢查：Git working tree 仍有 2 個未提交修改/.test(e)));

  // 使用者自己處理掉（commit 追蹤中的修改、刪掉自己的暫存檔）。
  run(f.source, 'add', 'scratch.txt');
  commitAll(f.source, 'user work');
  assert.equal(run(f.source, 'status', '--porcelain'), '');

  const cleaned = decideGitIssue(f.store, f.owner, task.id, { issueId: gitIssueRequest(f.store, f.task(task.id)).requestId, action: 'recheck' });
  assert.equal(cleaned.status, 'planning');
  assert.equal(cleaned.gitIssue.status, 'resolved');
  assert.equal(cleaned.gitDirtyApproval, null, '乾淨之後不需要保留任何 dirty 核准');
  assert.equal(gitIssueRequest(f.store, cleaned), null);
  assert.ok(f.events(task.id).some(e => /^git_recheck_clean:Git working tree 已乾淨，任務恢復需求規劃/.test(e)));

  const before = f.calls;
  await runner.tick();
  assert.equal(f.calls, before + 1);
});

// --- Case 5：取消任務 ---------------------------------------------------------------------
test('Case 5：取消任務後 blocker 關閉，不再顯示需要處理', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();

  const request = gitIssueRequest(f.store, f.task(task.id));
  const cancelled = decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'cancel' }, { runner });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.gitIssue.status, 'cancelled');
  assert.equal(gitIssuePending(cancelled), false);
  assert.equal(gitIssueRequest(f.store, cancelled), null);
  assert.equal(taskDisplayStatus(cancelled), 'cancelled');
  assert.equal(attentionCategory({ ...cancelled, gitRequest: null, displayStatus: 'cancelled' }), null);
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 使用者自己的修改', '取消也不得動到使用者的修改');

  // 取消後不得再派工。
  const before = f.calls;
  await runner.tick();
  assert.equal(f.calls, before);
});

test('從任務狀態選單取消，也會關閉 Git 與本機操作的待處理項目', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();

  const withManual = f.task(task.id);
  withManual.userActionRequired = { required: true, status: 'pending', reason: '需要你在本機執行指令', commands: ['npm i'], at: new Date().toISOString() };
  f.store.saveTask(withManual);
  assert.ok(manualActionRequest(f.store, withManual), '未結束的任務才會送出本機操作請求');

  const cancelled = changeTaskStatus(f.store, { stopTask() {} }, f.owner, task.id, { status: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.gitIssue.status, 'cancelled');
  assert.equal(cancelled.userActionRequired.status, 'cancelled');
  assert.equal(taskDisplayStatus(cancelled), 'cancelled');
  assert.equal(manualActionRequest(f.store, cancelled), null);
  assert.equal(gitIssueRequest(f.store, cancelled), null);
  assert.ok(f.events(task.id).some(e => /^requests_closed:.*Git 修改待確認/.test(e)));
});

// --- Case 6／7：顯示狀態的優先序 ---------------------------------------------------------
test('Case 6／7：cancelled 永遠贏過殘留的 pending，正常任務才顯示待處理', () => {
  const legacy = { status: 'cancelled', gitIssue: { id: 'g1', reason: 'dirty_working_tree' }, userActionRequired: { required: true, status: 'pending' } };
  assert.equal(taskDisplayStatus(legacy), 'cancelled', '舊資料沒有 status 欄位時也不得顯示待處理');
  assert.equal(gitIssuePending(legacy), false);
  assert.equal(taskDisplayStatus({ status: 'completed', userActionRequired: { status: 'pending' } }), 'completed');

  const gitBlocked = { status: 'waiting_input', gitIssue: { id: 'g1', reason: 'dirty_working_tree', status: 'pending' } };
  assert.equal(taskDisplayStatus(gitBlocked), 'waiting_git_confirmation');
  assert.equal(taskDisplayStatus({ status: 'waiting_input', userActionRequired: { status: 'pending' } }), 'waiting_user_action');
  assert.equal(taskDisplayStatus({ status: 'planning' }), 'planning');
  assert.equal(taskDisplayStatus({ status: 'failed' }), 'failed');

  // 舊資料（沒有 status 欄位的 gitIssue）在未結束的任務上仍視為待處理。
  assert.equal(gitIssuePending({ status: 'waiting_input', gitIssue: { id: 'g1', reason: 'dirty_working_tree' } }), true);

  // 已結束的任務不論殘留哪一種旗標，都不得出現在「待我處理」或詳情頁的待處理清單。
  for (const status of ['cancelled', 'completed']) {
    for (const leftover of [{ gitRequest: { reason: 'dirty_working_tree', files: [], fileCount: 0 } }, { manualAction: { commands: [] } }, { outputIssue: { id: 'o1' } }, { environmentIssue: { id: 'e1' } }]) {
      const ended = { id: 't1', status, updated: '2026-01-01T00:00:00.000Z', questions: [], ...leftover };
      assert.equal(attentionCategory(ended), null, `${status} + ${Object.keys(leftover)[0]} 不得出現在待我處理`);
      assert.deepEqual(pendingActions(ended), [], `${status} + ${Object.keys(leftover)[0]} 不得列為待處理事項`);
    }
  }
  const closed = { gitIssue: { id: 'g1', status: 'pending' }, userActionRequired: { status: 'pending' } };
  assert.deepEqual(closePendingRequestsOnCancel(closed, { id: 'u1' }), ['git_issue', 'user_action']);
  assert.equal(closed.gitIssue.status, 'cancelled');
  assert.equal(closed.userActionRequired.status, 'cancelled');
});

// --- Case 8：git 指令失敗不可以被當成「工作目錄乾淨」 -------------------------------------
test('Case 8：git status 失敗時如實回報檢查錯誤，不得推論為乾淨或 dirty', async t => {
  const f = fixture(t);
  const failingGit = (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, stdout: `${f.source}\n`, stderr: '' };
    if (args[0] === 'status') return { ok: false, stdout: '', stderr: 'fatal: detected dubious ownership' };
    return { ok: true, stdout: '', stderr: '' };
  };
  assert.throws(() => inspectRepository(f.source, { git: failingGit }), e => e.code === 'GIT_SAFETY' && e.reason === 'git_status_failed' && /不會假設工作目錄是乾淨的/.test(e.message));

  // 重新檢查時 git 壞掉：照實回報錯誤，blocker 保持 pending，不會偷偷解除。
  const runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();
  const request = gitIssueRequest(f.store, f.task(task.id));
  const brokenWorkspace = { inspect: () => { throw new GitSafetyError('git_status_failed', '無法讀取專案的 Git 狀態'); } };
  assert.throws(
    () => decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'recheck' }, { gitWorkspace: brokenWorkspace }),
    e => e.status === 409 && /無法重新檢查 Git 狀態/.test(e.message),
  );
  const unchanged = f.task(task.id);
  assert.equal(unchanged.status, 'waiting_input');
  assert.equal(unchanged.gitIssue.status, 'pending');
  assert.ok(f.events(task.id).some(e => /^git_recheck_failed:/.test(e)));
});

// --- 指紋本身的性質（Case 10 的單元層） --------------------------------------------------
test('指紋涵蓋 untracked、與順序無關，且不會被前 30 筆截斷', () => {
  const base = ['M README.md', '?? scratch.txt'];
  assert.equal(dirtyFingerprint(base), dirtyFingerprint([...base].reverse()), '順序不同不代表有新修改');
  assert.notEqual(dirtyFingerprint(base), dirtyFingerprint([...base, '?? another.txt']), 'untracked 檔案必須影響指紋');
  assert.notEqual(dirtyFingerprint(base), dirtyFingerprint(['M README.md', 'M scratch.txt']), '狀態改變必須影響指紋');
  assert.equal(dirtyFingerprint([]), null);
  assert.equal(dirtyFingerprint(['  M   README.md  ']), dirtyFingerprint(['M README.md']));

  const many = Array.from({ length: 40 }, (_, i) => `?? file-${i}.txt`);
  const changed = [...many.slice(0, 39), '?? file-99.txt'];
  assert.notEqual(dirtyFingerprint(many), dirtyFingerprint(changed), '第 31 筆之後的變動也必須改變指紋');
});

test('porcelain 代碼會翻成看得懂的說明', () => {
  assert.deepEqual(parseDirtyEntry('?? docs/GIT-WORKFLOW.md'), { code: '??', path: 'docs/GIT-WORKFLOW.md', label: '未追蹤（新檔案）', raw: '?? docs/GIT-WORKFLOW.md' });
  assert.equal(parseDirtyEntry('M server/app.js').label, '已修改');
  assert.equal(parseDirtyEntry('D old.txt').label, '已刪除');
  assert.equal(parseDirtyEntry('UU conflict.txt').label, '合併衝突');
  assert.equal(parseDirtyEntry('R new.txt -> old.txt').code, 'R');
  assert.equal(parseDirtyEntry('weird').path, 'weird');
});

// --- 無法用「確認」解除的 Git 問題 -------------------------------------------------------
test('受保護分支這類問題不能用「保留修改並繼續」跳過，只能處理後重新檢查', async t => {
  const f = fixture(t), runner = f.runner();
  const task = f.create();
  await runner.tick();
  const planned = f.task(task.id);
  approveTask(f.store, f.owner, task.id, 1);
  run(planned.workspace, 'switch', '-c', 'production');
  await runner.tick();

  const blocked = f.task(task.id);
  assert.equal(blocked.gitIssue.reason, 'protected_branch');
  assert.equal(blocked.gitIssue.resumeStatus, 'queued', '執行階段被擋下要回到 queued，不是 planning');
  const request = gitIssueRequest(f.store, blocked);
  assert.equal(request.approvable, false);
  assert.deepEqual(gitIssueView({ ...blocked, gitRequest: request }).actions.map(a => a.action), ['recheck', 'cancel']);
  assert.throws(
    () => decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'approve' }),
    e => e.status === 409 && /無法用「保留修改並繼續」解除/.test(e.message),
  );

  // 使用者自己切回任務分支之後，重新檢查會讓守門在下一次派工重跑。
  run(planned.workspace, 'switch', blocked.git.workingBranch);
  const rechecked = decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'recheck' });
  assert.equal(rechecked.status, 'queued');
  assert.equal(rechecked.gitIssue.status, 'resolved');
});

test('過期的請求與不合法的動作會被擋下', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();
  const request = gitIssueRequest(f.store, f.task(task.id));

  assert.throws(() => decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'stash' }), e => e.status === 400);
  assert.throws(() => decideGitIssue(f.store, f.owner, task.id, { issueId: 'stale-id', action: 'approve' }), e => e.status === 409);

  // 畫面上看到的那一組修改在確認前又變了：更新清單並要求重新查看，不代替使用者核准。
  writeFileSync(join(f.source, 'late.txt'), 'later');
  assert.throws(
    () => decideGitIssue(f.store, f.owner, task.id, { issueId: request.requestId, action: 'approve' }),
    e => e.status === 409 && /又有變動/.test(e.message),
  );
  const refreshed = f.task(task.id);
  assert.equal(refreshed.gitIssue.fileCount, 3);
  assert.equal(refreshed.gitIssue.status, 'pending');
  assert.equal(refreshed.gitDirtyApproval, undefined, '沒有真的核准就不得留下核准紀錄');
});

// --- API：沿用既有的 /git/recheck 路徑，向後相容只帶 issueId 的呼叫 ----------------------
test('POST /api/tasks/:id/git/recheck 支援 approve／recheck／cancel，且相容舊的呼叫方式', async t => {
  const f = fixture(t), runner = f.runner();
  await f.warmup(runner);
  f.dirty();
  const task = f.create();
  await runner.tick();

  const dist = join(f.dir, 'dist'); mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html>TaskFlow</html>');
  f.store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('git-issue-session'), f.owner.id, Date.now() + 60000);
  const server = createApp(f.store, { status: {}, stopTask() {} }, { dist }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { cookie: 'tf_session=git-issue-session', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = path => fetch(base + path, { headers: { cookie: 'tf_session=git-issue-session' } });

  // 任務資料一定要帶著待處理請求與顯示狀態，否則前端畫不出任何可按的動作。
  const listed = await (await get(`/api/tasks/${task.id}`)).json();
  assert.equal(listed.displayStatus, 'waiting_git_confirmation');
  assert.equal(listed.gitRequest.reason, 'dirty_working_tree');
  assert.equal(listed.gitRequest.fileCount, 2);
  assert.ok(listed.gitRequest.requestId);

  // 舊的呼叫方式（只帶 gitIssue.id、沒有 action）＝重新檢查。
  const legacy = await post(`/api/tasks/${task.id}/git/recheck`, { issueId: listed.gitIssue.id });
  assert.equal(legacy.status, 200);
  const stillBlocked = await legacy.json();
  assert.equal(stillBlocked.gitRequest.fileCount, 2);
  assert.equal(stillBlocked.status, 'waiting_input');

  // approve
  const approved = await (await post(`/api/tasks/${task.id}/git/recheck`, { issueId: stillBlocked.gitRequest.requestId, action: 'approve' })).json();
  assert.equal(approved.status, 'planning');
  assert.equal(approved.gitRequest, null);
  assert.equal(approved.displayStatus, 'planning');
  assert.ok(approved.gitDirtyApproval.fingerprint);

  // 已經沒有待處理請求時再按一次會被擋下，而且不會有任何破壞性後果。
  const repeat = await post(`/api/tasks/${task.id}/git/recheck`, { issueId: approved.gitDirtyApproval.fingerprint, action: 'approve' });
  assert.equal(repeat.status, 409);
  assert.equal(readFileSync(join(f.source, 'README.md'), 'utf8'), '# 使用者自己的修改');

  // cancel（用一個新任務驗證，避免影響上面的狀態）
  writeFileSync(join(f.source, 'more.txt'), 'wip');
  const second = f.create('Second task');
  await runner.tick();
  const blockedSecond = gitIssueRequest(f.store, f.task(second.id));
  const cancelled = await (await post(`/api/tasks/${second.id}/git/recheck`, { issueId: blockedSecond.requestId, action: 'cancel' })).json();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.displayStatus, 'cancelled');
  assert.equal(cancelled.gitRequest, null);
});
