// Git 守門待確認畫面的資訊整理（與 Vue 無關，方便測試）。
//
// 這個模組的存在理由很具體：使用者原本只看到「需要處理」四個字，沒有任何可以按的動作。
// 所以這裡的輸出一定要同時回答三件事：
//   1. 現在是什麼狀況（哪些檔案、幾個）
//   2. TaskFlow 保證不會做什麼（不刪除、不 reset、不 clean、不 stash、不覆蓋）
//   3. 我可以按什麼（保留修改並繼續／我已自行處理重新檢查／取消任務）
//
// 只呈現後端已經送來的事實，不推測、不代替使用者決定。

export const DIRTY_STATUS_LABELS = {
  '??': '未追蹤（新檔案）',
  '!!': '已被忽略',
  M: '已修改',
  MM: '已修改（部分已 staged）',
  AM: '新增後又修改',
  A: '新增（已 staged）',
  D: '已刪除',
  R: '已改名',
  C: '已複製',
  T: '類型已變更',
  U: '合併衝突',
  UU: '合併衝突',
  AA: '合併衝突',
  DD: '合併衝突',
};

// TaskFlow 在這個情境下的明確承諾。文案直接列出來，讓使用者按下按鈕前就知道界線。
export const GIT_DIRTY_GUARANTEES = [
  '不會刪除這些修改',
  '不會執行 git reset',
  '不會執行 git clean',
  '不會執行 git stash',
  '不會覆蓋這些檔案',
];

const ACTION_LABELS = {
  approve: '保留修改並繼續',
  recheck: '我已自行處理，重新檢查',
  cancel: '取消任務',
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把 `git status --porcelain` 的一行拆成可顯示的欄位。
 * 後端已經 trim 過，所以只取「第一段代碼 + 其餘路徑」，不猜測 staged／unstaged 的欄位位置。
 * @param {string} line
 * @returns {{code:string,path:string,label:string,raw:string}}
 */
export function parseDirtyEntry(line) {
  const raw = text(line);
  const match = /^(\S+)\s+(.*)$/.exec(raw);
  if (!match) return { code: '', path: raw, label: '已變更', raw };
  const [, code, path] = match;
  const label = DIRTY_STATUS_LABELS[code] || DIRTY_STATUS_LABELS[code[0]] || '已變更';
  return { code, path: path.trim(), label, raw };
}

/**
 * 目前要不要顯示 Git 確認區塊、顯示什麼、可以按什麼。沒有待確認事項就回傳 null。
 * @param {any} task
 */
export function gitIssueView(task) {
  const request = task?.gitRequest;
  if (!request) return null;
  const files = (Array.isArray(request.files) ? request.files : []).map(parseDirtyEntry);
  const fileCount = Number.isInteger(request.fileCount) ? request.fileCount : files.length;
  const approvable = request.approvable !== false && request.reason === 'dirty_working_tree';
  return {
    id: text(request.id),
    requestId: text(request.requestId) || text(request.id),
    reason: text(request.reason),
    title: text(request.title) || '需要確認 Git 修改',
    message: text(request.message),
    fileCount,
    files,
    // 後端只送前 30 筆檔案清單，數量卻是完整的；沒講清楚會讓人以為只有 30 個檔案。
    truncated: fileCount > files.length,
    branch: text(request.branch) || null,
    resumeStatus: text(request.resumeStatus) || null,
    approvable,
    guarantees: approvable ? GIT_DIRTY_GUARANTEES : [],
    actions: [
      ...(approvable ? [{ action: 'approve', label: ACTION_LABELS.approve, primary: true }] : []),
      { action: 'recheck', label: ACTION_LABELS.recheck, primary: !approvable },
      { action: 'cancel', label: ACTION_LABELS.cancel, primary: false },
    ],
  };
}

/**
 * 已經確認過的未提交修改（供 UI 顯示「你已於 … 確認保留這 N 項修改」）。
 * @param {any} task
 */
export function gitDirtyApprovalView(task) {
  const approval = task?.gitDirtyApproval;
  if (!approval?.approvedAt) return null;
  const files = (Array.isArray(approval.files) ? approval.files : []).map(parseDirtyEntry);
  return {
    approvedAt: approval.approvedAt,
    fileCount: Number.isInteger(approval.fileCount) ? approval.fileCount : files.length,
    files,
  };
}
