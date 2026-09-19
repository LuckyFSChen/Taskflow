// 部署與驗收（Deployment & Validation）畫面的資訊整理（與 Vue 無關，方便測試）。
//
// 這個模組的存在理由：合併、衝突預檢、清理、rollback 的後端能力早就存在
// （server/git-workspace.js、server/git-review.js，並且有 tests/git-review.test.js），
// 但前端從來沒有呼叫過 /api/tasks/:id/git/review 與 /git/decision，
// 使用者因此每次都要自己開 PowerShell 下 git merge。這裡只做一件事：
// 把後端已經算好的事實攤開成「現在怎麼了 → 為什麼還不能合併 → 我可以按什麼」。
//
// 三個不可妥協的原則（與後端守門一致，UI 不得比後端寬鬆）：
//   1. 只有「通過獨立驗證而完成」的任務能合併；手動標記完成不算（server/git-review.js 的 mergeDecision）。
//   2. 有衝突就不提供合併按鈕，也不提示任何「強制合併」的做法。
//   3. 阻擋原因一律照實說出來，並說明 TaskFlow 不會替使用者做什麼（不切換分支、不解衝突）。
//
// 這裡不推測、不代替使用者決定，也不顯示伺服器磁碟路徑（後端本來就沒送出來）。

// 與 src/task-detail-view.js 的 STATE_MARKS／STATE_LABELS 保持同一套語彙，
// 使用者在「執行進度」與「部署」看到的符號意義才會一致。
export const STAGE_MARKS = { done: '✓', active: '→', blocked: '!', failed: '✗', pending: '○' };
export const STAGE_LABELS = {
  done: '已完成',
  active: '進行中',
  blocked: '等待你處理',
  failed: '未通過',
  pending: '尚未開始',
};

// 目前這一版 Completion 只涵蓋「合併與清理」。重啟正式服務、Baseline 測試比對與
// 合併後的 Browser Validation 尚未納入，這件事必須明講——把還沒實作的階段畫成
// 「尚未開始」會讓人以為系統等一下就會自己做。
export const COMPLETION_SCOPE_NOTE =
  '目前這個區塊涵蓋：檢視變更 → 測試比對 → 核准合併 → 合併後重測 → 重新啟動正式 TaskFlow → 部署驗收（API 與程序）→ 推送遠端（需另行勾選）→ 清理任務分支。畫面互動的 Browser Validation 尚未納入，仍需另行驗收。';

// 狀態 → 既有 badge 樣式。刻意放在這裡而不是寫成 template 裡的行內對照表：
// template 會被 vue-tsc 嚴格檢查，少一個鍵就整個 build 失敗；放在這個模組還能被測試涵蓋。
const BADGE_CLASSES = {
  ready: 'completed',
  merged: 'completed',
  ready_to_close: 'queued',
  closed: 'completed',
  rolled_back: 'cancelled',
  conflict: 'failed',
  blocked: 'paused',
  loading: 'queued',
};

// 測試比對的判定（對應 server/test-baseline.js 的 VERDICTS）。
// 只有 no_regression 是「這條分支沒有製造出新的失敗」；其餘每一種都要說清楚差別：
// 「有新的失敗」與「讀不懂結果」是完全不同的兩件事，不可以混為一談。
export const TEST_VERDICTS = {
  no_regression: { label: '沒有新的測試失敗', tone: 'ok', blocks: false },
  regression: { label: '偵測到新的測試失敗', tone: 'bad', blocks: true },
  baseline_unavailable: { label: '無法取得基準，無法判斷', tone: 'warn', blocks: false },
  parse_failed: { label: '無法判讀測試結果', tone: 'warn', blocks: false },
};

export const TEST_REASONS = {
  not_tap: '測試輸出不是 TAP 格式，無法結構化判讀。',
  truncated: '測試輸出過大被截斷，無法完整判讀。',
  summary_mismatch: '解析出的數量與測試自己的摘要不符，不能確定失敗清單是否完整。',
  no_summary: '測試輸出沒有摘要行（# tests／# pass／# fail）。',
  timed_out: '測試執行逾時，被中斷的部分從未跑完。',
  install_failed: '安裝相依套件失敗，測試沒有開始。',
  not_on_base_branch: '專案目錄目前不在正式分支上，取到的基準不會是正式分支的結果。',
  no_pre_merge_baseline: '沒有合併前的基準（合併前沒有先做測試比對），無法判斷這次合併造成了什麼。',
};

const MERGE_GUARANTEES = [
  '不會替你切換分支',
  '不會替你解衝突（不選 ours／theirs）',
  '不會執行 git push',
  '不會刪除未合併的內容',
];

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** commit 短碼；拿不到就回空字串，不要顯示 "undefined"。 */
export function shortCommit(value) {
  const commit = text(value);
  return commit ? commit.slice(0, 8) : '';
}

function stage(key, label, state, detail = '', note = '') {
  return { key, label, state, mark: STAGE_MARKS[state], stateLabel: STAGE_LABELS[state], detail, note };
}

/**
 * 這個任務有沒有「部署與驗收」這件事。只有 Git worktree 模式的任務才有分支可以合併；
 * 舊的 v1/v2 工作副本與非 Git 任務一律不顯示，避免給出按了也沒用的按鈕。
 * @param {any} task
 */
export function completionAvailable(task) {
  return task?.git?.mode === 'worktree';
}

/**
 * 要不要主動去讀 /api/tasks/:id/git/review。
 * 這支 API 會實際執行 git 指令，所以不能放進三秒一次的輪詢（見 server/git-review.js 的註解）；
 * 只有在任務真的走到「可能要合併」的時候才讀一次。
 * @param {any} task
 */
export function shouldLoadReview(task) {
  if (!completionAvailable(task)) return false;
  return task.status === 'completed' || !!task.gitMerge || !!task.gitConflict || !!task.gitReview;
}

/**
 * 測試比對的顯示內容。沒跑過就回傳 null。
 *
 * 一個刻意的限制：這裡只呈現後端算出來的 verdict，不自己從數字推論。
 * 「341 pass / 3 fail」這種數字沒有比對基準時完全不能用來判斷有沒有 regression——
 * 那正是這個功能要取代的猜測。
 * @param {any} task
 */
export function testComparisonView(task) {
  const report = task?.completionTest;
  if (!report) return null;
  const verdict = TEST_VERDICTS[report.verdict] || null;
  const runView = run => run ? {
    ok: !!run.ok,
    total: run.total || 0,
    passed: run.passed || 0,
    failedCount: run.failedCount ?? (run.failed || []).length,
    failed: list(run.failed),
    commit: shortCommit(run.commit),
    cached: !!run.cached,
    reason: run.reason || null,
    reasonText: run.reason ? (TEST_REASONS[run.reason] || run.reason) : null,
    durationMs: run.durationMs || 0,
  } : null;
  return {
    id: text(report.id),
    status: text(report.status),
    running: report.status === 'running',
    interrupted: report.status === 'interrupted',
    failedToRun: report.status === 'failed',
    verdict: text(report.verdict) || null,
    verdictLabel: verdict?.label || null,
    tone: verdict?.tone || null,
    // 與 badgeClass 同理：對照表放這裡，template 不自帶（template 會被 vue-tsc 嚴格檢查）。
    toneClass: { ok: 'completed', bad: 'failed', warn: 'paused' }[verdict?.tone] || 'queued',
    blocks: !!verdict?.blocks,
    baseBranch: text(report.baseBranch),
    startedAt: text(report.startedAt),
    finishedAt: text(report.finishedAt),
    newFailures: list(report.newFailures),
    newFailureCount: report.newFailureCount ?? list(report.newFailures).length,
    resolvedFailures: list(report.resolvedFailures),
    resolvedFailureCount: report.resolvedFailureCount ?? list(report.resolvedFailures).length,
    existingFailures: list(report.existingFailures),
    existingFailureCount: report.existingFailureCount ?? list(report.existingFailures).length,
    unchangedFailures: list(report.unchangedFailures),
    unchangedFailureCount: report.unchangedFailureCount ?? list(report.unchangedFailures).length,
    baseline: runView(report.baseline),
    current: runView(report.current),
    error: text(report.error) || null,
  };
}

/**
 * 合併後在正式分支重測的結果。分支比對通過只證明分支自己沒問題；
 * 兩邊各自都對、合起來壞掉（semantic conflict）只有這一步看得到。
 * @param {any} task
 */
export function mainTestView(task) {
  return testComparisonView({ completionTest: task?.completionMainTest });
}

/**
 * 重新啟動正式 TaskFlow 的狀態。只有 TaskFlow 自己這個專案才有這一段。
 *
 * 這件事不是主 server 自己做的：重啟會殺掉執行它的行程，所以請求寫進資料庫，
 * 由獨立的守護程式執行。畫面因此要能表達三種不同的等待：
 * 「排隊中」「執行中」「因為有 AI 工作在跑而延後」——最後一種不是失敗。
 * @param {any} task
 */
export function restartStatusView(task) {
  if (!task?.selfProject) return null;
  const request = task.completionRestart;
  const guardianOnline = task.guardianOnline !== false;
  const status = text(request?.status) || 'none';
  return {
    status,
    active: !!request?.active,
    guardianOnline,
    // 守護程式沒在跑就不可能從網頁重啟；照實說，並指出要去啟動哪一支。
    guardianNote: guardianOnline ? null : '找不到正在執行的 Service Guardian（守護程式），無法從網頁重新啟動正式 TaskFlow。請先在電腦上啟動 Start-Service-Guardian.ps1。',
    label: {
      none: '尚未重新啟動',
      pending: request?.note ? '已延後，稍後自動重試' : '排隊中，等待守護程式接手',
      running: '重新啟動中（先建置再重啟）',
      success: '已重新啟動並通過健康檢查',
      failed: '重新啟動未成功',
    }[status] || status,
    toneClass: { success: 'completed', failed: 'failed', running: 'queued', pending: 'queued' }[status] || 'queued',
    note: text(request?.note) || null,
    error: text(request?.error) || null,
    url: text(request?.url) || null,
    attempts: request?.attempts || 0,
    maxAttempts: request?.maxAttempts || 0,
    expectedCommit: shortCommit(request?.expectedCommit),
    requestedAt: text(request?.requestedAt) || null,
    finishedAt: text(request?.finishedAt) || null,
  };
}

/**
 * 遠端推送狀態。整條流程最後一個還會把人趕回終端機的步驟。
 *
 * 刻意的限制：這一段完全依賴後端上一次 fetch 的結果（開啟審核畫面不觸發網路操作），
 * 所以數字可能稍舊；真正按下推送時後端會自己先 fetch 再判斷。
 * @param {any} task
 * @param {any} review
 */
export function pushStatusView(task, review) {
  const remote = review?.remote;
  const pushed = task?.gitPush || review?.push || null;
  if (!remote) return null;
  if (!remote.configured) {
    return { configured: false, label: '沒有設定遠端', toneClass: 'queued', note: '這個專案沒有設定 origin，沒有可以推送的對象。', ahead: 0, behind: 0, pushed: null };
  }
  const ahead = Number.isInteger(remote.ahead) ? remote.ahead : null;
  const behind = Number.isInteger(remote.behind) ? remote.behind : null;
  return {
    configured: true,
    remote: text(remote.remote) || 'origin',
    baseBranch: text(remote.baseBranch) || text(task?.git?.baseBranch),
    url: text(remote.url) || null,
    ahead,
    behind,
    // 落後遠端是「要先自己處理」，不是失敗；說清楚 TaskFlow 不會替你選 merge 還是 rebase。
    blockedByBehind: (behind || 0) > 0,
    label: (behind || 0) > 0 ? `落後遠端 ${behind} 個 commit`
      : ahead === null ? '遠端尚無這個分支'
        : ahead > 0 ? `領先 ${remote.remote || 'origin'}/${remote.baseBranch} ${ahead} 個 commit`
          : '與遠端同步',
    toneClass: (behind || 0) > 0 ? 'paused' : ahead ? 'queued' : 'completed',
    note: (behind || 0) > 0
      ? `${remote.remote}/${remote.baseBranch} 有 ${behind} 個你本機還沒有的 commit。TaskFlow 不會替你決定要用 merge 還是 rebase，請先自行整合後再推送。`
      : ahead === null ? '遠端還沒有這個分支，或尚未 fetch 過；按下推送時後端會先 fetch 再判斷。' : null,
    pushed: pushed ? { remote: text(pushed.remote), baseBranch: text(pushed.baseBranch), count: pushed.count || 0, at: text(pushed.at) } : null,
  };
}

/**
 * 合併後的部署驗收（API 層 + Preview 程序生命週期）。沒跑過就回傳 null。
 *
 * 一個刻意的限制：這裡不把「三個 API 都回 200」講成「部署沒問題」。
 * Preview 程序沒有確認消失也算未通過，而且這一段完全不涵蓋畫面互動。
 * @param {any} task
 */
export function validationStatusView(task) {
  const report = task?.completionValidation;
  if (!report) return null;
  const checks = list(report.checks).map(item => ({
    name: text(item.name),
    label: {
      health: '/api/health',
      login: 'POST /api/login',
      state: '/api/state',
      preview_stopped: 'Preview 程序已結束',
    }[item.name] || text(item.name),
    passed: item.passed === true,
    expected: text(item.expected),
    actual: text(item.actual),
    detail: text(item.detail),
  }));
  const status = text(report.status);
  return {
    id: text(report.id),
    status,
    running: status === 'running',
    passed: report.passed === true,
    checks,
    failedCount: checks.filter(item => !item.passed).length,
    url: text(report.url) || null,
    pid: Number.isInteger(report.pid) ? report.pid : null,
    previewStopped: report.previewStopped === true,
    error: text(report.error) || null,
    note: text(report.note) || null,
    label: status === 'running' ? '驗收中'
      : status === 'interrupted' ? '已中斷'
        : status === 'failed' ? '未能執行'
          : report.passed === true ? '通過' : '未通過',
    toneClass: status === 'running' ? 'queued' : report.passed === true ? 'completed' : status === 'interrupted' ? 'paused' : 'failed',
  };
}

/**
 * 一次核准就依序跑完的部署流程。沒有核准過就回傳 null。
 *
 * 這裡只呈現後端狀態機的結果，不自己推導進度：哪一個階段在跑、哪一個失敗，
 * 由 server/completion-pipeline.js 決定，畫面不做第二套判斷。
 * @param {any} task
 */
export function pipelineView(task) {
  const pipeline = task?.completion;
  if (!pipeline) return null;
  const status = text(pipeline.status);
  return {
    id: text(pipeline.id),
    status,
    running: status === 'running',
    failed: status === 'failed',
    finished: status === 'completed',
    cancelled: status === 'cancelled',
    stage: text(pipeline.stage) || null,
    stages: list(pipeline.stages).map(item => ({
      key: text(item.key),
      label: text(item.label),
      ok: item.ok === true,
      current: item.current === true,
      failed: item.failed === true,
      note: text(item.note) || null,
      mark: item.ok ? STAGE_MARKS.done : item.failed ? STAGE_MARKS.failed : item.current ? STAGE_MARKS.active : STAGE_MARKS.pending,
      state: item.ok ? 'done' : item.failed ? 'failed' : item.current ? 'active' : 'pending',
    })),
    label: {
      running: '部署流程進行中',
      failed: '部署流程停在失敗階段',
      completed: '部署流程已完成',
      cancelled: '部署流程已停止',
    }[status] || status,
    toneClass: { running: 'queued', failed: 'failed', completed: 'completed', cancelled: 'cancelled' }[status] || 'queued',
    failure: pipeline.failure ? { stage: text(pipeline.failure.stage), message: text(pipeline.failure.message) } : null,
    note: text(pipeline.note) || null,
    approvedByName: text(pipeline.approvedByName) || null,
    approvedAt: text(pipeline.approvedAt) || null,
    finishedAt: text(pipeline.finishedAt) || null,
    artifactVersion: text(pipeline.artifactVersion) || null,
    // reconcileCompletionState 的權威判定（server/completion-state.js）：只有純文字說明，
    // 沒有伺服器磁碟路徑。畫面用它取代「自己再猜一次為什麼卡住」。
    blockingReasons: list(pipeline.blockingReasons).map(text).filter(Boolean),
    warnings: list(pipeline.warnings).map(text).filter(Boolean),
    evidence: list(pipeline.evidence).map(text).filter(Boolean),
    nextAction: text(pipeline.nextAction) || null,
  };
}

/**
 * 合併被擋住的所有原因。回傳空陣列＝後端目前的狀態允許合併。
 * 每一條都對應 server 端一個真實的守門，不是 UI 自己發明的規則。
 * @param {any} task
 * @param {any} review
 * @returns {{code:string,message:string,hint:string}[]}
 */
export function mergeBlockers(task, review) {
  const blockers = [];
  if (!task) return blockers;

  if (task.gitMerge) {
    blockers.push({
      code: 'already_merged',
      message: `此任務已於稍早合併至 ${text(task.gitMerge.baseBranch) || '正式分支'}（${shortCommit(task.gitMerge.commit)}）。`,
      hint: '同一個任務不會重複合併。若要撤銷，請使用下方的撤銷合併。',
    });
    return blockers;
  }

  // 防禦層，不是狀態來源：ready_to_close／closed 一律由後端的 task.status 決定
  // （見下方 completionView 的 state 計算），這裡不會、也不能自己把畫面切換成
  // ready_to_close。它處理的是另一件事——GET /git/review 已經即時偵測到分支被
  // 外部合併，Server 也已經把這個事實持久化，但使用者手上的 task 物件可能還沒
  // 重新抓到最新的 status（那幾秒鐘的正常落差）。這裡先擋住「核准並合併」，避免
  // 使用者按下一個註定會被後端以 409（此分支的內容已經在正式分支上了）拒絕的按鈕。
  if (review?.externallyMerged) {
    blockers.push({
      code: 'externally_merged',
      message: '此分支的內容已經在外部被合併，不需要（也不能）再次核准合併。',
      hint: '請重新整理後改用「關閉任務」；TaskFlow 已經確認合併結果並記錄。',
    });
    return blockers;
  }

  // 後端 mergeDecision 的第一道檢查：只有通過獨立驗證而完成的任務能合併。
  if (task.status !== 'completed') {
    blockers.push({
      code: 'not_completed',
      message: '任務尚未完成獨立驗證，還不能合併。',
      hint: '驗證通過後這裡會自動出現核准按鈕。',
    });
  } else if (task.manualCompletion) {
    blockers.push({
      code: 'manual_completion',
      message: '此任務是由人手動標記完成的，不代表通過 AI 驗收，因此不提供合併。',
      hint: '若確定要把這個分支併進正式分支，請自行在終端機確認後執行。',
    });
  }

  if (task.status === 'completed' && !task.manualCompletion && !text(task.artifactVersion)) {
    blockers.push({
      code: 'no_artifact_version',
      message: '找不到可核准的成果版本。',
      hint: '請重新整理任務後再試。',
    });
  }

  // 測試比對：只有「確定有新的失敗」會擋住合併。讀不懂結果或拿不到基準是另一回事，
  // 那要顯示為警告讓人自己判斷，不能無聲放行、也不該假裝是 regression。
  const test = testComparisonView(task);
  if (test?.running) {
    blockers.push({
      code: 'test_running',
      message: '測試比對正在執行中，請等它跑完再合併。',
      hint: '結果會自己更新，不必重新整理頁面。',
    });
  } else if (test?.blocks) {
    blockers.push({
      code: 'test_regression',
      message: `測試比對發現 ${test.newFailureCount} 項在 ${text(test.baseBranch) || '正式分支'} 上原本不存在的失敗：${test.newFailures.slice(0, 3).join('、')}${test.newFailureCount > 3 ? ' …' : ''}`,
      hint: '請先修正這些失敗（或補充需求交給 AI 修正），再重新執行比對。',
    });
  }

  const conflict = review?.conflict || task.gitConflict;
  if (conflict) {
    blockers.push({
      code: 'conflict',
      message: `合併 ${text(conflict.workingBranch) || '任務分支'} 會產生衝突，已停止：${list(conflict.files).join('、') || '（未列出檔案）'}`,
      hint: text(conflict.hint) || 'TaskFlow 不會自行決定 ours／theirs。請在專案目錄手動處理衝突後再回來，或改為要求 AI 修改。',
    });
  }

  // 後端 assertMergeReady()：正式分支必須被 check out、而且工作樹乾淨。
  if (review?.repositoryError) {
    blockers.push({
      code: 'repository_error',
      message: `無法讀取專案目前的 Git 狀態：${text(review.repositoryError)}`,
      hint: '讀不到狀態時一律不合併，不會假設專案是乾淨的。',
    });
  } else if (review?.repository) {
    const repository = review.repository;
    if (repository.onBaseBranch === false) {
      blockers.push({
        code: 'not_on_base_branch',
        message: `合併前專案目錄必須停在 ${text(review.baseBranch) || 'main'}，目前在 ${text(repository.branch) || 'detached HEAD'}。`,
        hint: 'TaskFlow 不會替你切換分支，請先自行切換後再核准。',
      });
    }
    if (repository.clean === false) {
      const files = list(repository.dirty);
      blockers.push({
        code: 'dirty_working_tree',
        message: `${text(repository.branch) || '正式分支'} 目前有未提交修改，已停止合併${files.length ? `：${files.slice(0, 5).join('、')}${files.length > 5 ? ' …' : ''}` : '。'}`,
        hint: 'TaskFlow 不會 reset、clean、stash 或覆蓋這些內容，請你自己先處理。',
      });
    }
  }

  return blockers;
}

/**
 * 合併與清理的階段清單。只由真實資料推導，無法判斷的一律 pending。
 * @param {any} task
 * @param {any} review
 */
export function completionStages(task, review) {
  const stages = [];
  const commits = list(review?.commits);
  const validation = list(review?.validation);

  stages.push(commits.length
    ? stage('implementation', '實作與階段 commit', 'done', `${commits.length} 個 commit`)
    : review?.cleanedUp
      ? stage('implementation', '實作與階段 commit', 'done', '工作副本已清理，commit 清單不再讀取')
      : stage('implementation', '實作與階段 commit', 'pending', '尚未產生 commit'));

  const reviewThread = validation.filter(v => v.phase === 'review').at(-1);
  stages.push(reviewThread
    ? stage('review', '獨立驗證', reviewThread.passed === true ? 'done' : reviewThread.passed === false ? 'failed' : 'pending',
      reviewThread.browserValidation ? `Browser 驗證：${reviewThread.browserValidation}` : '')
    : stage('review', '獨立驗證', task?.status === 'completed' ? 'done' : 'pending'));

  const test = testComparisonView(task);
  stages.push(!test
    ? stage('test', '測試比對（基準 vs 分支）', 'pending', '尚未比對')
    : test.running
      ? stage('test', '測試比對（基準 vs 分支）', 'active', '執行中，可能需要數分鐘')
      : test.verdict === 'no_regression'
        ? stage('test', '測試比對（基準 vs 分支）', 'done', `沒有新的失敗（既有 ${test.baseline?.failedCount ?? 0} 項）`)
        : test.verdict === 'regression'
          ? stage('test', '測試比對（基準 vs 分支）', 'failed', `${test.newFailureCount} 項新的失敗`)
          : stage('test', '測試比對（基準 vs 分支）', 'blocked', test.verdictLabel || test.error || '尚未取得結果'));

  const base = text(review?.baseBranch) || text(task?.git?.baseBranch) || 'main';
  const blockers = mergeBlockers(task, review);
  const conflicted = blockers.some(b => b.code === 'conflict');
  stages.push(task?.gitMerge
    ? stage('merge', `合併到 ${base}`, 'done', shortCommit(task.gitMerge.commit))
    : conflicted
      ? stage('merge', `合併到 ${base}`, 'failed', '偵測到衝突，已停止')
      : blockers.length
        ? stage('merge', `合併到 ${base}`, 'blocked', blockers[0].message)
        : stage('merge', `合併到 ${base}`, 'pending', '等待你核准'));

  const mainTest = mainTestView(task);
  stages.push(!mainTest
    ? stage('test_main', '合併後在正式分支重測', 'pending', task?.gitMerge ? '合併後可執行' : '合併後才需要')
    : mainTest.running
      ? stage('test_main', '合併後在正式分支重測', 'active', '執行中')
      : mainTest.verdict === 'no_regression'
        ? stage('test_main', '合併後在正式分支重測', 'done', '合併沒有造成新的失敗')
        : mainTest.verdict === 'regression'
          ? stage('test_main', '合併後在正式分支重測', 'failed', `${mainTest.newFailureCount} 項新的失敗`)
          : stage('test_main', '合併後在正式分支重測', 'blocked', mainTest.verdictLabel || mainTest.error || '尚未取得結果'));

  // 重新啟動只在 TaskFlow 自己這個專案才是流程的一部分；別的專案顯示這一列只會誤導。
  const restart = restartStatusView(task);
  if (restart) {
    stages.push(restart.status === 'success'
      ? stage('restart', '重新啟動正式 TaskFlow', 'done', restart.expectedCommit ? `版本 ${restart.expectedCommit}` : '')
      : restart.status === 'running'
        ? stage('restart', '重新啟動正式 TaskFlow', 'active', '先建置再重啟')
        : restart.status === 'pending'
          ? stage('restart', '重新啟動正式 TaskFlow', 'active', restart.note || '排隊中')
          : restart.status === 'failed'
            ? stage('restart', '重新啟動正式 TaskFlow', 'failed', restart.error || '未成功')
            : stage('restart', '重新啟動正式 TaskFlow', 'pending', task?.gitMerge ? '等待你核准' : '合併後才需要'));
  }

  // 部署驗收只在合併之後才有意義（驗的是合併後的正式分支）。
  // 變數名刻意不叫 validation：這個函式上面已經有一個 validation，那是各階段的「獨立驗證」結果。
  const deployment = validationStatusView(task);
  stages.push(!deployment
    ? stage('validate', '部署驗收（API 與程序）', 'pending', task?.gitMerge ? '合併後可執行' : '合併後才需要')
    : deployment.running
      ? stage('validate', '部署驗收（API 與程序）', 'active', '建立 Preview、驗證 API、停止並確認程序結束')
      : deployment.status === 'interrupted'
        ? stage('validate', '部署驗收（API 與程序）', 'blocked', deployment.error || '已中斷')
        : deployment.passed
          ? stage('validate', '部署驗收（API 與程序）', 'done', `${deployment.checks.length} 項全部通過`)
          : stage('validate', '部署驗收（API 與程序）', 'failed', `${deployment.failedCount} 項未通過`));

  // 清理不再是合併的一部分：worktree／分支要留到使用者按下「關閉任務」才會消失
  // （計畫書第十九、二十一章），所以合併完成但還沒關閉時這裡仍然是 pending，不是 done。
  stages.push(review?.cleanedUp || task?.git?.cleanedUp
    ? stage('cleanup', '清理工作副本與分支', 'done', task?.git?.branchDeleted ? '已移除 worktree 並刪除任務分支' : '已移除 worktree')
    : stage('cleanup', '清理工作副本與分支', 'pending', task?.gitMerge ? '關閉任務後執行' : '合併成功後才需要'));

  return stages;
}

/**
 * 部署與驗收區塊要顯示的全部內容。沒有可顯示的東西就回傳 null。
 * @param {any} task 由 /api/tasks/:id 取得的任務
 * @param {any} review 由 /api/tasks/:id/git/review 取得的審核資料；尚未載入時為 null
 */
export function completionView(task, review = null) {
  if (!completionAvailable(task)) return null;

  const git = task.git || {};
  const blockers = mergeBlockers(task, review);
  const conflicted = blockers.some(b => b.code === 'conflict');
  const merged = !!task.gitMerge;
  const rolledBack = !!task.gitRollback;
  const loaded = !!review && review.available !== false;
  // 還沒讀到 review 就不能說「可以合併」：正式分支乾不乾淨只有那支 API 知道。
  const canMerge = loaded && !merged && !blockers.length;
  const pipeline = pipelineView(task);
  const mainTest = mainTestView(task);
  const pushView = pushStatusView(task, review);

  // ready_to_close／closed 一律由後端的 task.status 決定，前端不自己判斷這兩個狀態
  // 什麼時候該出現（計畫書第二十八章）。舊資料（合併發生在這次改造之前、status 還停在
  // completed）仍然落回原本的 merged／rolled_back 判斷，畫面不會因此壞掉。
  const state = task.status === 'closed' ? 'closed'
    : task.status === 'ready_to_close' ? 'ready_to_close'
      : merged ? (rolledBack ? 'rolled_back' : 'merged')
        : conflicted ? 'conflict'
          : !loaded ? 'loading'
            : blockers.length ? 'blocked'
              : 'ready';

  const title = {
    ready: '此任務已完成開發，可以進行合併',
    blocked: '尚不能合併',
    conflict: '合併被衝突擋住',
    merged: '已合併至正式分支',
    ready_to_close: '已合併，等待你關閉任務',
    closed: '任務已關閉',
    rolled_back: '此次合併已撤銷',
    loading: '正在讀取 Git 狀態',
  }[state];

  const message = {
    ready: `核准後 TaskFlow 會執行 git merge --no-ff，把 ${text(git.workingBranch)} 併入 ${text(git.baseBranch)}，並保留一個明確的 merge commit。`,
    blocked: '以下每一項都必須先解決；TaskFlow 不會繞過任何一項。',
    conflict: 'TaskFlow 不會替你選 ours／theirs，也不會把正式分支留在解到一半的 merge 狀態。',
    merged: '成果已在正式分支上。若要撤銷，TaskFlow 會補一個反向 commit，不會刪除任何歷史。',
    ready_to_close: '技術交付流程已完成：成果已在正式分支上。按下「關閉任務」後 TaskFlow 才會停止相關 Preview、移除 worktree 並刪除已合併的分支；TaskFlow 不會自己關閉這個任務。',
    closed: '任務生命週期已正式結束。原始需求、計畫、執行紀錄、commits 與合併紀錄仍完整保留，只是預設不再出現在使用中的任務清單。',
    rolled_back: '已在正式分支補上反向 commit；歷史完整保留。',
    loading: '正在讀取正式分支目前的狀態，讀到之前不會顯示可否合併。若遲遲沒有結果，請按下方的重新讀取。',
  }[state];

  return {
    state,
    badgeClass: BADGE_CLASSES[state] || 'queued',
    title,
    message,
    scopeNote: COMPLETION_SCOPE_NOTE,
    branch: {
      base: text(git.baseBranch),
      working: text(git.workingBranch),
      baseCommit: shortCommit(git.baseCommit),
      headCommit: shortCommit(git.headCommit),
    },
    repository: review?.repository || null,
    repositoryError: text(review?.repositoryError) || null,
    // 只在還需要重新評估整合的階段（尚未到 ready_to_close／closed）才顯示「正式分支
    // 已在任務執行期間更新」；一旦整合已經確認完成，即使 review.mainAdvanced 歷史上
    // 曾經是 true，也不再顯示，避免使用者誤以為還需要重新 Merge（計畫書第九章、
    // 第二輪修正驗收條件）。
    mainAdvanced: !['ready_to_close', 'closed'].includes(state) && !!review?.mainAdvanced,
    mainHead: shortCommit(review?.mainHead),
    commits: list(review?.commits).map(c => ({
      commit: text(c.commit),
      short: shortCommit(c.commit),
      subject: text(c.subject),
      at: text(c.at),
    })),
    stages: completionStages(task, review),
    blockers,
    guarantees: MERGE_GUARANTEES,
    merge: task.gitMerge ? { ...task.gitMerge, short: shortCommit(task.gitMerge.commit), at: text(task.gitMerge.at) } : null,
    rollback: task.gitRollback || null,
    conflict: review?.conflict || task.gitConflict || null,
    cleanedUp: !!(review?.cleanedUp || git.cleanedUp),
    // 合併要帶著成果版本送出，後端會比對，不符就拒絕（避免核准的是舊版成果）。
    artifactVersion: text(task.artifactVersion) || null,
    pipeline: pipelineView(task),
    test: testComparisonView(task),
    mainTest,
    // 合併之後才有對象可以重測；執行中不能重複觸發。
    canRunMainTest: merged && !mainTest?.running && !pipeline?.running,
    restart: restartStatusView(task),
    validation: validationStatusView(task),
    push: pushStatusView(task, review),
    // 只有合併完成、遠端存在、沒有落後、而且真的有東西要推時才給按鈕。
    canPush: merged && !pipeline?.running && !!pushView && pushView.configured && !pushView.blockedByBehind && (pushView.ahead === null || pushView.ahead > 0),
    // 驗的是合併後的正式分支，所以合併之前不提供；執行中不能重複觸發。
    canValidate: merged && !validationStatusView(task)?.running && !pipelineView(task)?.running,
    // 只有「合併完成、守護程式活著、目前沒有重啟在進行」時才給按鈕。
    canRestart: !!task.selfProject && merged && task.guardianOnline !== false && !restartStatusView(task)?.active && !pipelineView(task)?.running,
    // 一次核准就依序跑完；出現的時機與「可以合併」完全一致。
    // 停在失敗階段時不再提供「核准並完成」：該做的是重試或停止，不是再開一條。
    canApprovePipeline: canMerge && !pipeline?.running && !pipeline?.failed,
    // 流程進行中時，單顆按鈕一律停用：兩條路徑同時對同一個任務動作只會互相打架。
    // 工作副本被清掉或已經合併之後再跑測試沒有意義；執行中也不能重複觸發。
    canRunTest: !merged && !(review?.cleanedUp || git.cleanedUp) && !testComparisonView(task)?.running && !pipelineView(task)?.running,
    // 流程進行中時單獨合併會與流程互搶，一律停用。
    canMerge: canMerge && !pipeline?.running,
    // Closed 是 archive：不再提供撤銷，避免使用者對一個已經結案的任務做出「改動 main」的動作。
    canRollback: merged && !rolledBack && !!text(task.gitMerge?.commit) && state !== 'closed',
    // 唯一會把任務從 ready_to_close 推進到 closed 的按鈕；只有使用者主動按下才會發生
    // （計畫書第十七章），不會因為合併成功或部署驗收通過就自動出現在別的狀態。
    canClose: state === 'ready_to_close' && !pipeline?.running,
    // 一律是字串（沒有就是空字串）：撤銷按鈕的事件型別才不會變成 string|null。
    mergeCommit: text(task.gitMerge?.commit),
  };
}
