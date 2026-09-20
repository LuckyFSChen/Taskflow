// Runtime 驗證：health check、API response semantics、frontend → backend connectivity。
//
// 這個模組存在的唯一理由是：**HTTP 200 不等於 API 成功**。
// Vite/SPA 的 fallback 會把 /api/profile 這種不存在的靜態路徑回成 index.html，
// 狀態碼 200、Content-Type text/html。只驗 status 的檢查會一路放行，直到前端在瀏覽器裡
// JSON.parse 失敗才爆掉——而那時候錯誤已經離真正的原因（proxy 沒接上）很遠了。
//
// 三個不可妥協的原則：
//   1. 期待 JSON 就必須真的拿到 JSON。Content-Type 是 text/html 一律判定 routing/proxy 失敗。
//   2. 失敗要說得出是哪一種失敗。所有結果都帶 RuntimeFailureKind，不留「validation failed」。
//   3. 驗不到的項目標成未通過，不是略過。

/** 所有 runtime 層失敗的正規分類。UI、事件、recovery 決策全部依賴這一組代碼。 */
export const RUNTIME_FAILURE_KINDS = [
  'service_not_started',
  'service_start_failed',
  'service_unhealthy',
  'dependency_unavailable',
  'port_conflict',
  'proxy_routing_failure',
  'unexpected_content_type',
  'stale_runtime',
  'runtime_timeout',
  'browser_failure',
  'topology_unresolved',
  'unknown',
];

export const RUNTIME_FAILURE_LABELS = {
  service_not_started: '服務尚未啟動',
  service_start_failed: '服務啟動失敗',
  service_unhealthy: '服務健康檢查未通過',
  dependency_unavailable: '相依服務不可用',
  port_conflict: '連接埠衝突',
  proxy_routing_failure: '前端到後端的轉發未生效',
  unexpected_content_type: '回應型別與預期不符',
  stale_runtime: '執行環境已過期，需要重新啟動',
  runtime_timeout: '執行環境等待逾時',
  browser_failure: '瀏覽器驗證失敗',
  topology_unresolved: '無法判定專案的 runtime 結構',
  unknown: '未分類的執行環境問題',
};

export class RuntimeFailure extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'RuntimeFailure';
    this.kind = RUNTIME_FAILURE_KINDS.includes(kind) ? kind : 'unknown';
    this.details = details;
  }
}

const HTML_BODY = /^\s*(<!doctype html|<html[\s>])/i;

function mediaType(header) {
  return String(header || '').split(';')[0].trim().toLowerCase();
}

/**
 * 驗一次 API 回應的語意，而不只是狀態碼。
 *
 * expectation:
 *   expectedStatus        期待的 HTTP status（null＝不限）
 *   expectedContentType   期待的 media type，例如 application/json
 *   expectedJsonShape     期待 body 至少具備的鍵（值為 null 時只檢查鍵存在）
 *   anyHttpResponse       true＝只要伺服器回得出 HTTP 就算通過（偵測不到 health route 時的 fallback）
 *   via                   'frontend' 時，型別不符歸類為 proxy_routing_failure（那正是 SPA fallback 的形狀）
 */
export async function validateApiResponse(url, expectation = {}, {fetchImpl = fetch, timeoutMs = 5000} = {}) {
  const base = {url, status: null, contentType: null, passed: false, failureKind: null, detail: null, bodyPreview: null};
  let response;
  try {
    // Accept 一律保留 */*。只送 application/json 會讓 express 的 SPA fallback 走 req.accepts('html')
    // 為 false 的分支而回 404——那等於我們自己把要抓的假陽性藏起來。瀏覽器裡的 fetch／axios
    // 預設就是 */*，要驗的正是那條路徑上實際會發生的事。
    response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: {accept: expectation.expectedContentType ? `${expectation.expectedContentType}, */*` : '*/*'}});
  } catch (error) {
    const message = String(error?.message || error);
    return {...base, failureKind: /timeout|abort/i.test(message) ? 'runtime_timeout' : 'service_unhealthy', detail: `無法連線：${message.slice(0, 200)}`};
  }
  const status = response.status;
  const contentType = mediaType(response.headers.get('content-type'));
  let text = '';
  try { text = (await response.text()).slice(0, 4000); } catch { /* body 讀不到不影響 header 層的判定 */ }
  const preview = text.slice(0, 200);
  const result = {...base, status, contentType, bodyPreview: preview};

  if (expectation.anyHttpResponse) {
    // 「有回應就算通過」的最弱模式，但仍然要排除 SPA fallback：後端如果回的是 HTML 首頁，
    // 那多半代表我們打到的是前端而不是後端。
    if (HTML_BODY.test(text) || contentType === 'text/html') {
      return {...result, failureKind: expectation.via === 'frontend' ? 'proxy_routing_failure' : 'unexpected_content_type', detail: `期待後端回應，實際收到 HTML（${contentType || '未標示型別'}）。`};
    }
    return {...result, passed: true};
  }

  if (expectation.expectedStatus != null && status !== expectation.expectedStatus) {
    return {...result, failureKind: 'service_unhealthy', detail: `期待 HTTP ${expectation.expectedStatus}，實際 ${status}。`};
  }

  if (expectation.expectedContentType) {
    const expected = mediaType(expectation.expectedContentType);
    if (contentType !== expected) {
      // 這是整個整改的核心判定：200 + text/html 而我們要的是 JSON，就是 routing／proxy 壞了。
      const kind = (contentType === 'text/html' || HTML_BODY.test(text))
        ? (expectation.via === 'frontend' ? 'proxy_routing_failure' : 'unexpected_content_type')
        : 'unexpected_content_type';
      return {...result, failureKind: kind, detail: `expected ${expected}, received ${contentType || '（未標示 Content-Type）'}${HTML_BODY.test(text) ? '，且 body 是 HTML 文件（SPA fallback）' : ''}。`};
    }
  }

  let body = null;
  if (mediaType(expectation.expectedContentType) === 'application/json' || expectation.expectedJsonShape) {
    try { body = JSON.parse(text); }
    catch (error) {
      return {...result, failureKind: 'unexpected_content_type', detail: `回應宣稱是 JSON 但無法解析：${String(error?.message || error).slice(0, 120)}`};
    }
  }

  if (expectation.expectedJsonShape) {
    if (!body || typeof body !== 'object') return {...result, failureKind: 'unexpected_content_type', detail: 'JSON body 不是物件，無法比對預期結構。'};
    for (const [key, value] of Object.entries(expectation.expectedJsonShape)) {
      if (!(key in body)) return {...result, failureKind: 'unexpected_content_type', detail: `JSON body 缺少欄位 ${key}。`};
      if (value !== null && body[key] !== value) return {...result, failureKind: 'unexpected_content_type', detail: `欄位 ${key} 期待 ${JSON.stringify(value)}，實際 ${JSON.stringify(body[key])}。`};
    }
  }

  return {...result, passed: true, body};
}

const join = (base, path) => `${String(base).replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

export function healthCheckUrl(service, baseUrl) {
  const check = service?.healthCheck;
  if (!check) return null;
  if (check.url) return check.url;
  return join(baseUrl, check.path || '/');
}

/**
 * 等一個 service 真的 ready。PID 存在不算 ready（計畫書第十一章）：一定要拿到符合契約的
 * HTTP 回應。中途子程序自己死掉時立刻停止等待——再等下去只是把 service_start_failed
 * 誤報成 runtime_timeout。
 */
export async function waitForServiceHealth(service, baseUrl, {timeoutMs = 30000, pollMs = 300, fetchImpl = fetch, isAlive = () => true, clock = Date.now} = {}) {
  const url = healthCheckUrl(service, baseUrl);
  const expectation = {
    expectedStatus: service.healthCheck?.expectedStatus ?? null,
    expectedContentType: service.healthCheck?.expectedContentType ?? null,
    expectedJsonShape: service.healthCheck?.expectedJsonShape ?? null,
    anyHttpResponse: service.healthCheck?.anyHttpResponse === true,
  };
  if (!url) return {passed: true, skipped: true, detail: '這個 service 沒有宣告 health check。'};
  const deadline = clock() + timeoutMs;
  let last = {passed: false, failureKind: 'service_not_started', detail: '尚未收到任何回應。'};
  while (clock() < deadline) {
    if (!isAlive()) return {...last, passed: false, failureKind: 'service_start_failed', url, detail: `${service.id} 的程序在健康檢查完成前就結束了：${last.detail || ''}`.trim()};
    last = await validateApiResponse(url, expectation, {fetchImpl, timeoutMs: Math.min(3000, timeoutMs)});
    if (last.passed) return {...last, url};
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return {...last, url, passed: false, failureKind: last.failureKind === 'service_unhealthy' ? 'service_unhealthy' : 'runtime_timeout', detail: `${service.id} 在 ${Math.round(timeoutMs / 1000)} 秒內沒有通過健康檢查：${last.detail || '未收到有效回應'}`};
}

/** Frontend 自己也要驗，而且不能只看 port 有沒有人在聽（計畫書第十二章）。 */
export async function validateFrontendRoot(frontendUrl, {fetchImpl = fetch, timeoutMs = 10000, pollMs = 300, clock = Date.now} = {}) {
  const deadline = clock() + timeoutMs;
  let last = {passed: false, failureKind: 'service_not_started', detail: '尚未收到任何回應。'};
  while (clock() < deadline) {
    last = await validateApiResponse(frontendUrl, {expectedStatus: 200, expectedContentType: 'text/html'}, {fetchImpl, timeoutMs: 3000});
    if (last.passed) return {...last, name: 'frontend_root'};
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return {...last, name: 'frontend_root', failureKind: last.failureKind || 'runtime_timeout'};
}

/**
 * 本次整改的關鍵檢查：**從 frontend preview 的網址**去打後端 API。
 *
 * 直接打 backend port 只證明後端活著，證明不了前端那一層的轉發有沒有接上——而使用者
 * 在瀏覽器裡走的正是前端那一層。所以這裡刻意繞遠路，經過 frontend preview。
 */
export async function validateConnectivity({frontendUrl, probes = [], fetchImpl = fetch, timeoutMs = 5000} = {}) {
  const checks = [];
  for (const probe of probes) {
    const url = join(frontendUrl, probe.path);
    const outcome = await validateApiResponse(url, {
      expectedStatus: probe.expectedStatus ?? null,
      expectedContentType: probe.expectedContentType || 'application/json',
      expectedJsonShape: probe.expectedJsonShape || null,
      via: 'frontend',
    }, {fetchImpl, timeoutMs});
    checks.push({
      name: probe.name || `connectivity:${probe.path}`,
      method: 'GET',
      path: probe.path,
      expected: `${probe.expectedStatus ?? '2xx/4xx'} ${probe.expectedContentType || 'application/json'}`,
      actual: outcome.passed ? `${outcome.status} ${outcome.contentType}` : `${outcome.status ?? '無回應'} ${outcome.contentType || ''}`.trim(),
      passed: outcome.passed,
      failureKind: outcome.failureKind,
      detail: outcome.detail,
      url,
    });
  }
  const failed = checks.find(check => !check.passed);
  return {passed: !failed, checks, failureKind: failed?.failureKind || null, detail: failed?.detail || null};
}

/**
 * 沒有登入也應該回 JSON 的探針。401/403 都算「後端真的接到了」——重點是 Content-Type，
 * 不是狀態碼。只有 200-but-HTML 才是我們要抓的那個假陽性。
 */
export function defaultConnectivityProbes(service, {extraPaths = []} = {}) {
  const health = service?.healthCheck?.path;
  const paths = [...new Set([health, ...extraPaths].filter(path => typeof path === 'string' && path.startsWith('/')))];
  return paths.map(path => ({path, name: `frontend_proxy:${path}`, expectedContentType: 'application/json', expectedStatus: null}));
}
