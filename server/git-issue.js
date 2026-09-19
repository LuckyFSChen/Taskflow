// Git 守門（dirty working tree、受保護分支、巢狀版本庫…）的人工處理閉環。
//
// 為什麼需要這個模組：Git 守門本身早就正確地擋下了任務（見 git-workspace.js），但被擋下來
// 之後沒有出路——runner 只寫下 task.gitIssue 就停住，UI 沒有任何可按的解除動作，於是任務
// 永久停在「需要處理」。這裡補的就是那個閉環，而且刻意只補 lifecycle：
//
//   1. 沿用既有的 task.gitIssue 與 task.resumeStatus，不另外發明平行機制。
//   2. 三個出路：保留修改並繼續（approve）／我已自行處理，重新檢查（recheck）／取消任務（cancel）。
//   3. 任何出路都不會執行破壞性 git 指令。這個模組只讀 `git status`（透過 inspect），
//      不 reset、不 clean、不 stash、不 checkout、不 commit、不刪除任何檔案。
//   4. 「保留修改並繼續」會記下當下 git status 的指紋（gitDirtyApproval）。runner 下一輪
//      看到同一個指紋就不再阻塞；指紋變了（又有新修改）才會再問一次。這是避免
//      「按了繼續還是一直卡同一組修改」無限循環的關鍵。
//   5. Git dirty 不是執行失敗：狀態走 waiting_input + 人工請求，不寫 failed。
import { existsSync } from 'node:fs';
import { hash, now } from './db.js';
import { HttpError, requireTask } from './domain.js';
import { createGitWorkspace } from './git-workspace.js';

const shared = createGitWorkspace();

// 使用者可以直接「確認並繼續」的只有未提交修改：那是他自己的內容，他有權決定保留。
// 受保護分支、detached HEAD、巢狀版本庫、worktree 遺失、git 指令失敗等不在此列——
// 那些必須真的去處理，再用「重新檢查」解除，否則就是在放行一個真實的風險。
export const APPROVABLE_REASONS = ['dirty_working_tree'];

// 任務被 Git 守門擋下前可能處於的狀態；恢復時只能回到這些狀態之一。
const RESUMABLE_STATUS = ['planning', 'repair_planning', 'queued', 'awaiting_approval', 'awaiting_repair_approval'];

// UI／LINE／自動化可以直接分支判斷的顯示狀態：「需要你確認 Git 修改」與一般的
// waiting_input（回答問題）和 waiting_user_action（在本機執行指令）都不是同一件事。
export const GIT_ISSUE_DISPLAY_STATUS = 'waiting_git_confirmation';

export const GIT_ISSUE_TITLES = {
  dirty_working_tree: '需要確認 Git 修改',
  protected_branch: '需要處理 Git 分支狀態',
  branch_changed: '需要處理 Git 分支狀態',
  detached_head: '需要處理 Git 分支狀態',
  nested_repository: '需要處理 Git 版本庫設定',
  no_commits: '需要先建立第一個 commit',
  worktree_missing: '任務工作目錄已不存在',
  worktree_path_taken: '工作目錄已被占用',
  git_status_failed: 'Git 狀態讀取失敗',
  git_command_failed: 'Git 指令執行失敗',
};

/** 舊資料沒有 status 欄位，一律視為 pending。 */
export const gitIssueStatus = task => (task?.gitIssue ? task.gitIssue.status || 'pending' : null);

/**
 * 這個任務現在是否被 Git 守門擋著。runner 與所有「不准直接重跑」的守門都用這個判斷，
 * 而不是 `!!task.gitIssue`：已處理完的紀錄會留在 task.gitIssue 上供 UI 顯示，
 * 不該再繼續阻塞任務。
 * @param {any} task
 * @returns {boolean}
 */
export function gitIssuePending(task) {
  return gitIssueStatus(task) === 'pending' && !['cancelled', 'completed'].includes(task?.status);
}

/**
 * 待使用者處理的 Git 請求（UI 直接渲染這個物件）；沒有就回傳 null。
 * @param {any} store
 * @param {any} task
 */
export function gitIssueRequest(store, task) {
  if (!gitIssuePending(task)) return null;
  const issue = task.gitIssue, files = Array.isArray(issue.files) ? issue.files : [];
  return {
    ...issue,
    status: 'pending',
    files,
    fileCount: Number.isInteger(issue.fileCount) ? issue.fileCount : files.length,
    title: GIT_ISSUE_TITLES[issue.reason] || 'Git 需要你確認',
    approvable: APPROVABLE_REASONS.includes(issue.reason),
    fingerprint: issue.fingerprint || null,
    // 檔案清單或指紋一變就換一個 requestId：使用者按下的一定是他畫面上看到的那一組修改，
    // 過期的畫面會被擋下來要求重新查看，而 task.gitIssue.id 維持不變，不會產生重複 blocker。
    requestId: hash(JSON.stringify([issue.id, issue.fingerprint || null, files, task.controlVersion || 0])),
    resumeStatus: resumeTarget(task),
  };
}

/** 處理完 Git 問題後該回到哪一個狀態：優先用擋下來之前保存的狀態，其次照計畫核准情形推導。 */
export function resumeTarget(task) {
  const saved = task?.gitIssue?.resumeStatus || task?.resumeStatus;
  if (RESUMABLE_STATUS.includes(saved)) return saved;
  return task?.plan && task.approvedVersion === task.planVersion ? 'queued' : 'planning';
}

/**
 * 取消任務時關閉所有仍在 pending 的人工請求。
 * 沒有這一步，已取消的任務會繼續出現在「待我處理」，也會繼續顯示「需要處理」。
 * @param {any} task
 * @param {any} [user]
 * @returns {string[]} 實際關閉了哪些請求
 */
export function closePendingRequestsOnCancel(task, user) {
  const at = now(), by = user?.id || null, closed = [];
  if (task?.gitIssue && (task.gitIssue.status || 'pending') === 'pending') {
    task.gitIssue = { ...task.gitIssue, status: 'cancelled', resolvedAt: at, resolvedBy: by };
    closed.push('git_issue');
  }
  if (task?.userActionRequired && task.userActionRequired.status === 'pending') {
    task.userActionRequired = { ...task.userActionRequired, status: 'cancelled', resolvedAt: at, resolvedBy: by };
    closed.push('user_action');
  }
  return closed;
}

const STATUS_LABELS = {
  planning: '需求規劃', repair_planning: '修正方案分析', queued: '執行佇列',
  awaiting_approval: '計畫審核', awaiting_repair_approval: '修正方案審核',
};
const resumeLabel = status => STATUS_LABELS[status] || status;

function archive(task, decision, user, extra = {}) {
  task.gitIssueHistory = [...(task.gitIssueHistory || []), { ...task.gitIssue, ...extra, decision, resolvedAt: now(), resolvedBy: user?.id || null }];
}

function resume(task, request) {
  task.status = request.resumeStatus;
  task.resumeStatus = null;
  task.error = null;
  task.controlVersion = (task.controlVersion || 0) + 1;
}

function inspectProject(store, task, gitWorkspace) {
  const project = store.project(task.projectId);
  if (!project || !existsSync(project.path)) throw new HttpError(409, '專案資料夾不存在，無法重新檢查 Git 狀態。');
  try {
    // 重新檢查一定要重跑 detection，不能拿 task.gitIssue 裡的舊判定當真相：repository topology
    // 是會變的（managed-uninitialized → git init → normal），舊快照只是 diagnostic。
    return gitWorkspace.inspect(project.path, {
      projectRoot: project.path,
      managedProjectsRoot: store.setting('defaultProjectRoot', '') || null,
    });
  } catch (e) {
    // Git 指令本身失敗（權限、版本庫損毀…）永遠不能被當成「工作目錄乾淨」，
    // 照實回報給使用者，blocker 保持原狀。
    store.event(task.id, 'git_recheck_failed', `重新檢查 Git 狀態失敗，維持等待你處理：${e.message}`);
    throw new HttpError(409, `無法重新檢查 Git 狀態：${e.message}`);
  }
}

/** 重新檢查後仍 dirty：更新同一個 blocker 的檔案清單與指紋，不建立第二個 blocker。 */
function refreshIssue(task, state) {
  task.gitIssue = {
    ...task.gitIssue,
    status: 'pending',
    files: state.dirty.slice(0, 30),
    fileCount: state.dirty.length,
    fingerprint: state.dirtyFingerprint,
    branch: state.branch ?? task.gitIssue.branch ?? null,
    refreshedAt: now(),
  };
  task.controlVersion = (task.controlVersion || 0) + 1;
}

/**
 * 使用者對 Git 守門做出的決定。
 * @param {any} store
 * @param {any} user
 * @param {string} taskId
 * @param {{issueId?:string,action?:string}} input
 * @param {{gitWorkspace?:any,runner?:any}} [deps]
 */
export function decideGitIssue(store, user, taskId, { issueId, action } = {}, { gitWorkspace = shared, runner = null } = {}) {
  if (!['approve', 'recheck', 'cancel'].includes(action)) {
    throw new HttpError(400, '請選擇「保留修改並繼續」、「我已自行處理，重新檢查」或「取消任務」');
  }
  const task = requireTask(store, user, taskId), request = gitIssueRequest(store, task);
  if (!request || (issueId && ![request.id, request.requestId].includes(issueId))) {
    throw new HttpError(409, '此 Git 問題已變更或已處理，請重新查看');
  }
  if (action !== 'cancel' && store.threads(taskId).some(t => t.status === 'running')) {
    throw new HttpError(409, '目前工作尚未停止，請稍後再處理');
  }

  if (action === 'cancel') {
    if (['completed', 'cancelled'].includes(task.status)) throw new HttpError(409, '任務已結束');
    const previous = task.status;
    task.status = 'cancelled';
    task.resumeStatus = null;
    task.error = null;
    task.controlVersion = (task.controlVersion || 0) + 1;
    archive(task, 'cancel', user);
    closePendingRequestsOnCancel(task, user);
    task.manualCompletion = null;
    store.saveTask(task);
    store.event(taskId, 'git_issue_cancelled', `${user.name} 取消任務（原狀態 ${resumeLabel(previous)}），Git 待確認項目已關閉，不會再出現在「待我處理」。專案目錄的未提交修改一律保留不動。`);
    if (runner) runner.stopTask(taskId);
    return task;
  }

  if (action === 'approve') {
    if (!request.approvable) {
      throw new HttpError(409, '這個 Git 問題無法用「保留修改並繼續」解除，請先實際處理後使用「重新檢查」');
    }
    const state = inspectProject(store, task, gitWorkspace);
    if (!state.isRepository) throw new HttpError(409, '專案已不是 Git repository，無法確認未提交修改。');
    // 乾淨了就沒有東西需要確認：直接當成已處理完畢，不留下一個沒有意義的核准紀錄。
    if (!state.dirty.length) {
      archive(task, 'approve_but_clean', user);
      task.gitIssue = { ...task.gitIssue, status: 'resolved', resolvedAt: now(), resolvedBy: user.id, files: [], fileCount: 0, fingerprint: null };
      task.gitDirtyApproval = null;
      resume(task, request);
      store.saveTask(task);
      store.event(taskId, 'git_recheck_clean', `Git working tree 已乾淨，任務恢復${resumeLabel(request.resumeStatus)}。`);
      return task;
    }
    // 核准必須綁定「他畫面上看到的那一組修改」。期間又有新的變動就更新清單並要求重新確認，
    // 絕不代替使用者核准他沒看過的修改。
    if (request.fingerprint && state.dirtyFingerprint !== request.fingerprint) {
      refreshIssue(task, state);
      store.saveTask(task);
      store.event(taskId, 'git_dirty_changed', `未提交修改在你確認前又有變動，已更新為 ${state.dirty.length} 個待確認項目，請重新查看後再確認。`);
      throw new HttpError(409, '專案的未提交修改在你確認前又有變動，已更新清單，請重新查看後再確認。');
    }
    task.gitDirtyApproval = {
      approvedAt: now(), approvedBy: user.id, projectId: task.projectId,
      fingerprint: state.dirtyFingerprint, files: state.dirty.slice(0, 30), fileCount: state.dirty.length,
      planVersion: task.planVersion,
    };
    archive(task, 'approve', user, { approvedFingerprint: state.dirtyFingerprint });
    task.gitIssue = { ...task.gitIssue, status: 'approved', resolvedAt: now(), resolvedBy: user.id, approvedFingerprint: state.dirtyFingerprint };
    resume(task, request);
    store.saveTask(task);
    store.event(taskId, 'git_dirty_approved',
      `${user.name} 已確認目前 Git working tree 的 ${state.dirty.length} 項未提交修改，TaskFlow 將保留既有修改並繼續，不會 reset、clean、stash 或刪除檔案；任務仍在獨立的 Git worktree 中執行。任務恢復${resumeLabel(request.resumeStatus)}。\n${state.dirty.slice(0, 30).join('\n')}`);
    return task;
  }

  // action === 'recheck'：真的重新讀一次 git status，不是只把旗標清掉。
  const state = inspectProject(store, task, gitWorkspace);
  const stillDirty = state.isRepository && state.dirty.length > 0;
  if (request.reason === 'dirty_working_tree' && stillDirty) {
    refreshIssue(task, state);
    store.saveTask(task);
    store.event(taskId, 'git_rechecked', `${user.name} 要求重新檢查：Git working tree 仍有 ${state.dirty.length} 個未提交修改，已更新待確認清單，任務維持等待你處理。\n${state.dirty.slice(0, 30).join('\n')}`);
    return task;
  }
  // 其他 reason（受保護分支、巢狀版本庫…）無法只靠 git status 斷定已解決：清除 blocker
  // 讓 runner 重跑同一份守門，若仍未處理會立刻再擋下來，不會偷偷放行。
  //
  // nested_repository 是唯一有可能「不需要使用者做任何事」就解除的：TaskFlow 管理的專案
  // 資料夾在還沒 git init 前會被判成上層版本庫的子目錄，重新檢查時會得到
  // managed-uninitialized，下一次派工由 TaskFlow 自己初始化版本庫即可。
  const selfResolvable = request.reason === 'nested_repository' && state.policy && !state.policy.blocked;
  archive(task, 'recheck', user);
  task.gitIssue = {
    ...task.gitIssue, status: 'resolved', resolvedAt: now(), resolvedBy: user.id,
    ...(request.reason === 'dirty_working_tree' ? { files: [], fileCount: 0, fingerprint: null } : {}),
  };
  if (request.reason === 'dirty_working_tree') task.gitDirtyApproval = null;
  resume(task, request);
  store.saveTask(task);
  store.event(taskId, request.reason === 'dirty_working_tree' ? 'git_recheck_clean' : 'git_rechecked',
    request.reason === 'dirty_working_tree'
      ? `Git working tree 已乾淨，任務恢復${resumeLabel(request.resumeStatus)}。`
      : selfResolvable
        ? `重新檢查後，此專案不再被判定為其他版本庫的子目錄（目前判定：${state.repository?.repositoryType || '未知'}）${state.repository?.needsGitInit ? '，TaskFlow 會在下一次派工前為它建立獨立的 Git 版本庫' : ''}。任務恢復${resumeLabel(request.resumeStatus)}。`
        : `${user.name} 已處理 Git 狀態並要求重新檢查；守門會在下一次派工前重跑，未通過前不執行工作。任務恢復${resumeLabel(request.resumeStatus)}。`);
  return task;
}
