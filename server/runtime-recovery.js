// Runtime failure 的分類、回復，以及 waiting_input 的語意界線。
//
// 整改前所有問題最後都只剩一句「browser validation failed」，於是兩件完全不同的事被當成
// 同一件：專案的程式真的壞了（該交給 Repair Agent），和 TaskFlow 自己的執行環境沒準備好
// （該由 TaskFlow 自己修）。後者被丟給 Repair Agent，就變成「改 code → 再失敗 → 再改 code」
// 的無限迴圈；被丟給使用者，就變成任務卡在 waiting_input 永遠不動。
//
// 三個不可妥協的原則：
//   1. runtime 層的失敗先由 runtime 處理，**不得**直接觸發 Repair Agent（計畫書第二十一章）。
//   2. 自動回復必須有上限。超過 MAX_RUNTIME_RECOVERY_ATTEMPTS 就標成 runtime_blocked，
//      不是無限重試，也不是靜靜放行。
//   3. 只有真的需要人決定的事才進 waiting_input（計畫書第二十二章）。
//      「backend 沒起來」「port 被佔用」「proxy 沒接上」都不是。
import {RuntimeFailure, defaultConnectivityProbes, validateConnectivity, validateFrontendRoot} from './runtime-validation.js';
import {browserEntryService} from './runtime-topology.js';

export const MAX_RUNTIME_RECOVERY_ATTEMPTS = 2;

/** 可以由 TaskFlow 自己處理、不需要問人的失敗。 */
export const RECOVERABLE_FAILURES = new Set([
  'service_not_started',
  'service_start_failed',
  'service_unhealthy',
  'dependency_unavailable',
  'port_conflict',
  'proxy_routing_failure',
  'unexpected_content_type',
  'stale_runtime',
  'runtime_timeout',
]);

/**
 * 需要人介入才可能解決的失敗。刻意只有一項：topology 判定不出來時，
 * 沒有任何重試會讓它變出來，必須由使用者宣告 taskflow.runtime.json。
 */
export const USER_INPUT_FAILURES = new Set(['topology_unresolved']);

export function isRecoverableRuntimeFailure(kind) { return RECOVERABLE_FAILURES.has(kind); }
export function requiresUserInput(kind) { return USER_INPUT_FAILURES.has(kind); }

/**
 * 這個失敗該算在誰頭上。分不出「TaskFlow 沒把執行環境準備好」與「專案自己壞了」，
 * 就會把前者丟給 Repair Agent 改 code（改不好，因為問題不在 code 裡），
 * 或把後者當成平台問題而永遠不修。
 *
 *   taskflow —— 轉發沒接上、runtime 過期、連接埠衝突、相依沒就緒：TaskFlow 自己的責任。
 *   project  —— 專案的程序自己啟動失敗或健康檢查不過（且自動回復用盡）：那是程式的問題。
 *   user     —— 只有 topology 判定不出來：需要使用者宣告，重試多少次都不會變。
 */
export function failureOwner(kind) {
  if (!kind) return null;
  if (USER_INPUT_FAILURES.has(kind)) return 'user';
  if (['service_start_failed', 'service_unhealthy', 'browser_failure'].includes(kind)) return 'project';
  if (RECOVERABLE_FAILURES.has(kind)) return 'taskflow';
  return 'project';
}

/**
 * runtime 失敗**不得**直接交給 Repair Agent。只有「執行環境已經盡力準備好、功能本身
 * 仍然失敗」才是 Repair Agent 的工作：沒有 runtime failureKind 的一般驗證失敗、
 * browser_failure，以及自動回復用盡後仍然起不來的專案自身程序。
 */
export function shouldTriggerRepair(kind) { return !kind || failureOwner(kind) === 'project'; }

export function classifyRuntimeFailure(error) {
  if (!error) return null;
  if (error instanceof RuntimeFailure) return error.kind;
  if (typeof error.kind === 'string') return error.kind;
  const message = String(error?.message || error);
  if (/EADDRINUSE|address already in use|連接埠/i.test(message)) return 'port_conflict';
  if (/timeout|逾時/i.test(message)) return 'runtime_timeout';
  if (/找不到可預覽|沒有找到可預覽|topology/i.test(message)) return 'topology_unresolved';
  return null;
}

/** 這一種失敗該怎麼回復。回傳的 action 交給呼叫端執行，這個模組自己不動任何程序。 */
export function recoveryPlan(kind, {attempt = 0} = {}) {
  if (!isRecoverableRuntimeFailure(kind)) return {action: 'none', reason: `${kind} 不是可自動回復的 runtime 失敗。`};
  if (attempt >= MAX_RUNTIME_RECOVERY_ATTEMPTS) return {action: 'block', reason: `已嘗試自動回復 ${attempt} 次仍未成功。`};
  switch (kind) {
    case 'stale_runtime':
    case 'proxy_routing_failure':
    case 'unexpected_content_type':
      // proxy 沒接上幾乎都是「前端這層還是舊的」：整組重新建立，重新配 port、重新接 proxy。
      return {action: 'restart_runtime', reason: '重新建立 runtime 並重新接上轉發。'};
    case 'port_conflict':
      return {action: 'restart_runtime', reason: '重新配置連接埠後重新啟動。'};
    case 'service_not_started':
    case 'service_start_failed':
    case 'service_unhealthy':
    case 'dependency_unavailable':
    case 'runtime_timeout':
      return {action: 'restart_runtime', reason: '重新啟動服務並重新等待健康檢查。'};
    default:
      return {action: 'restart_runtime', reason: '重新啟動 runtime。'};
  }
}

const check = (name, passed, {expected = '', actual = '', failureKind = null, detail = '', url = null} = {}) =>
  ({name, expected, actual, passed, failureKind, detail, url});

/**
 * Browser Validation Preflight（計畫書第十五章）。
 *
 *   Resolve Runtime Topology → Start missing dependencies → Backend Health →
 *   Frontend Health → Frontend → Backend API Probe → （才輪到）Browser Validation
 *
 * 任何一步失敗都帶著分類往外走，並在可回復時自動重試，上限 MAX_RUNTIME_RECOVERY_ATTEMPTS。
 * 這一層**永遠不會**把任務改成 waiting_input，也不會叫 Repair Agent——它只回報結論。
 */
export async function runtimePreflight(key, projectPath, {
  previews, onEvent = () => {}, fetchImpl = fetch, maxAttempts = MAX_RUNTIME_RECOVERY_ATTEMPTS, extraProbePaths = [],
} = {}) {
  const emit = (kind, payload) => { try { onEvent(kind, payload); } catch { /* 事件不該影響 preflight 結論 */ } };
  const attempts = [];
  // 最後一輪的逐項檢查結果要留到最後回報。之前每一輪的 checks 都留在迴圈裡，
  // 重試用盡時回報的是一個空陣列——使用者只看得到 failureKind，看不到是哪一條路徑失敗。
  let lastChecks = [], lastTopology = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const checks = [];
    let info = null;
    try {
      info = await previews.start(key, projectPath);
    } catch (error) {
      const kind = classifyRuntimeFailure(error) || 'service_start_failed';
      // 子程序的 stderr 是這種失敗唯一有用的證據（缺套件、設定錯、平台不符…）。
      // 少了它，使用者看到的只有「未能就緒」，等於什麼都沒說。
      const stderr = error?.details?.stderr ? `\nstderr: ${String(error.details.stderr).slice(-1200)}` : '';
      const detail = `${String(error?.message || error)}${stderr}`;
      attempts.push({attempt, failureKind: kind, detail});
      const plan = recoveryPlan(kind, {attempt});
      emit('runtime_service_failed', {attempt, failureKind: kind, detail, recovery: plan.action});
      if (plan.action !== 'restart_runtime') return blocked(kind, attempts, checks, detail);
      await previews.stop(key).catch(() => {});
      continue;
    }

    const topology = info.topology || null;
    const entry = browserEntryService(topology);
    // 結構化事件：每一個服務的實際結果各記一筆，而不是把整段 runtime 壓成一句自然語言。
    // （manager 內部也會發事件，但它拿不到 taskId；這裡補上任務脈絡下的那一份。）
    if (info.runtime) {
      emit('runtime_topology_detected', {source: topology?.source || null, services: info.runtime.services.map(service => ({id: service.id, type: service.type, cwd: service.cwd, dependsOn: service.dependsOn}))});
      for (const service of info.runtime.services) {
        emit(service.status === 'READY' ? 'runtime_service_ready' : 'runtime_service_failed', {service: service.id, type: service.type, status: service.status, url: service.url, port: service.port, pid: service.pid, failureKind: service.failureKind, detail: service.error});
      }
    }
    // 單一服務專案沒有 topology：維持整改前行為，只驗前端根路徑。
    const root = await validateFrontendRoot(info.url, {fetchImpl});
    checks.push(check('frontend_root', root.passed, {expected: '200 text/html', actual: `${root.status ?? '無回應'} ${root.contentType || ''}`.trim(), failureKind: root.failureKind, detail: root.detail, url: info.url}));

    let connectivity = {passed: true, checks: []};
    if (root.passed && topology && topology.services.some(service => ['backend', 'worker'].includes(service.type))) {
      const backends = topology.services.filter(service => ['backend', 'worker'].includes(service.type));
      const probes = backends.flatMap(service => defaultConnectivityProbes(service, {extraPaths: [...(entry?.proxyPaths || []), ...extraProbePaths].filter(path => path && !path.endsWith('*'))}))
        // 同一條路徑不重複打。
        .filter((probe, index, list) => list.findIndex(item => item.path === probe.path) === index);
      connectivity = await validateConnectivity({frontendUrl: info.url, probes, fetchImpl});
      checks.push(...connectivity.checks);
      if (connectivity.passed) emit('runtime_api_validation_passed', {url: info.url, probes: probes.map(probe => probe.path)});
      else emit('runtime_proxy_validation_failed', {url: info.url, failureKind: connectivity.failureKind, detail: connectivity.detail});
    }

    lastChecks = checks;
    lastTopology = topology;
    const failed = checks.find(item => !item.passed);
    if (!failed) return {passed: true, previewUrl: info.url, info, topology, checks, attempts, failureKind: null, owner: null, blocked: false};

    const kind = failed.failureKind || 'unknown';
    attempts.push({attempt, failureKind: kind, detail: failed.detail});
    const plan = recoveryPlan(kind, {attempt});
    if (plan.action !== 'restart_runtime') { await previews.stop(key).catch(() => {}); return blocked(kind, attempts, checks, failed.detail, topology); }
    emit('runtime_service_restarting', {attempt, failureKind: kind, reason: plan.reason});
    // 重試前一定要把現有的 runtime 收乾淨，否則第二輪會在半舊的服務上重跑，
    // 得到的結論既不是舊的也不是新的。
    await previews.stop(key).catch(() => {});
  }

  const last = attempts.at(-1);
  return blocked(last?.failureKind || 'unknown', attempts, lastChecks, last?.detail || '超過自動回復次數上限。', lastTopology);
}

// blocked 的結論一律不帶 previewUrl：到這裡 runtime 已經收掉了，給一個指向死掉服務的網址
// 只會讓呼叫端以為還有東西可以開。
function blocked(failureKind, attempts, checks, detail, topology = null) {
  return {
    passed: false,
    blocked: true,
    failureKind,
    owner: failureOwner(failureKind),
    // runtime_blocked 是「TaskFlow 自己處理不了」的狀態，不是「請使用者回答問題」。
    // 只有 requiresUserInput(kind) 為真時，呼叫端才可以把任務改成 waiting_input。
    state: 'runtime_blocked',
    needsUserInput: requiresUserInput(failureKind),
    attempts,
    checks,
    detail,
    previewUrl: null,
    info: null,
    topology,
  };
}

/** 給事件與 UI 用的一句話結論，說得出卡在哪一層。 */
export function preflightSummary(outcome) {
  if (outcome?.passed) return `Runtime preflight 通過：${outcome.checks.length} 項檢查全部通過，Preview 可進行 Browser Validation。`;
  const failed = (outcome?.checks || []).filter(item => !item.passed);
  const detail = failed.map(item => `${item.name}（${item.actual || item.detail || '未通過'}）`).join('、');
  return `Runtime preflight 未通過：failureKind=${outcome?.failureKind || 'unknown'}${detail ? `，${detail}` : ''}${outcome?.detail ? `。${outcome.detail}` : ''}`;
}
