// Completion 的測試比對：在 main 與任務分支各跑一次完整測試，比對失敗項目。
//
// 這裡要取代的行為是：AI 回報「344 tests / 341 pass / 3 fail，那 3 個是既有問題」，
// 然後由人選擇相信。改成兩次實際執行 + 結構化比對之後，「是不是既有失敗」不再是宣稱，
// 而是可以稽核的事實（見 server/test-baseline.js 的解析與交叉驗證）。
//
// 幾個刻意的選擇：
//   1. 測試很慢（整套數百個測試），所以 HTTP 請求只負責「開始」，結果寫回任務資料，
//      前端靠既有的三秒輪詢看進度——不做會逾時的同步等待。
//   2. main 的 baseline 以 commit 為 key 快取：main 沒動就不重跑，省掉一半時間。
//   3. 專案目錄若不在正式分支上，就不假裝那是 baseline：直接標記 baseline 不可用，
//      也不浪費幾分鐘去跑一份無法解讀的基準。
//   4. 全機一次只跑一組比對：兩套測試同時跑會互搶連接埠與暫存檔，結果不可信。
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {id, now} from './db.js';
import {HttpError, requireTask} from './domain.js';
import {runNpmCommand} from './npm-runner.js';
import {compareTestRuns, runTestSuite, VERDICTS} from './test-baseline.js';

const BASELINE_SETTING_PREFIX = 'testBaseline:';
const MAX_LISTED_FAILURES = 50;

const baselineKey = commit => `${BASELINE_SETTING_PREFIX}${commit}`;
const logFile = (dataDir, taskId, label) => join(dataDir, 'completion', taskId, `${label}-${Date.now()}.log`);

/**
 * 送到瀏覽器的版本：拿掉伺服器磁碟路徑（與 decorated() 對 workspace／runDir 的處理一致），
 * 並把失敗清單截短，避免一份壞掉的測試把整包 /state 撐爆。
 */
export function completionTestPublic(task) {
  const report = task?.completionTest;
  if (!report) return null;
  const run = value => value ? {
    ok: !!value.ok,
    reason: value.reason || null,
    total: value.total || 0,
    passed: value.passed || 0,
    failedCount: (value.failed || []).length,
    failed: (value.failed || []).slice(0, MAX_LISTED_FAILURES),
    commit: value.commit || null,
    at: value.at || null,
    durationMs: value.durationMs || 0,
    timedOut: !!value.timedOut,
    exitCode: value.exitCode ?? null,
    cached: !!value.cached,
  } : null;
  return {
    id: report.id,
    status: report.status,
    planVersion: report.planVersion ?? null,
    startedAt: report.startedAt || null,
    finishedAt: report.finishedAt || null,
    verdict: report.verdict || null,
    baseBranch: report.baseBranch || null,
    newFailures: (report.newFailures || []).slice(0, MAX_LISTED_FAILURES),
    newFailureCount: (report.newFailures || []).length,
    resolvedFailures: (report.resolvedFailures || []).slice(0, MAX_LISTED_FAILURES),
    resolvedFailureCount: (report.resolvedFailures || []).length,
    baseline: run(report.baseline),
    current: run(report.current),
    error: report.error || null,
  };
}

/**
 * 上次執行中途被中斷（伺服器重啟、當機）的比對不能留在 running：
 * 那會讓畫面永遠顯示「執行中」，而且擋住重新執行。比照 runner.js 開機時對 thread 的復原。
 */
export function recoverCompletionTests(store) {
  for (const task of store.tasks()) {
    if (task.completionTest?.status !== 'running') continue;
    task.completionTest = {
      ...task.completionTest,
      status: 'interrupted',
      finishedAt: now(),
      error: '上次的測試比對在服務重新啟動時中斷，尚未取得結果。請重新執行。',
    };
    store.saveTask(task);
    store.event(task.id, 'completion_test_interrupted', task.completionTest.error);
  }
}

export function createCompletionTests({
  gitWorkspace, run = runNpmCommand, dataDir = resolve('data'),
  installTimeoutMs = 10 * 60000, testTimeoutMs = 15 * 60000,
} = {}) {
  // 全機一次只跑一組；key 是任務 id，值是進行中的 Promise。
  const running = new Map();

  async function suiteIn({ cwd, label, commit, taskId, install }) {
    if (install && !existsSync(join(cwd, 'node_modules'))) {
      const outcome = await run({ cwd, args: ['install', '--no-audit', '--no-fund'], timeoutMs: installTimeoutMs, logPath: logFile(dataDir, taskId, `${label}-install`) });
      if (outcome.exitCode !== 0) {
        return { label, commit, at: now(), ok: false, reason: 'install_failed', total: 0, passed: 0, failed: [], exitCode: outcome.exitCode, timedOut: outcome.timedOut, durationMs: outcome.durationMs, logPath: outcome.logPath };
      }
    }
    return runTestSuite({ cwd, label, commit, run, timeoutMs: testTimeoutMs, logPath: logFile(dataDir, taskId, label) });
  }

  // main 的 baseline 以 commit 為 key 快取：同一個 main 不重跑。只有解析成功的結果才進快取，
  // 壞掉的結果進了快取會一直誤導後續判定。
  async function baselineFor(store, task, repository) {
    if (repository.branch !== task.git.baseBranch) {
      return { label: 'baseline', commit: repository.head, at: now(), ok: false, reason: 'not_on_base_branch', total: 0, passed: 0, failed: [] };
    }
    const cached = store.setting(baselineKey(repository.head));
    if (cached?.ok) return { ...cached, cached: true };
    const report = await suiteIn({ cwd: task.git.repositoryPath, label: 'baseline', commit: repository.head, taskId: task.id, install: false });
    if (report.ok) store.setSetting(baselineKey(repository.head), { ...report, logPath: null });
    return report;
  }

  async function compare(store, taskId) {
    const task = store.task(taskId);
    const repository = gitWorkspace.inspect(task.git.repositoryPath);
    const baseline = await baselineFor(store, task, repository);
    const current = await suiteIn({ cwd: task.workspace, label: 'current', commit: task.git.headCommit, taskId: task.id, install: true });
    return { repository, baseline, current, ...compareTestRuns(baseline, current) };
  }

  function finish(store, taskId, testId, patch) {
    // 測試要跑好幾分鐘，期間使用者可能已經取消、補充需求或重新規劃。只寫回最新的任務資料，
    // 而且只有在這份結果仍然屬於同一次比對時才寫，絕不用舊快照覆蓋使用者剛做的變更。
    const latest = store.task(taskId);
    if (!latest || latest.completionTest?.id !== testId) return;
    latest.completionTest = { ...latest.completionTest, ...patch, finishedAt: now() };
    store.saveTask(latest);
    return latest;
  }

  return {
    /** 目前是否有比對在執行（供測試與狀態顯示使用）。 */
    get busy() { return running.size > 0; },

    start(store, user, taskId) {
      const task = requireTask(store, user, taskId);
      if (task.git?.mode !== 'worktree') throw new HttpError(409, '此任務不是以 Git 模式執行，沒有可比對的分支。');
      if (!task.workspace || !existsSync(task.workspace)) throw new HttpError(409, '任務工作副本已不存在（可能已清理），無法執行測試比對。');
      if (store.threads(taskId).some(thread => thread.status === 'running')) throw new HttpError(409, 'AI 正在修改此工作副本，請完成後再執行測試比對。');
      if (running.has(taskId)) throw new HttpError(409, '此任務的測試比對正在執行中。');
      if (running.size) throw new HttpError(409, '目前已有另一個任務在執行測試比對；同時執行會互相干擾，請稍候再試。');

      const testId = id();
      task.completionTest = {
        id: testId,
        planVersion: task.planVersion,
        status: 'running',
        startedAt: now(),
        finishedAt: null,
        baseBranch: task.git.baseBranch,
        verdict: null,
        newFailures: [],
        resolvedFailures: [],
        baseline: null,
        current: null,
        error: null,
        startedBy: user.id,
      };
      store.saveTask(task);
      store.event(taskId, 'completion_test_started', `${user.name} 開始測試比對：先取得 ${task.git.baseBranch} 的基準，再執行任務分支的測試。`);

      const job = compare(store, taskId)
        .then(outcome => {
          const updated = finish(store, taskId, testId, {
            status: 'completed',
            verdict: outcome.verdict,
            newFailures: outcome.newFailures,
            resolvedFailures: outcome.resolvedFailures,
            baseline: outcome.baseline,
            current: outcome.current,
          });
          if (!updated) return;
          const summary = {
            [VERDICTS.NO_REGRESSION]: `測試比對完成：沒有新的失敗（基準 ${outcome.baseline.failed.length} 項既有失敗，本次 ${outcome.current.failed.length} 項）。`,
            [VERDICTS.REGRESSION]: `測試比對完成：偵測到 ${outcome.newFailures.length} 項新的失敗，已擋住合併。\n${outcome.newFailures.slice(0, 10).join('\n')}`,
            [VERDICTS.BASELINE_UNAVAILABLE]: `無法取得 ${task.git.baseBranch} 的測試基準（${outcome.baseline.reason || '原因不明'}），因此無法判斷哪些失敗是既有的。`,
            [VERDICTS.PARSE_FAILED]: `無法判讀任務分支的測試結果（${outcome.current.reason || '原因不明'}）。讀不懂一律不當成通過。`,
          }[outcome.verdict];
          store.event(taskId, 'completion_test_result', summary);
          if (outcome.verdict !== VERDICTS.NO_REGRESSION) store.notify(updated, summary);
        })
        .catch(error => {
          finish(store, taskId, testId, { status: 'failed', error: String(error?.message || error).slice(0, 1000) });
          store.event(taskId, 'completion_test_failed', `測試比對未完成：${String(error?.message || error).slice(0, 500)}`);
        })
        .finally(() => running.delete(taskId));

      running.set(taskId, job);
      return store.task(taskId);
    },

    /** 測試用：等待進行中的比對結束。 */
    async settled() { await Promise.allSettled([...running.values()]); },
  };
}
