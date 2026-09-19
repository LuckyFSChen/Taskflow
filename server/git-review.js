// Phase 3：任務跑完後的人工審核。
//
// 自動流程到「驗證完成」就停住，之後的每一步都由使用者按下去才會發生：
//   核准並 Merge ／ 要求修改 ／ 拒絕 ／ 撤銷已合併的成果
// TaskFlow 在這裡只負責把 Git 的真實狀態攤開來，以及執行使用者選的那一個動作。
// 它不會替使用者切換分支、不會解衝突、不會在沒被要求時刪掉任何分支。
import { HttpError, requireTask, reviseTask } from './domain.js';
import { createGitWorkspace, GitSafetyError } from './git-workspace.js';
import { now, id } from './db.js';
import { assertTaskTransition, isTaskReadyToClose } from './task-status.js';

const shared = createGitWorkspace();

const summarize = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
const firstLine = text => String(text || '').split('\n')[0].trim();

function gitTask(store, user, tid) {
  const t = requireTask(store, user, tid);
  if (t.git?.mode !== 'worktree') throw new HttpError(409, '此任務不是以 Git 模式執行，沒有可審核的分支。');
  return t;
}

// 唯一的「main 是否真的包含這個 commit」入口：一律對目前的 baseBranch 即時重新檢查，
// 不吃合併當下或上一次檢查時的快取。commit 可以是 gitMerge 記下的 merge commit，
// 也可以是還沒被 TaskFlow 自己合併過、但已經在外部被合併進去的任務分支 HEAD。
function mainContainsCommit(gitWorkspace, repositoryPath, baseBranch, commit) {
  if (!commit) return false;
  return gitWorkspace.git(repositoryPath, ['merge-base', '--is-ancestor', commit, baseBranch], { allowFailure: true }).ok;
}

function branchHeadOf(gitWorkspace, repositoryPath, branch) {
  const result = gitWorkspace.git(repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true });
  return result.ok ? firstLine(result.stdout) : null;
}

/**
 * 唯一的 completed→ready_to_close reconciliation 入口，closeTask() 與 taskGitReview()
 * 共用同一份判斷，不建立第二套邏輯。只處理「TaskFlow 自己不知道已經合併」的兩種情況：
 *   1. 分支已經在外部（使用者手動 git merge）被合併進 baseBranch，t.gitMerge 還是空的。
 *   2. 舊資料：這次改造之前就合併過，t.gitMerge 早就存在，但 status 從來沒被推進過。
 * 條件不成立就原樣把 t 傳回去，不拋錯——呼叫端（尤其是 GET /git/review）不能因為
 * 這裡驗證失敗就整支請求壞掉，任務只是照舊維持 completed。
 */
function reconcileExternalMerge(store, t, gitWorkspace) {
  if (t.status !== 'completed') return t;
  if (t.gitMerge) {
    if (!mainContainsCommit(gitWorkspace, t.git.repositoryPath, t.gitMerge.baseBranch, t.gitMerge.commit)) return t;
  } else {
    const branchHead = branchHeadOf(gitWorkspace, t.git.repositoryPath, t.git.workingBranch);
    if (!branchHead || !mainContainsCommit(gitWorkspace, t.git.repositoryPath, t.git.baseBranch, branchHead)) return t;
    t.gitMerge = { commit: branchHead, baseBranch: t.git.baseBranch, workingBranch: t.git.workingBranch, artifactVersion: t.artifactVersion, by: null, at: now(), external: true };
  }
  assertTaskTransition(t, 'ready_to_close');
  t.status = 'ready_to_close';
  t.readyToCloseAt = now();
  store.saveTask(t);
  store.event(t.id, 'ready_to_close', t.gitMerge.external
    ? '偵測到此任務已在外部手動合併，直接視為等待關閉，不需要再次核准合併。'
    : '這是本次改造之前已合併的任務，重新確認合併結果仍在正式分支上後，直接視為等待關閉。');
  return t;
}

// 審核畫面要的一切：分支、這條分支上的 commit、每個階段的驗收結果，以及正式分支現在的狀態。
// 這裡會實際讀 Git，所以只在使用者開啟審核時呼叫，不放進輪詢用的 /api/state。
//
// 這支 API 語意上是「重新整理 Git Delivery 狀態」：如果讀 Git 的當下發現一個 completed
// 任務其實已經整合進正式分支了（外部手動合併，或舊資料從未推進過），會順手呼叫
// reconcileExternalMerge() 把這件事持久化為 ready_to_close，而不只是在回傳物件裡假裝一下——
// 否則畫面看到的 externallyMerged 跟資料庫裡的 task.status 會對不起來。
export function taskGitReview(store, user, tid, { gitWorkspace = shared } = {}) {
  let t = requireTask(store, user, tid);

  if (t.git?.mode !== 'worktree') {
    const threads = store.threads(t.id).filter(th => th.version === t.planVersion && th.status === 'completed');
    const validation = threads.map(th => ({
      phase: th.phase, role: th.role, title: th.title,
      passed: th.result?.passed ?? null,
      browserValidation: th.result?.browserValidation?.status ?? null,
      commit: th.commit?.commit || null,
    }));
    return { available: false, reason: t.workspace ? 'legacy_workspace' : 'not_git', validation, merge: null, conflict: null };
  }

  let commits = [], repository = null, repositoryError = null, remote = null;
  // 下面這些欄位一律是「現在重新問一次 Git」的結果，不是任務完成或上次合併當下的快取
  // （計畫書第八、九章）：main 有沒有前進、現在合不合併得起來，隨時可能已經和快取的結論不同。
  let mainHead = null, mainAdvanced = false, mergeable = false, externallyMerged = false;
  let hasConflict = !!t.gitConflict, conflict = t.gitConflict || null;

  try {
    mainHead = branchHeadOf(gitWorkspace, t.git.repositoryPath, t.git.baseBranch);
    mainAdvanced = !!(mainHead && t.git.baseCommit && mainHead !== t.git.baseCommit);

    if (!t.gitMerge) {
      // 還沒被 TaskFlow 自己合併過：先確認分支是不是已經在外部被手動合併進 main，
      // 這種情況不需要使用者再按一次「Merge 到 main」（計畫書第十章 Case D）。
      const branchHead = branchHeadOf(gitWorkspace, t.git.repositoryPath, t.git.workingBranch);
      if (branchHead && mainContainsCommit(gitWorkspace, t.git.repositoryPath, t.git.baseBranch, branchHead)) {
        externallyMerged = true;
      } else if (branchHead) {
        // 即時重新試算一次合不合併得起來；不沿用任務完成當下的舊結論。
        const preview = gitWorkspace.previewMerge({ repositoryPath: t.git.repositoryPath, baseBranch: t.git.baseBranch, workingBranch: t.git.workingBranch });
        if (preview.available && preview.conflicted) {
          hasConflict = true;
          conflict = conflict || { files: preview.files, hint: 'TaskFlow 不會自行決定 ours／theirs。請在專案目錄手動處理衝突後再回來，或改為要求 AI 修改。', baseBranch: t.git.baseBranch, workingBranch: t.git.workingBranch };
        }
        mergeable = preview.available && !preview.conflicted && !preview.alreadyMerged;
      }
    }

    if (t.status === 'completed' && (externallyMerged || t.gitMerge)) {
      t = reconcileExternalMerge(store, t, gitWorkspace);
    }

    if (!t.git.cleanedUp && t.workspace) {
      commits = gitWorkspace.commits({ workingDirectory: t.workspace, baseCommit: t.git.baseCommit });
    } else if (t.gitMerge) {
      // worktree 已經清理掉了，沒有目錄可以讀 HEAD；改用 repositoryPath 讀
      // baseCommit..分支自己的那個 parent（merge commit 的第二個 parent，因為合併一律
      // 用 --no-ff）這個固定範圍，才會跟 worktree 還在時看到的清單一致——不多算進
      // merge commit 本身，Ready to Close 畫面仍能「查看變更」。
      commits = gitWorkspace.commits({ workingDirectory: t.git.repositoryPath, baseCommit: t.git.baseCommit, head: `${t.gitMerge.commit}^2` });
    }
    // fetch:false —— 開啟審核畫面不該觸發網路操作；這裡顯示的是上次 fetch 之後的狀態，
    // 真正要推送時 pushBaseBranch() 會自己先 fetch 一次。
    remote = gitWorkspace.remoteStatus({ repositoryPath: t.git.repositoryPath, baseBranch: t.git.baseBranch, fetch: false });
    const state = gitWorkspace.inspect(t.git.repositoryPath);
    repository = {
      branch: state.branch, clean: state.dirty.length === 0,
      onBaseBranch: state.branch === t.git.baseBranch,
      dirty: state.dirty.slice(0, 30),
    };
  } catch (e) {
    repositoryError = e.message;
  }

  // 用 reconcile 之後的最新 t 組出驗證與 review 物件，確保呼叫端看到的欄位（status、
  // merge、merged...）與剛剛持久化的結果一致，不會出現「畫面說已整合，資料庫還是 completed」。
  const threads = store.threads(t.id).filter(th => th.version === t.planVersion && th.status === 'completed');
  const validation = threads.map(th => ({
    phase: th.phase, role: th.role, title: th.title,
    passed: th.result?.passed ?? null,
    browserValidation: th.result?.browserValidation?.status ?? null,
    commit: th.commit?.commit || null,
  }));

  return {
    available: true,
    status: t.gitMerge ? 'merged' : t.gitConflict ? 'conflict' : t.status === 'completed' && !t.manualCompletion ? 'ready' : 'not_ready',
    baseBranch: t.git.baseBranch,
    workingBranch: t.git.workingBranch,
    baseCommit: t.git.baseCommit,
    headCommit: t.git.headCommit,
    artifactVersion: t.artifactVersion || null,
    artifactCommit: t.artifactCommit || null,
    commits, repository, repositoryError,
    validation,
    merge: t.gitMerge || null,
    conflict,
    rollback: t.gitRollback || null,
    push: t.gitPush || null,
    cleanedUp: !!t.git.cleanedUp,
    remote,
    mainAdvanced, mainHead,
    hasConflict,
    merged: !!t.gitMerge,
    mergeable,
    externallyMerged,
  };
}

function mergeDecision(store, user, t, input, gitWorkspace) {
  // 已經合併過就直接說清楚，不要被「合併成功後 status 已經不是 completed 了」蓋掉——
  // 那會讓使用者以為成果失效了，而不是「不需要再按一次」。
  if (t.gitMerge) throw new HttpError(409, '此任務已經合併過了。');
  if (t.status !== 'completed' || t.manualCompletion) throw new HttpError(409, '只有通過獨立驗證而完成的任務才能合併；手動標記完成不代表驗收通過。');
  if (!t.artifactVersion || input.artifactVersion !== t.artifactVersion) throw new HttpError(409, '成果版本不符，請重新查看最新成果後再核准。');

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

  // mergeTaskBranch() 合併後已經自己用 merge-base --is-ancestor 驗證過一次
  // （不通過會直接丟 GitSafetyError，不會走到這裡），isTaskReadyToClose() 在這裡
  // 只是把「這個當下確實剛驗證過」這件事講清楚，而不是隨口假設剛合併完就一定成立。
  if (isTaskReadyToClose(t, { mainContainsTaskCommit: true })) {
    assertTaskTransition(t, 'ready_to_close');
    t.status = 'ready_to_close';
    t.readyToCloseAt = now();
  }
  store.saveTask(t);
  store.event(t.id, 'git_merged', `${user.name} 核准並合併 ${outcome.workingBranch} 至 ${outcome.baseBranch}（${outcome.commit.slice(0, 8)}）`);
  if (t.status === 'ready_to_close') store.event(t.id, 'ready_to_close', '合併已通過驗證，任務進入等待關閉；worktree 與分支的清理留到使用者按下「關閉任務」才執行。');

  // 清理不再是合併的一部分：合併只回答「成果進了正式分支了嗎」，
  // worktree／分支什麼時候消失是使用者按下「關閉任務」才決定的事（計畫書第十九、二十一章）。
  store.notify(t, `成果已合併至 ${outcome.baseBranch}（${outcome.commit.slice(0, 8)}）。`);
  return store.task(t.id);
}

// 清理只在合併成功、或使用者明確選擇刪除被拒絕的分支時執行；失敗一律照實回報，
// 不加 --force，也不動工作目錄裡沒提交的東西。回傳 gitWorkspace.cleanup() 的原始結果，
// 讓呼叫端（例如 closeTask）能分辨「清乾淨了」與「工作副本還有東西，保留不動」。
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
    return outcome;
  } catch (e) {
    store.event(t.id, 'git_cleanup_skipped', `清理任務分支時停止：${e.message}。分支與工作目錄保持原狀。`);
    return { removed: false, branchDeleted: false, reason: 'cleanup_error', message: e.message };
  }
}

/**
 * 使用者主動關閉任務：唯一會把 ready_to_close 推進到 closed 的入口（計畫書第十七、十八章）。
 *
 * 兩個前提缺一不可，且都是即時重新檢查，不吃合併當下的舊快取：
 *   1. 任務已經是 ready_to_close——或者雖然還停在 completed，但分支已經在外部被手動合併，
 *      這裡先把它記成 ready_to_close，不要求使用者再按一次「Merge 到 main」（Case D）。
 *   2. 目前的正式分支真的包含這個任務的合併結果（merge-base --is-ancestor）。
 *
 * 任一項不成立就丟 409，不執行任何清理，也不改狀態。
 */
export async function closeTask(store, user, tid, input = {}, { gitWorkspace = shared, previews = null } = {}) {
  const t = gitTask(store, user, tid);
  if (t.status === 'closed') throw new HttpError(409, '此任務已經關閉。');
  const forceCleanup = input.forceCleanup === true;

  if (t.status !== 'ready_to_close') {
    if (t.status !== 'completed') throw new HttpError(409, `任務目前是 ${t.status}，還不能關閉。`);
    // 與 taskGitReview() 共用同一份 reconciliation：涵蓋「外部手動合併」與「舊資料合併過
    // 但從沒推進過 status」兩種情況（計畫書第十四、三十一章）。條件不成立就原樣不動、
    // 不拋錯，交給下面依 t.gitMerge 有沒有值分辨出精確的錯誤原因。
    reconcileExternalMerge(store, t, gitWorkspace);
    if (t.status !== 'ready_to_close') {
      if (t.gitMerge) throw new HttpError(409, `${t.gitMerge.baseBranch} 目前不包含此任務先前的合併結果，無法關閉；請重新確認 Git 狀態。`);
      throw new HttpError(409, '尚未合併至正式分支，無法關閉；請先在「部署與驗收」核准合併，或確認 Git 狀態後再試一次。');
    }
  }

  const mainContainsTaskCommit = mainContainsCommit(gitWorkspace, t.git.repositoryPath, t.gitMerge.baseBranch, t.gitMerge.commit);
  if (!mainContainsTaskCommit) {
    throw new HttpError(409, `${t.gitMerge.baseBranch} 目前不包含此任務的合併結果，無法關閉；請重新整理 Git 狀態後再試一次。`);
  }

  // Close 是這個任務生命週期的最後一步：任何還綁著它的 Preview／執行期程序都要先停掉，
  // 避免任務關閉後背景還留著程序（計畫書第二十二章）。找不到 previews 依賴就跳過，
  // 不阻擋關閉本身。
  if (previews) { try { await previews.stop(`${t.projectId}:${t.id}:${t.planVersion}`); } catch { /* 沒有在跑就是沒有在跑 */ } }

  const cleanupOutcome = applyCleanup(store, t, { gitWorkspace, deleteUnmerged: forceCleanup });
  const latest = store.task(t.id);
  if (cleanupOutcome?.reason === 'worktree_not_removable') {
    // 工作副本仍有未提交變更：不刪、不強制，任務維持 ready_to_close，讓使用者自己處理後
    // 或明確選擇「強制清理」再回來關閉（計畫書第二十一、三十章）。
    return { ...latest, cleanupWarning: `工作副本仍有未提交變更，已保留不動，尚未關閉：${(cleanupOutcome.files || []).slice(0, 10).join('、')}` };
  }

  latest.status = 'closed';
  latest.closedAt = now();
  latest.closedBy = user.id;
  store.saveTask(latest);
  store.event(t.id, 'task_closed', `${user.name} 關閉任務${cleanupOutcome?.reason === 'branch_not_deleted' ? '（分支尚未刪除，可能尚未完全合併，已保留）' : ''}`);
  store.notify(latest, '任務已關閉。');
  return store.task(t.id);
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
