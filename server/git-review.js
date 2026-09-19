// Phase 3：任務跑完後的人工審核。
//
// 自動流程到「驗證完成」就停住，之後的每一步都由使用者按下去才會發生：
//   核准並 Merge ／ 要求修改 ／ 拒絕 ／ 撤銷已合併的成果
// TaskFlow 在這裡只負責把 Git 的真實狀態攤開來，以及執行使用者選的那一個動作。
// 它不會替使用者切換分支、不會解衝突、不會在沒被要求時刪掉任何分支。
import { HttpError, requireTask, reviseTask } from './domain.js';
import { createGitWorkspace, GitSafetyError } from './git-workspace.js';
import { now, id } from './db.js';

const shared = createGitWorkspace();

const summarize = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);

function gitTask(store, user, tid) {
  const t = requireTask(store, user, tid);
  if (t.git?.mode !== 'worktree') throw new HttpError(409, '此任務不是以 Git 模式執行，沒有可審核的分支。');
  return t;
}

// 審核畫面要的一切：分支、這條分支上的 commit、每個階段的驗收結果，以及正式分支現在的狀態。
// 這裡會實際讀 Git，所以只在使用者開啟審核時呼叫，不放進輪詢用的 /api/state。
export function taskGitReview(store, user, tid, { gitWorkspace = shared } = {}) {
  const t = requireTask(store, user, tid);
  const threads = store.threads(t.id).filter(th => th.version === t.planVersion && th.status === 'completed');
  const validation = threads.map(th => ({
    phase: th.phase, role: th.role, title: th.title,
    passed: th.result?.passed ?? null,
    browserValidation: th.result?.browserValidation?.status ?? null,
    commit: th.commit?.commit || null,
  }));

  if (t.git?.mode !== 'worktree') {
    return { available: false, reason: t.workspace ? 'legacy_workspace' : 'not_git', validation, merge: null, conflict: null };
  }

  const review = {
    available: true,
    status: t.gitMerge ? 'merged' : t.gitConflict ? 'conflict' : t.status === 'completed' && !t.manualCompletion ? 'ready' : 'not_ready',
    baseBranch: t.git.baseBranch,
    workingBranch: t.git.workingBranch,
    baseCommit: t.git.baseCommit,
    headCommit: t.git.headCommit,
    artifactVersion: t.artifactVersion || null,
    artifactCommit: t.artifactCommit || null,
    commits: [], repository: null,
    validation,
    merge: t.gitMerge || null,
    conflict: t.gitConflict || null,
    rollback: t.gitRollback || null,
    push: t.gitPush || null,
    cleanedUp: !!t.git.cleanedUp,
  };

  try {
    if (!t.git.cleanedUp && t.workspace) {
      review.commits = gitWorkspace.commits({ workingDirectory: t.workspace, baseCommit: t.git.baseCommit });
    }
    // fetch:false —— 開啟審核畫面不該觸發網路操作；這裡顯示的是上次 fetch 之後的狀態，
    // 真正要推送時 pushBaseBranch() 會自己先 fetch 一次。
    review.remote = gitWorkspace.remoteStatus({ repositoryPath: t.git.repositoryPath, baseBranch: t.git.baseBranch, fetch: false });
    const state = gitWorkspace.inspect(t.git.repositoryPath);
    review.repository = {
      branch: state.branch, clean: state.dirty.length === 0,
      onBaseBranch: state.branch === t.git.baseBranch,
      dirty: state.dirty.slice(0, 30),
    };
  } catch (e) {
    review.repositoryError = e.message;
  }
  return review;
}

function mergeDecision(store, user, t, input, gitWorkspace) {
  if (t.status !== 'completed' || t.manualCompletion) throw new HttpError(409, '只有通過獨立驗證而完成的任務才能合併；手動標記完成不代表驗收通過。');
  if (!t.artifactVersion || input.artifactVersion !== t.artifactVersion) throw new HttpError(409, '成果版本不符，請重新查看最新成果後再核准。');
  if (t.gitMerge) throw new HttpError(409, '此任務已經合併過了。');

  const outcome = gitWorkspace.merge({
    repositoryPath: t.git.repositoryPath,
    baseBranch: t.git.baseBranch,
    workingBranch: t.git.workingBranch,
    subject: `taskflow: ${summarize(t.title)}`.slice(0, 72),
    body: [
      `任務：${t.title}（${t.id}）`,
      `分支：${t.git.workingBranch} → ${t.git.baseBranch}`,
      `成果版本：${t.artifactVersion}`,
      `核准合併：${user.name}（${user.id}）於 ${now()}`,
    ].join('\n'),
  });

  if (!outcome.merged && outcome.reason === 'conflict') {
    t.gitConflict = { id: id(), files: outcome.files, hint: outcome.hint, baseBranch: outcome.baseBranch, workingBranch: outcome.workingBranch, at: now() };
    store.saveTask(t);
    store.event(t.id, 'git_conflict', `合併 ${outcome.workingBranch} 發生衝突，已停止：${outcome.files.join('、')}`);
    store.notify(t, `合併發生衝突，尚未合併。\n\n${outcome.files.join('\n')}\n\n${outcome.hint}`);
    return t;
  }
  if (!outcome.merged && outcome.reason === 'already_merged') throw new HttpError(409, '此分支的內容已經在正式分支上了。');

  t.gitConflict = null;
  t.gitMerge = { commit: outcome.commit, baseBranch: outcome.baseBranch, workingBranch: outcome.workingBranch, artifactVersion: t.artifactVersion, by: user.id, at: now() };
  t.publishApproval = { by: user.id, at: now(), artifactVersion: t.artifactVersion };
  store.saveTask(t);
  store.event(t.id, 'git_merged', `${user.name} 核准並合併 ${outcome.workingBranch} 至 ${outcome.baseBranch}（${outcome.commit.slice(0, 8)}）`);

  if (input.cleanup !== false) applyCleanup(store, t, { gitWorkspace, deleteUnmerged: false });
  store.notify(t, `成果已合併至 ${outcome.baseBranch}（${outcome.commit.slice(0, 8)}）。`);
  return store.task(t.id);
}

// 清理只在合併成功、或使用者明確選擇刪除被拒絕的分支時執行；失敗一律照實回報，
// 不加 --force，也不動工作目錄裡沒提交的東西。
export function applyCleanup(store, t, { gitWorkspace, deleteUnmerged }) {
  try {
    const outcome = gitWorkspace.cleanup({
      repositoryPath: t.git.repositoryPath,
      workingDirectory: t.git.cleanedUp ? null : t.workspace,
      workingBranch: t.git.workingBranch,
      deleteUnmerged,
    });
    const latest = store.task(t.id);
    if (outcome.removed) { latest.workspace = null; latest.git = { ...latest.git, workingDirectory: null, cleanedUp: true }; }
    latest.git = { ...latest.git, branchDeleted: !!outcome.branchDeleted };
    store.saveTask(latest);
    Object.assign(t, latest);
    store.event(t.id, outcome.branchDeleted || outcome.removed ? 'git_cleanup' : 'git_cleanup_skipped',
      outcome.message || (outcome.notes || []).join(' ') || '沒有需要清理的項目。');
  } catch (e) {
    store.event(t.id, 'git_cleanup_skipped', `清理任務分支時停止：${e.message}。分支與工作目錄保持原狀。`);
  }
}

function rejectDecision(store, user, t, input, gitWorkspace) {
  if (t.gitMerge) throw new HttpError(409, '已經合併的任務不能改為拒絕；如需撤銷請使用 rollback。');
  const keepBranch = input.keepBranch !== false;   // 預設保留，避免開發成果直接消失
  t.gitReview = { decision: 'rejected', by: user.id, at: now(), keepBranch };
  t.gitConflict = null;
  t.status = 'cancelled';
  t.controlVersion = (t.controlVersion || 0) + 1;
  store.saveTask(t);
  store.event(t.id, 'git_rejected', `${user.name} 拒絕此任務的成果；${keepBranch ? `保留分支 ${t.git.workingBranch}` : `將刪除分支 ${t.git.workingBranch}`}`);
  if (!keepBranch) applyCleanup(store, t, { gitWorkspace, deleteUnmerged: true });
  return store.task(t.id);
}

export function decideGitReview(store, user, tid, input, { gitWorkspace = shared } = {}) {
  const t = gitTask(store, user, tid);
  if (input.decision === 'merge') return mergeDecision(store, user, t, input, gitWorkspace);
  if (input.decision === 'reject') return rejectDecision(store, user, t, input, gitWorkspace);
  if (input.decision === 'changes') {
    // 要求修改沿用同一個分支與同一個 worktree：分支名只由 taskId 決定，補充需求後重新規劃即可。
    if (t.gitMerge) throw new HttpError(409, '已經合併的任務請另外建立新任務。');
    // 任務已經跑完並停在審核，要繼續修改得先把它放回可補充需求的狀態；成果核准同時失效，
    // 因為接下來產生的會是另一份成果。分支與 worktree 都不動。
    if (t.status === 'completed') {
      if (store.threads(tid).some(th => th.status === 'running')) throw new HttpError(409, '目前工作尚未停止');
      t.status = 'waiting_input'; t.manualCompletion = null; t.artifactVersion = null; t.artifactCommit = null;
      t.publishApproval = null; t.controlVersion = (t.controlVersion || 0) + 1;
      store.saveTask(t);
    }
    const updated = reviseTask(store, user, tid, input.answer);
    updated.gitConflict = null;
    updated.gitReview = { decision: 'changes', by: user.id, at: now() };
    store.saveTask(updated);
    store.event(tid, 'git_changes_requested', `${user.name} 要求修改，沿用分支 ${t.git.workingBranch} 繼續`);
    return updated;
  }
  throw new HttpError(400, '不支援的審核決定');
}

/**
 * 把本機正式分支推到遠端。這是整條流程最後一個還會把人趕回終端機的步驟。
 *
 * 它不在自動化流程裡：預設不推，必須由使用者明確按下去（計畫書第十六章）。
 * 落後遠端、工作樹不乾淨、不在正式分支上，都會拒絕並說明原因——TaskFlow 不會
 * 替你決定要用 merge 還是 rebase 整合別人的工作。
 */
export function pushTaskBaseBranch(store, user, tid, input, { gitWorkspace = shared } = {}) {
  const t = gitTask(store, user, tid);
  if (!t.gitMerge) throw new HttpError(409, '尚未合併到正式分支，沒有屬於這個任務的成果可以推送。');
  if (input?.baseBranch && input.baseBranch !== t.gitMerge.baseBranch) throw new HttpError(409, '分支不符，請重新查看後再推送。');

  const outcome = gitWorkspace.push({ repositoryPath: t.git.repositoryPath, baseBranch: t.gitMerge.baseBranch });
  if (!outcome.pushed) {
    store.event(t.id, 'git_push_skipped', `${outcome.remote}/${outcome.baseBranch} 已經是最新的，沒有需要推送的 commit。`);
    return store.task(t.id);
  }
  t.gitPush = { remote: outcome.remote, baseBranch: outcome.baseBranch, count: outcome.count, commit: outcome.commit, by: user.id, at: now() };
  store.saveTask(t);
  store.event(t.id, 'git_pushed', `${user.name} 核准推送：${outcome.count} 個 commit 已送上 ${outcome.remote}/${outcome.baseBranch}（${String(outcome.commit).slice(0, 8)}）`);
  store.notify(t, `已推送至 ${outcome.remote}/${outcome.baseBranch}（${outcome.count} 個 commit）。`);
  return store.task(t.id);
}

// Rollback 不回頭找舊資料夾，而是在正式分支上補一個反向 commit，歷史完整保留。
export function rollbackTaskMerge(store, user, tid, input, { gitWorkspace = shared } = {}) {
  const t = gitTask(store, user, tid);
  if (!t.gitMerge) throw new HttpError(409, '此任務尚未合併，沒有可撤銷的合併。');
  if (input.mergeCommit !== t.gitMerge.commit) throw new HttpError(409, '合併版本不符，請重新查看後再撤銷。');
  if (t.gitRollback) throw new HttpError(409, '此合併已經撤銷過了。');

  const outcome = gitWorkspace.revert({
    repositoryPath: t.git.repositoryPath,
    baseBranch: t.gitMerge.baseBranch,
    mergeCommit: t.gitMerge.commit,
    subject: `taskflow: 撤銷 ${summarize(t.title)}`.slice(0, 72),
  });
  t.gitRollback = { commit: outcome.commit, mergeCommit: outcome.mergeCommit, by: user.id, at: now() };
  t.publishApproval = null;
  store.saveTask(t);
  store.event(t.id, 'git_rollback', `${user.name} 撤銷合併 ${outcome.mergeCommit.slice(0, 8)}，新增反向 commit ${outcome.commit.slice(0, 8)}`);
  store.notify(t, `已撤銷此任務的合併（${outcome.commit.slice(0, 8)}）。歷史完整保留，未刪除任何 commit。`);
  return t;
}

export { GitSafetyError };
