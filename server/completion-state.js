// Authoritative Completion State：把「completed／passed」的最終判定收斂到一個地方。
//
// 現況（這個模組要取代或包住的既有判斷路徑，之後串接時逐一比對）：
//
//   1. server/runner.js applyPhaseResult() 的 review 分支：
//        `if(result.passed&&result.evidence.length&&!result.questions.length){t.status='completed';...}`
//        只看 AI 自己回傳的 passed/evidence/questions，沒有檢查 Git 衝突、工作樹、
//        測試 regression、部署驗收等 deterministic evidence。
//   2. server/completion-pipeline.js 的各 stage handler（testStage／mergeStage／
//        testMainStage／restartStage／validateStage／pushStage／cleanupStage）與
//        advanceCompletion()：每個階段各自用 if/else 決定 done／failed／waiting，
//        並把整條 pipeline 的完成與否放在 `task.completion.status`，
//        沒有統一的 blockingReasons/warnings/evidence/nextAction 輸出格式。
//   3. server/git-review.js 的 mergeDecision()：
//        `if (t.status !== 'completed' || t.manualCompletion) throw ...`
//        把 task.status==='completed'（也就是第 1 點寫入的狀態）當成唯一的合併前置條件。
//   4. server/completion-test.js／completion-validation.js：
//        `report.status`（running/completed/failed/interrupted）與各自的
//        `verdict`／`passed` 欄位，是本模組 tests／runtime 證據的來源，
//        但兩個檔案本身沒有跨模組共用的「是否阻擋完成」語意。
//   5. server/manual-action.js decideManualAction() 的 skip 分支：
//        `if(ua.phase==='review'){task.status='completed';...}` 使用者略過手動操作時，
//        同樣只看這個略過決定本身，沒有回頭檢查其餘 evidence。
//
// reconcileCompletionState(context) 是這些判斷之後要共同呼叫的單一權威入口：
//   - 純函式，不做任何檔案／Git／HTTP I/O，也不重新執行任何工作（不重跑測試、
//     不重新呼叫 AI）；只讀取呼叫端已經算好、放進 context 的證據。
//   - 任一證據類別在 context 裡缺席（舊任務資料、尚未跑到那個階段）一律視為
//     「不適用／尚未執行」，寫進 warnings，不直接判定 failed，也不能讓它單獨
//     促成 completed——completed 需要「其餘必要類別都通過或不適用，且沒有任何
//     阻擋」，缺席本身不是通過。
//   - AI／Executor／Reviewer 回傳的 passed/questions/evidence 只是 context.executorResult
//     這一項 claim，是否 completed 由這裡與其他 deterministic 證據一起重新核算，
//     不是直接採信。

/** reconcileCompletionState() 允許回傳的狀態，僅限這十一種。 */
export const COMPLETION_STATUSES = [
  'running', 'awaiting_user', 'conflicted', 'testing', 'awaiting_approval',
  'merging', 'deploying', 'verifying', 'completed', 'failed', 'blocked',
];

const NEXT_ACTIONS = {
  running: '部署流程已核准但尚未進入特定階段，請稍候下一次推進。',
  awaiting_user: '需要使用者處理待確認事項（Git 修改、手動操作、成果報告問題或待回答問題）後才能繼續。',
  conflicted: '需要先解決 Git 合併衝突，衝突未解決前不得合併或視為完成。',
  testing: '等待測試比對（分支或合併後重測）執行完成。',
  awaiting_approval: '需要使用者核准修正方案後才能繼續修正。',
  merging: '等待合併到正式分支完成。',
  deploying: '等待部署流程（重新啟動、推送、清理）完成。',
  verifying: '等待部署驗收（preview/runtime）或 Browser Validation 完成。',
  completed: '所有必要的 deterministic 檢查皆已通過或不適用，且沒有待處理事項，可視為完成。',
  failed: '有 deterministic 證據（測試 regression、部署階段失敗、驗收未通過等）證明未成功，需要修正後重新執行失敗的檢查。',
  blocked: '目前的 claim 與 evidence 不足以判定完成，也沒有 deterministic 證據證明失敗；需要補足 evidence 或處理阻擋事項。',
};

const list = value => Array.isArray(value) ? value : [];

/**
 * 權威的完成狀態判定。
 *
 * @param {{
 *   executorResult?: {passed?: boolean, questions?: string[], evidence?: string[], summary?: string} | null,
 *   git?: {workingTreeClean?: boolean, headCommit?: string|null, gitMerge?: {commit?: string, baseBranch?: string}|null, gitConflict?: {files?: string[]}|null},
 *   tests?: {completionTest?: TestReport|null, completionMainTest?: TestReport|null},
 *   deployment?: {status?: string, stage?: string|null, results?: Record<string, any>, failure?: {stage?: string, message?: string}|null} | null,
 *   runtime?: {completionValidation?: {status?: string, passed?: boolean, checks?: {name?: string, description?: string, passed: boolean}[]}|null},
 *   browserValidation?: {required?: boolean, executed?: boolean, passed?: boolean|null, status?: string, error?: string|null, notes?: string}|null,
 *   pendingActions?: {userActionRequired?: boolean, questions?: boolean, gitIssue?: boolean, outputIssue?: boolean, repairApproval?: boolean},
 * }} context 只接收呼叫端已經算好的證據，這個函式本身不讀取任何檔案或執行任何 Git／HTTP 操作。
 * @returns {{status: string, passed: boolean, blockingReasons: string[], warnings: string[], evidence: string[], nextAction: string}}
 *
 * TestReport = {status?: string, verdict?: 'no_regression'|'regression'|'baseline_unavailable'|'parse_failed'|null, newFailures?: string[], newFailureCount?: number}
 */
export function reconcileCompletionState(context = {}) {
  const blockingReasons = [];
  const warnings = [];
  const evidence = [];
  // 只有這些類別是「有 deterministic 證據證明失敗」，會把 status 導向 failed；
  // executor 自己回報 passed=false／有問題／缺 evidence 不算——那只是一份尚未證實的 claim，
  // 缺乏證據並不等於證明失敗，導向 blocked。
  let deterministicFailure = false;

  const block = message => { if (message) blockingReasons.push(message); };
  const warn = message => { if (message) warnings.push(message); };
  const proof = message => { if (message) evidence.push(message); };

  // ---- executor / reviewer 的 claim（只是 claim，不是最終依據）-------------
  const exec = context.executorResult;
  if (exec && typeof exec === 'object') {
    proof(`executor／reviewer 回報 passed=${exec.passed === true}`);
    if (exec.passed !== true) block('executor／reviewer 尚未回報 passed=true。');
    if (list(exec.questions).length) block(`AI 提出待確認問題，尚未能視為完成：${list(exec.questions).join('；')}`);
    if (!list(exec.evidence).length) block('executor／reviewer 沒有提供任何 evidence，AI 的 claim 不能單獨作為完成依據。');
  } else {
    block('沒有 executor／reviewer 的回傳結果，無法核對 claim 與 evidence，不能判定完成。');
  }

  // ---- Git 工作樹／commit／merge／conflict --------------------------------
  const git = context.git || {};
  const hasConflict = !!git.gitConflict;
  if (hasConflict) {
    const files = list(git.gitConflict.files);
    block(`Git 合併會產生衝突：${files.join('、') || '（未列出檔案）'}`);
  } else if (git.gitConflict === undefined) {
    warn('沒有 Git 衝突檢查結果（不適用或尚未執行）。');
  }
  if (git.workingTreeClean === false) warn('Git 工作樹有尚未提交的修改。');
  else if (git.workingTreeClean === undefined) warn('沒有 Git 工作樹狀態（不適用或尚未執行）。');
  if (git.headCommit) proof(`目前 head commit：${git.headCommit}`);
  else warn('沒有可用的 Git commit 記錄（不適用或尚未執行）。');
  if (git.gitMerge) proof(`已合併到正式分支：${git.gitMerge.commit || git.gitMerge.baseBranch || ''}`.trim());

  // ---- 測試比對／合併後重測 -------------------------------------------------
  let testsRunning = false;
  for (const [key, label] of [['completionTest', '測試比對'], ['completionMainTest', '合併後重測']]) {
    const report = context.tests?.[key];
    if (!report) { warn(`沒有${label}結果（不適用或尚未執行）。`); continue; }
    if (report.status === 'running') { block(`${label}仍在執行中。`); testsRunning = true; continue; }
    if (report.status && !['completed'].includes(report.status)) {
      block(`${label}沒有完成（${report.status}）。`);
      deterministicFailure = true;
      continue;
    }
    if (report.verdict === 'regression') {
      const count = report.newFailureCount ?? list(report.newFailures).length;
      block(`${label}發現 ${count} 項新的失敗：${list(report.newFailures).slice(0, 10).join('、') || '（未列出項目）'}`);
      deterministicFailure = true;
    } else if (report.verdict === 'baseline_unavailable' || report.verdict === 'parse_failed') {
      warn(`${label}${report.verdict === 'baseline_unavailable' ? '沒有可用的比對基準' : '無法判讀測試結果'}，未能證明沒有 regression。`);
    } else if (report.verdict === 'no_regression') {
      proof(`${label}沒有新的失敗。`);
    }
  }

  // ---- 部署 pipeline（測試比對／合併／重測／重啟／驗收／推送／清理）----------
  const deployment = context.deployment;
  let deploymentStageHint = null;
  let deploymentRunning = false;
  if (deployment) {
    if (deployment.failure) {
      block(`部署流程在「${deployment.failure.stage || '未知階段'}」失敗：${deployment.failure.message || '原因不明'}`);
      deterministicFailure = true;
    } else if (deployment.status === 'running') {
      deploymentRunning = true;
      const stage = deployment.stage || null;
      block(`部署流程仍在執行「${stage || '未知階段'}」。`);
      deploymentStageHint = !stage ? 'running'
        : stage === 'merge' ? 'merging'
        : stage === 'validate' ? 'verifying'
        : (stage === 'test' || stage === 'test_main') ? 'testing'
        : 'deploying';
    } else if (deployment.status === 'completed') {
      proof('部署流程（測試比對／合併／重測／重啟／驗收／推送／清理）已全部完成。');
    } else if (deployment.status === 'failed') {
      block(`部署流程失敗：${deployment.failure?.message || '原因不明'}`);
      deterministicFailure = true;
    } else if (deployment.status) {
      warn(`部署流程狀態為 ${deployment.status}，尚未確認完成。`);
    }
  } else {
    warn('沒有部署流程（completion pipeline）結果（不適用或尚未核准部署）。');
  }

  // ---- 部署驗收（preview/runtime）----------------------------------------
  const runtime = context.runtime?.completionValidation;
  let runtimeRunning = false;
  if (runtime) {
    if (runtime.status === 'running') { block('部署驗收（preview/runtime）仍在執行中。'); runtimeRunning = true; }
    else if (runtime.status && runtime.status !== 'completed') {
      block(`部署驗收沒有完成（${runtime.status}）。`);
      deterministicFailure = true;
    } else if (runtime.passed !== true) {
      const failedChecks = list(runtime.checks).filter(c => c && c.passed !== true).map(c => c.name || c.description).filter(Boolean);
      block(`部署驗收未通過：${failedChecks.join('、') || '（未列出項目）'}`);
      deterministicFailure = true;
    } else {
      proof(`部署驗收通過（${list(runtime.checks).length} 項檢查）。`);
    }
  } else {
    warn('沒有部署驗收（preview/runtime）結果（不適用或尚未執行）。');
  }

  // ---- Browser Validation --------------------------------------------------
  const browser = context.browserValidation;
  if (browser && browser.required) {
    if (!browser.executed || browser.passed !== true) {
      block(`Browser Validation 未通過：${browser.error || browser.notes || '未確認實際互動與結果'}`);
      deterministicFailure = true;
    } else {
      proof('Browser Validation 已實際執行並通過。');
    }
  } else if (!browser) {
    warn('沒有 Browser Validation 結果（不適用或尚未執行）。');
  }
  // browser && browser.required === false：這個任務不需要 Browser Validation，不列警告也不列 evidence。

  // ---- 待使用者處理的事項 ---------------------------------------------------
  const pending = context.pendingActions || {};
  if (pending.gitIssue) block('Git 工作樹有未處理的確認事項（未提交修改／受保護分支等），需要使用者先處理。');
  if (pending.userActionRequired) block('有需要使用者在本機執行的操作尚未完成。');
  if (pending.outputIssue) block('AI 回傳的結構化輸出格式有問題，尚待使用者處理。');
  if (pending.questions) block('仍有待使用者回答的問題。');
  if (pending.repairApproval) block('修正方案尚待使用者核准，核准前不會修正。');
  const awaitingUser = !!(pending.gitIssue || pending.userActionRequired || pending.outputIssue || pending.questions);
  const awaitingApproval = !!pending.repairApproval;

  const passed = blockingReasons.length === 0;

  let status;
  if (hasConflict) status = 'conflicted';
  else if (testsRunning) status = 'testing';
  else if (deploymentRunning && deploymentStageHint === 'merging') status = 'merging';
  else if (deploymentRunning && deploymentStageHint === 'verifying') status = 'verifying';
  else if (deploymentRunning && deploymentStageHint === 'testing') status = 'testing';
  else if (deploymentRunning && deploymentStageHint === 'deploying') status = 'deploying';
  else if (runtimeRunning) status = 'verifying';
  else if (deploymentRunning) status = 'running';
  else if (awaitingApproval) status = 'awaiting_approval';
  else if (awaitingUser) status = 'awaiting_user';
  else if (deterministicFailure) status = 'failed';
  else if (blockingReasons.length) status = 'blocked';
  else status = 'completed';

  return {
    status,
    passed: passed && status === 'completed',
    blockingReasons,
    warnings,
    evidence,
    nextAction: NEXT_ACTIONS[status],
  };
}
