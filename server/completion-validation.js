// 合併之後的部署驗收：在合併後的正式分支上開一個 Preview，做結構化 API 驗收，
// 然後停掉它並**確認那個 PID 真的消失**。
//
// 為什麼驗的是 Preview 而不是正在跑的正式服務：驗收要登入才做得完，而正式服務只有
// 真實使用者的帳號。Preview 有自己的資料庫與一次性測試帳密（server/project-preview.js），
// 驗完就消失，不會在正式資料裡留下測試痕跡，也不會用到任何真實帳密。
//
// 為什麼驗的是「專案目錄」而不是任務的 worktree：合併之後，正式分支上的內容才是
// 實際要上線的東西；驗 worktree 等於驗一份已經沒有人會執行的副本。
//
// 三個不可妥協的原則：
//   1. Preview 停止後 PID 還在，本次驗收一律不得判定通過（就算三個 API 都回 200）。
//   2. 驗收做不到的項目標成未通過，不是略過。
//   3. 這一段不取代 Browser Validation：它只證明 API 層活著，不證明畫面可以操作。
import {existsSync} from 'node:fs';
import {id, now} from './db.js';
import {HttpError, requireTask} from './domain.js';
import {validateDeployment} from './deployment-validation.js';
import {waitForExit} from './process-lifecycle.js';
import {reconcileCompletionState, taskCompletionContext} from './completion-state.js';

const MAX_LISTED_CHECKS = 20;

export const VALIDATION_SCOPE_NOTE =
  '這是 API 層的結構化驗收（/api/health、/api/login、/api/state）與 Preview 程序的生命週期確認，不包含實際的畫面互動。';

/** 送到瀏覽器的版本：只有結論與證據，沒有帳密，也沒有伺服器磁碟路徑。 */
export function completionValidationPublic(task) {
  const report = task?.completionValidation;
  if (!report) return null;
  return {
    id: report.id,
    status: report.status,
    passed: report.passed === true,
    url: report.url || null,
    pid: report.pid ?? null,
    previewStopped: report.previewStopped === true,
    checks: (report.checks || []).slice(0, MAX_LISTED_CHECKS),
    // 失敗在哪一層、是哪一種失敗、該算在誰頭上。這三件事以前只能從一句中文猜。
    // 這裡送出的欄位都是結論與代碼，沒有 password／token／cookie。
    state: report.state || null,
    authentication: report.authentication ? {
      required: report.authentication.required === true,
      attempted: report.authentication.attempted === true,
      passed: report.authentication.passed === true,
      mode: report.authentication.mode || null,
      endpoint: report.authentication.endpoint || null,
      status: report.authentication.status ?? null,
      sessionType: report.authentication.sessionType || null,
      failureCode: report.authentication.failureCode || null,
      failureCategory: report.authentication.failureCategory || null,
      diagnostic: report.authentication.diagnostic || null,
    } : null,
    apiState: report.apiState ? {
      attempted: report.apiState.attempted === true,
      passed: report.apiState.passed === true,
      status: report.apiState.status ?? null,
      skippedReason: report.apiState.skippedReason || null,
    } : null,
    startedAt: report.startedAt || null,
    finishedAt: report.finishedAt || null,
    error: report.error || null,
    note: VALIDATION_SCOPE_NOTE,
  };
}

/** 被服務重啟打斷的驗收不能留在 running，否則畫面永遠停在執行中。 */
export function recoverCompletionValidations(store) {
  for (const task of store.tasks()) {
    if (task.completionValidation?.status !== 'running') continue;
    task.completionValidation = {
      ...task.completionValidation,
      status: 'interrupted',
      finishedAt: now(),
      passed: false,
      error: '上次的部署驗收在服務重新啟動時中斷，尚未取得結果。請重新執行。',
    };
    store.saveTask(task);
    store.event(task.id, 'completion_validation_interrupted', task.completionValidation.error);
  }
}

export function createCompletionValidations({ previews, validate = validateDeployment, wait = waitForExit } = {}) {
  const running = new Map();

  async function run(store, taskId) {
    const task = store.task(taskId);
    const project = store.project(task.projectId);
    // Preview 的 key 沿用既有的「原始專案」目標，與網頁上手動預覽同一個：
    // 同一個專案不會因此同時跑起兩個 Preview。
    const key = project.id;
    const info = await previews.start(key, project.path);
    const checks = [];
    let report = null;
    try {
      // 同一個 AcceptanceContext：Preview 注入的那一組身份，就是 validator 登入用的那一組。
      // credentials 只是舊呼叫端的相容形狀，值同樣來自這個 context，不是另外產生的第二組。
      report = await validate({ url: info.url, acceptance: info.acceptance || null, credentials: info.credentials || null });
      checks.push(...report.checks);
    } finally {
      // 不論驗收結果如何都要把 Preview 停掉，否則它會一直佔著連接埠與暫存資料庫。
      await previews.stop(key).catch(() => {});
    }

    // 生命週期驗證：PID 還在就不算停止，本次驗收也不得判定通過。
    const stopped = info.pid ? await wait(info.pid, { timeoutMs: 15000 }) : true;
    checks.push({
      name: 'preview_stopped',
      method: '—',
      path: info.pid ? `PID ${info.pid}` : '（沒有子程序）',
      expected: 'Preview 程序已結束',
      actual: stopped ? '已結束' : '仍然存在',
      passed: stopped,
      detail: stopped ? '' : '停止指令已送出，但這個 PID 仍然存在；在確認它消失之前，本次驗收不得判定通過。',
    });

    // 結構化結果：UI 與 AI 不必再去解析自然語言，才知道失敗在哪一層、該算在誰頭上。
    return {
      url: info.url,
      pid: info.pid ?? null,
      previewStopped: stopped,
      checks,
      passed: !!report?.passed && stopped,
      state: !stopped && report?.passed ? 'PREVIEW_NOT_STOPPED' : report?.state || null,
      health: report?.health || null,
      authentication: report?.authentication || null,
      apiState: report?.apiState || null,
    };
  }

  // 部署驗收是 group-level 的最後一道 deterministic 檢查。驗收沒有通過時，任務不能繼續
  // 停留在 completed，否則畫面會同時出現「部署驗收未通過」與「任務已完成」兩個互相矛盾的
  // 狀態。這裡不自己判斷，而是把任務目前握有的全部證據交給 reconcileCompletionState 重新
  // 核算：只有核算結果仍然是 completed 才保留完成狀態，否則退回待處理交由使用者決定下一步
  // （刻意不自動啟動修正流程——此時程式碼通常已經合併進正式分支，不應在使用者不知情的情況
  // 下再次動到它）。使用者自己手動標記完成的任務（manualCompletion）不在此列。
  function reconcileAfterValidation(store, taskId) {
    const latest = store.task(taskId);
    if (!latest || latest.status !== 'completed' || latest.manualCompletion) return null;
    const reconciled = reconcileCompletionState(taskCompletionContext(latest, store.threads(taskId)));
    if (reconciled.passed && reconciled.status === 'completed') return latest;
    latest.status = 'waiting_input';
    latest.questions = [`部署驗收未通過，任務不能視為完成：\n${reconciled.blockingReasons.join('\n')}\n\n${reconciled.nextAction}`];
    store.saveTask(latest);
    store.event(taskId, 'completion_state_reconciled',
      `部署驗收未通過，任務狀態由「已完成」退回待處理：${reconciled.blockingReasons.join('；') || reconciled.nextAction}`);
    store.notify(latest, `部署驗收未通過，任務已退回待處理：${reconciled.blockingReasons[0] || reconciled.nextAction}`);
    return latest;
  }

  function finish(store, taskId, validationId, patch) {
    const latest = store.task(taskId);
    if (!latest || latest.completionValidation?.id !== validationId) return null;
    latest.completionValidation = { ...latest.completionValidation, ...patch, finishedAt: now() };
    store.saveTask(latest);
    return latest;
  }

  return {
    get busy() { return running.size > 0; },

    start(store, user, taskId) {
      const task = requireTask(store, user, taskId);
      if (task.git?.mode !== 'worktree') throw new HttpError(409, '此任務不是以 Git 模式執行，沒有可驗收的部署。');
      if (!task.gitMerge) throw new HttpError(409, '尚未合併到正式分支；請先完成合併再執行部署驗收。');
      const project = store.project(task.projectId);
      if (!project || !existsSync(project.path)) throw new HttpError(409, '專案資料夾不存在，無法建立驗收用的 Preview。');
      if (running.has(taskId)) throw new HttpError(409, '此任務的部署驗收正在執行中。');
      if (running.size) throw new HttpError(409, '目前已有另一個任務在執行部署驗收，請稍候再試。');

      const validationId = id();
      task.completionValidation = {
        id: validationId, status: 'running', passed: false, startedAt: now(), finishedAt: null,
        url: null, pid: null, previewStopped: false, checks: [], error: null, startedBy: user.id,
      };
      store.saveTask(task);
      store.event(taskId, 'completion_validation_started', `${user.name} 開始部署驗收：在合併後的 ${task.gitMerge.baseBranch} 上建立 Preview，驗證 /api/health、/api/login、/api/state，完成後停止並確認程序結束。`);

      const job = run(store, taskId)
        .then(outcome => {
          const updated = finish(store, taskId, validationId, { status: 'completed', ...outcome });
          if (!updated) return;
          const failed = outcome.checks.filter(item => !item.passed);
          // 認證失敗時要分得出「專案真的壞了」與「TaskFlow 沒把驗收身份準備好」：
          // 後者不是專案驗收失敗，不該讓使用者去改自己的程式。
          const auth = outcome.authentication;
          const infrastructure = auth && auth.passed === false && auth.failureCategory === 'taskflow_infrastructure';
          const summary = outcome.passed
            ? `部署驗收通過：${outcome.checks.length} 項全部通過，Preview 程序已確認結束。`
            : infrastructure
              ? `TaskFlow 驗收基礎設施問題（不是專案驗收失敗）：${auth.failureCode}。失敗停在 ${outcome.state || 'AUTH_FAILED'}，${failed.map(item => `${item.name}（${item.actual}）`).join('、')}`
              : `部署驗收未通過：${failed.map(item => `${item.name}（${item.actual}）`).join('、')}${auth?.failureCode ? `，failureCode=${auth.failureCode}` : ''}`;
          store.event(taskId, 'completion_validation_result', summary);
          if (!outcome.passed) { store.notify(updated, summary); reconcileAfterValidation(store, taskId); }
        })
        .catch(error => {
          finish(store, taskId, validationId, { status: 'failed', passed: false, error: String(error?.message || error).slice(0, 1000) });
          store.event(taskId, 'completion_validation_failed', `部署驗收未完成：${String(error?.message || error).slice(0, 500)}`);
          reconcileAfterValidation(store, taskId);
        })
        .finally(() => running.delete(taskId));

      running.set(taskId, job);
      return store.task(taskId);
    },

    /** 測試用：等待進行中的驗收結束。 */
    async settled() { await Promise.allSettled([...running.values()]); },
  };
}
