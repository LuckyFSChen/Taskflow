// Completion Pipeline：把「測試比對 → 合併 → 重新啟動 → 部署驗收 → 清理」串成一次核准。
//
// 在這之前，這五件事是五顆要自己依序按的按鈕。這個模組只做一件事：**依序推進**，
// 並且把每個階段的結果保留下來。它自己不執行任何操作——合併、測試、重啟、驗收、清理
// 全部由外部注入（app.js 接的是既有那幾個模組），所以這裡是一個可以單獨測試的狀態機。
//
// 五個不可妥協的原則：
//   1. 失敗只擋住它自己那一段。已經完成的階段不重跑，重試一律從失敗的那一階段開始
//      （計畫書第十七章：Merge ✓ / Restart ✓ / Validation ✕ 時，只重跑 Validation）。
//   2. 絕不重複合併。已經有 gitMerge 就跳過合併階段，不論狀態機走到哪裡。
//   3. 每一次推進都重讀任務最新狀態。整條 pipeline 要跑好幾分鐘，期間使用者可能取消，
//      重啟階段甚至會把執行這段程式的行程直接殺掉。
//   4. 重啟殺掉服務之後，新的行程要能接著跑完。所以狀態存在任務資料裡，不在記憶體。
//   5. 「還不能做」與「做失敗了」是兩件事。前者（別的任務正在跑測試、守護程式還沒接手）
//      是等待，下一個 tick 再試；只有後者才讓 pipeline 停下來等人。
import {id, now} from './db.js';

export const PIPELINE_STAGES = ['test', 'merge', 'test_main', 'restart', 'validate', 'push', 'cleanup'];

export const STAGE_LABELS = {
  test: '測試比對',
  merge: '合併到正式分支',
  test_main: '合併後在正式分支重測',
  restart: '重新啟動正式 TaskFlow',
  validate: '部署驗收',
  push: '推送到遠端',
  cleanup: '清理工作副本與分支',
};

/**
 * 這個任務要跑哪些階段。
 *
 * 重新啟動與部署驗收只對 TaskFlow 自己這個專案有意義：前者重啟的是正式 TaskFlow，
 * 後者驗的是 TaskFlow 自己的 API 合約（/api/login、/api/state）。其他專案跑這兩段
 * 只會得到一堆無意義的失敗，所以直接不排進去——這也正是計畫書說的「純文件修改就只要
 * Test → Merge → Done」。
 */
export function plannedStages({ selfProject = false, options = {} } = {}) {
  return PIPELINE_STAGES.filter(stage => {
    // 合併後重測要跑第二輪完整測試，所以可以關掉；預設開著，因為 semantic conflict
    // （兩邊各自都對、合起來壞掉）只有這一步抓得到。
    if (stage === 'test_main') return options.testMain !== false;
    // 推送遠端預設**不做**：它是唯一會影響本機以外的動作，必須每次明確勾選（計畫書第十六章）。
    if (stage === 'push') return options.push === true;
    if (stage === 'restart') return selfProject && options.restart !== false;
    if (stage === 'validate') return selfProject && options.validate !== false;
    if (stage === 'cleanup') return options.cleanup !== false;
    return true;
  });
}

/** 已經完成的階段不重跑：回傳下一個還沒有成功結果的階段。 */
export function nextStage(completion) {
  return (completion?.stages || []).find(stage => completion?.results?.[stage]?.ok !== true) || null;
}

export function createCompletion({ task, user, selfProject, options = {} }) {
  return {
    id: id(),
    planVersion: task.planVersion,
    artifactVersion: task.artifactVersion || null,
    stages: plannedStages({ selfProject, options }),
    options: { push: options.push === true, testMain: options.testMain !== false, restart: options.restart !== false, validate: options.validate !== false, cleanup: options.cleanup !== false },
    stage: null,
    status: 'running',
    approvedBy: user.id,
    approvedByName: user.name,
    approvedAt: now(),
    finishedAt: null,
    results: {},
    failure: null,
    notes: [],
  };
}

const terminal = value => ['completed', 'failed', 'interrupted'].includes(value);

// 每個階段處理器回傳的形狀：
//   {state:'waiting', note?}  還在跑／還不能開始，下一個 tick 再看
//   {state:'done', result}    這一階段成功
//   {state:'failed', message} 這一階段失敗，整條 pipeline 停下來等人
const waiting = note => ({ state: 'waiting', note: note || null });
const done = result => ({ state: 'done', result: { ok: true, at: now(), ...result } });
const failed = message => ({ state: 'failed', message });

/**
 * 測試比對。regression 才算失敗；讀不懂結果或拿不到基準會通過但留下警告，
 * 與單顆按鈕時的判定一致——用猜測擋住部署，和無聲放行一樣糟。
 */
function testStage(store, task, user, deps) {
  const report = task.completionTest;
  const mine = report && report.startedAt && report.startedAt >= task.completion.approvedAt;
  if (!mine) {
    try { deps.tests.start(store, user, task.id); return waiting('已開始測試比對'); }
    // 別的任務正在跑測試不是失敗，是還不能開始。
    catch (error) { return error?.status === 409 ? waiting(String(error.message)) : failed(String(error?.message || error)); }
  }
  if (report.status === 'running') return waiting();
  if (report.status !== 'completed') return failed(report.error || '測試比對沒有完成。');
  if (report.verdict === 'regression') return failed(`測試比對發現 ${report.newFailureCount || report.newFailures?.length || 0} 項新的失敗。`);
  return done({
    verdict: report.verdict,
    note: report.verdict === 'no_regression' ? null : '沒有可用的比對基準或無法判讀結果，這一項未能證明沒有 regression。',
  });
}

/** 合併。已經合併過就直接跳過——絕不重複合併。 */
function mergeStage(store, task, user, deps) {
  if (task.gitMerge) return done({ commit: task.gitMerge.commit, skipped: true });
  if (task.gitConflict) return failed(`合併會產生衝突：${(task.gitConflict.files || []).join('、') || '（未列出檔案）'}`);
  try {
    // cleanup:false —— 清理是這條 pipeline 最後一個階段，合併當下不能先把 worktree 砍掉。
    const updated = deps.merge(store, user, task, { artifactVersion: task.completion.artifactVersion, cleanup: false });
    if (updated?.gitConflict) return failed(`合併會產生衝突：${(updated.gitConflict.files || []).join('、')}`);
    if (!updated?.gitMerge) return failed('合併沒有完成，且沒有回報衝突。');
    return done({ commit: updated.gitMerge.commit });
  } catch (error) { return failed(String(error?.message || error)); }
}

/**
 * 合併後在正式分支重測。分支比對通過只證明「這條分支自己沒有製造新的失敗」；
 * 兩邊各自都對、合起來卻壞掉的情況，只有在合併後的正式分支上才看得到。
 *
 * 這一階段失敗時流程會停住，而且刻意不自動做任何補救：撤銷合併是不可逆的決定，
 * 要由人按下去（既有的「撤銷這次合併」會補一個反向 commit，不刪任何歷史）。
 */
function testMainStage(store, task, user, deps) {
  const report = task.completionMainTest;
  const mine = report && report.startedAt && report.startedAt >= task.completion.approvedAt;
  if (!mine) {
    try { deps.tests.startMain(store, user, task.id); return waiting('已開始合併後重測'); }
    catch (error) { return error?.status === 409 ? waiting(String(error.message)) : failed(String(error?.message || error)); }
  }
  if (report.status === 'running') return waiting();
  if (report.status !== 'completed') return failed(report.error || '合併後重測沒有完成。');
  if (report.verdict === 'regression') {
    const count = report.newFailureCount || report.newFailures?.length || 0;
    return failed(`合併後在正式分支出現 ${count} 項新的失敗；這些在合併前與任務分支上都沒有出現，是合併本身造成的。若要退回，請使用「撤銷這次合併」。`);
  }
  return done({
    verdict: report.verdict,
    note: report.verdict === 'no_regression' ? null : '沒有合併前的基準或無法判讀結果，這一項未能證明合併沒有造成新的失敗。',
  });
}

/** 重新啟動：只送出請求，實際動手的是守護程式；這個行程很可能會在這一階段被殺掉。 */
function restartStage(store, task, user, deps) {
  const request = deps.restartStatus(store, task);
  const mine = request && request.requestedAt && request.requestedAt >= task.completion.approvedAt;
  if (!mine) {
    const blocked = deps.restart(store, user, task);
    if (blocked) return blocked.retryable ? waiting(blocked.message) : failed(blocked.message);
    return waiting('已送出重新啟動請求，等待守護程式接手');
  }
  if (request.status === 'success') return done({ url: request.url || null, attempts: request.attempts });
  if (request.status === 'failed') return failed(request.error || '重新啟動未成功。');
  return waiting(request.note || null);
}

/** 部署驗收：API 層 + Preview 程序生命週期。 */
function validateStage(store, task, user, deps) {
  const report = task.completionValidation;
  const mine = report && report.startedAt && report.startedAt >= task.completion.approvedAt;
  if (!mine) {
    try { deps.validations.start(store, user, task.id); return waiting('已開始部署驗收'); }
    catch (error) { return error?.status === 409 ? waiting(String(error.message)) : failed(String(error?.message || error)); }
  }
  if (report.status === 'running') return waiting();
  if (report.status !== 'completed') return failed(report.error || '部署驗收沒有完成。');
  if (!report.passed) {
    const bad = (report.checks || []).filter(check => !check.passed).map(check => check.name);
    return failed(`部署驗收未通過：${bad.join('、') || '（未列出項目）'}`);
  }
  return done({ checks: (report.checks || []).length });
}

/** 推送到遠端。失敗（落後遠端、沒有 remote）就停住等人，絕不自作主張整合別人的工作。 */
function pushStage(store, task, user, deps) {
  if (task.gitPush) return done({ remote: task.gitPush.remote, count: task.gitPush.count, skipped: true });
  try {
    const updated = deps.push(store, user, task);
    const pushed = updated?.gitPush;
    return done(pushed
      ? { remote: pushed.remote, count: pushed.count }
      : { remote: 'origin', count: 0, note: '遠端已經是最新的，沒有需要推送的 commit。' });
  } catch (error) { return failed(String(error?.message || error)); }
}

/**
 * 清理。清不掉不算 pipeline 失敗：worktree 裡還有沒提交的東西時，既有的清理邏輯
 * 本來就會保留不動並照實回報，那是正確行為，不該讓整條已經完成的部署變成紅色。
 */
function cleanupStage(store, task, user, deps) {
  try {
    const outcome = deps.cleanup(store, task);
    return done({ removed: !!outcome?.removed, branchDeleted: !!outcome?.branchDeleted, note: outcome?.message || null });
  } catch (error) { return done({ removed: false, note: `清理未完成：${String(error?.message || error)}` }); }
}

const HANDLERS = { test: testStage, merge: mergeStage, test_main: testMainStage, restart: restartStage, validate: validateStage, push: pushStage, cleanup: cleanupStage };

/**
 * 推進一個任務的 pipeline 一步。每次都重讀最新的任務資料，回傳更新後的任務。
 */
export function advanceCompletion(store, taskId, deps) {
  const task = store.task(taskId);
  if (!task?.completion || task.completion.status !== 'running') return task;

  const stage = nextStage(task.completion);
  if (!stage) {
    task.completion = { ...task.completion, stage: null, status: 'completed', finishedAt: now() };
    store.saveTask(task);
    store.event(taskId, 'completion_finished', `部署流程完成：${task.completion.stages.map(name => STAGE_LABELS[name]).join(' → ')}。`);
    store.notify(task, '部署流程已完成。');
    return task;
  }

  const user = store.user(task.completion.approvedBy);
  if (!user) {
    task.completion = { ...task.completion, status: 'failed', stage, failure: { stage, message: '核准這次部署的使用者已不存在。', at: now() }, finishedAt: now() };
    store.saveTask(task);
    return task;
  }

  const outcome = HANDLERS[stage](store, task, user, deps);
  // 階段處理器可能已經改過任務（例如合併），所以從資料庫重讀再寫回，不要用上面那份舊快照。
  const latest = store.task(taskId);
  const completion = { ...latest.completion, stage };

  if (outcome.state === 'waiting') {
    if (outcome.note && completion.notes.at(-1) !== outcome.note) {
      completion.notes = [...completion.notes, outcome.note].slice(-20);
      store.event(taskId, 'completion_stage_waiting', `${STAGE_LABELS[stage]}：${outcome.note}`);
    }
  } else if (outcome.state === 'done') {
    completion.results = { ...completion.results, [stage]: outcome.result };
    completion.failure = null;
    store.event(taskId, 'completion_stage_done', `${STAGE_LABELS[stage]} 完成${outcome.result.note ? `：${outcome.result.note}` : ''}`);
  } else {
    completion.status = 'failed';
    completion.failure = { stage, message: outcome.message, at: now() };
    completion.finishedAt = now();
    store.event(taskId, 'completion_stage_failed', `${STAGE_LABELS[stage]} 失敗：${outcome.message}`);
    store.notify(latest, `部署流程在「${STAGE_LABELS[stage]}」停住：${outcome.message}`);
  }

  latest.completion = completion;
  store.saveTask(latest);
  return latest;
}

/** 掃過所有進行中的 pipeline，各推進一步。 */
export function tickCompletions(store, deps) {
  const advanced = [];
  for (const task of store.tasks()) {
    if (task.completion?.status !== 'running') continue;
    try { advanced.push(advanceCompletion(store, task.id, deps)); }
    catch (error) { deps.onError?.(error, task.id); }
  }
  return advanced;
}

/**
 * 服務重新啟動之後：pipeline 的狀態存在任務資料裡，所以它會自己接著跑。
 * 唯一要處理的是「重啟階段以外的地方被打斷」——那些子系統自己會標成 interrupted，
 * 下一個 tick 讀到非 running 的結果就會照失敗處理，不需要在這裡另外猜。
 */
export function completionPublic(task) {
  const completion = task?.completion;
  if (!completion) return null;
  return {
    id: completion.id,
    status: completion.status,
    stage: completion.stage,
    stages: completion.stages.map(name => ({
      key: name,
      label: STAGE_LABELS[name],
      ok: completion.results?.[name]?.ok === true,
      note: completion.results?.[name]?.note || null,
      current: completion.stage === name && completion.status === 'running',
      failed: completion.failure?.stage === name,
    })),
    options: completion.options,
    approvedByName: completion.approvedByName || null,
    approvedAt: completion.approvedAt,
    finishedAt: completion.finishedAt,
    failure: completion.failure,
    note: completion.notes?.at(-1) || null,
    artifactVersion: completion.artifactVersion,
  };
}

/**
 * 推進器。**預設不建立計時器**：createApp() 在測試裡會被呼叫很多次，而且那些測試
 * 跑完就關掉資料庫；如果 app 自己持有一個計時器，它會在資料庫關閉之後繼續跳並丟例外，
 * 把跟它無關的測試檔整個弄失敗（實際發生過：只有執行超過三秒的測試檔會中招）。
 * 真正的計時器由 server/index.js 持有，因為只有它知道何時該停。
 */
export function createCompletionPipeline(store, deps, { intervalMs = 0 } = {}) {
  let stopping = false;
  const timer = intervalMs > 0 ? setInterval(() => { if (!stopping) tickCompletions(store, deps); }, intervalMs) : null;
  timer?.unref?.();
  return {
    tick: () => (stopping ? [] : tickCompletions(store, deps)),
    stop() { stopping = true; if (timer) clearInterval(timer); },
  };
}

export {terminal as isTerminalStatus};
