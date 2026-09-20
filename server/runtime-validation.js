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

// 我們真正要抓的是「請求落進了前端的 SPA fallback」，也就是拿到一份**完整的 HTML 文件**。
// 這跟 express `res.redirect()` 那種 `<p>Moved Permanently…</p>` 的小 HTML 片段不同，
// 也跟後端自己回的一頁錯誤訊息不同。只看 Content-Type 是 text/html 會把 301 redirect
// 誤判成 proxy 失敗——那正是把 /uploads 判死的原因。
const HTML_DOCUMENT = /<!doctype html|<html[\s>]/i;

function mediaType(header) {
  return String(header || '').split(';')[0].trim().toLowerCase();
}

function looksLikeSpaFallback(contentType, text) {
  return mediaType(contentType) === 'text/html' && HTML_DOCUMENT.test(text || '');
}

const matchesPrefix = (path, prefix) => {
  if (prefix === '/') return true;
  const clean = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === clean || path.startsWith(`${clean}/`);
};

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

  const spaFallback = looksLikeSpaFallback(contentType, text);

  if (expectation.anyHttpResponse) {
    // 「有回應就算通過」的最弱模式，但仍然要排除 SPA fallback：後端如果回的是 HTML 首頁，
    // 那多半代表我們打到的是前端而不是後端。
    if (spaFallback) {
      return {...result, failureKind: expectation.via === 'frontend' ? 'proxy_routing_failure' : 'unexpected_content_type', detail: `期待後端回應，實際收到 HTML 文件（${contentType || '未標示型別'}），這是前端的 SPA fallback。`};
    }
    return {...result, passed: true};
  }

  // static／媒體 namespace 的判準：唯一不可接受的是「落進 SPA fallback」。
  // 301 導向、404 找不到檔案、200 image/*、200 application/pdf 全都是合法的轉發結果。
  if (expectation.mode === 'not_spa_fallback') {
    if (status >= 300 && status < 400) return {...result, passed: true, detail: `${status} 導向，未落入 SPA fallback。`};
    if (spaFallback) {
      return {...result, failureKind: expectation.via === 'frontend' ? 'proxy_routing_failure' : 'unexpected_content_type', detail: `落進前端的 SPA fallback：${status} ${contentType}，body 是完整的 HTML 文件。`};
    }
    return {...result, passed: true, detail: `${status} ${contentType || '未標示型別'}，未落入 SPA fallback。`};
  }

  if (expectation.expectedStatus != null && status !== expectation.expectedStatus) {
    return {...result, failureKind: 'service_unhealthy', detail: `期待 HTTP ${expectation.expectedStatus}，實際 ${status}。`};
  }

  if (expectation.expectedContentType) {
    const expected = mediaType(expectation.expectedContentType);
    if (contentType !== expected) {
      // 這是整個整改的核心判定：200 + text/html 而我們要的是 JSON，就是 routing／proxy 壞了。
      const kind = spaFallback
        ? (expectation.via === 'frontend' ? 'proxy_routing_failure' : 'unexpected_content_type')
        : 'unexpected_content_type';
      return {...result, failureKind: kind, detail: `expected ${expected}, received ${contentType || '（未標示 Content-Type）'}${spaFallback ? '，且 body 是 HTML 文件（SPA fallback）' : ''}。`};
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
export async function validateConnectivity({frontendUrl, probes = [], skipped = [], fetchImpl = fetch, timeoutMs = 5000} = {}) {
  const checks = [];
  for (const probe of probes) {
    const url = join(frontendUrl, probe.path);
    const isStatic = probe.kind === 'static';
    const outcome = await validateApiResponse(url, {
      expectedStatus: probe.expectedStatus ?? null,
      expectedContentType: isStatic ? null : (probe.expectedContentType || 'application/json'),
      expectedJsonShape: probe.expectedJsonShape || null,
      mode: isStatic ? 'not_spa_fallback' : 'json',
      via: 'frontend',
    }, {fetchImpl, timeoutMs});
    checks.push({
      name: probe.name || `frontend_proxy:${probe.path}`,
      method: 'GET',
      path: probe.path,
      kind: probe.kind || 'api',
      expected: isStatic ? '任何非 SPA fallback 的回應' : `${probe.expectedStatus ?? '任意狀態碼'} ${probe.expectedContentType || 'application/json'}`,
      actual: `${outcome.status ?? '無回應'} ${outcome.contentType || ''}`.trim(),
      passed: outcome.passed,
      failureKind: outcome.failureKind,
      detail: outcome.detail,
      source: probe.source || null,
      url,
    });
  }
  // 驗不到的項目標成 skipped 並說明原因，不是靜靜放行、也不是判失敗。
  for (const item of skipped) {
    checks.push({name: item.name, method: '—', path: item.path || null, kind: item.kind || 'static', expected: '—', actual: '未驗證', passed: true, skipped: true, failureKind: null, detail: item.reason, url: null});
  }
  const failed = checks.find(check => !check.passed);
  return {passed: !failed, checks, failureKind: failed?.failureKind || null, detail: failed?.detail || null};
}

/**
 * 決定「要打哪些端點」來證明前端到後端的轉發真的通了。
 *
 * 這裡有一個曾經搞錯的區別，必須寫清楚：
 *
 *   proxyPaths 是 **namespace**——`/api` 的意思是「`/api/*` 轉發給後端」，
 *   它**不**代表後端有實作 `GET /api`。拿 namespace 本身當端點去打，會得到
 *   一個完全合理的 404，然後被誤判成 proxy_routing_failure，接著整組 runtime
 *   被沒必要地重啟兩次——真正的問題反而被這些 noise 蓋掉。
 *
 * 所以端點的來源只有三個，依序：
 *   1. service.validationProbes 明確宣告的端點
 *   2. 呼叫端另外指定的端點
 *   3. 後端 healthCheck.path（而且必須被某條 proxyPath 涵蓋）
 *
 * static namespace（/uploads、/static…）沒有可驗證的實際檔案時一律 skipped，
 * 不編一個路徑出來，也不要求它回 JSON。
 */
export function deriveConnectivityProbes(topology, entry, {extraProbes = []} = {}) {
  const probes = [], skipped = [];
  const proxies = (entry?.proxyPaths || []).map(item => (typeof item === 'string' ? {path: item, kind: 'api'} : item));
  const covered = path => proxies.find(proxy => matchesPrefix(path, proxy.path)) || null;
  const push = (probe, source) => {
    if (probes.some(item => item.path === probe.path)) return;
    probes.push({...probe, source});
  };

  for (const probe of entry?.validationProbes || []) push(probe, '專案宣告的 validationProbes');
  for (const probe of extraProbes) push(typeof probe === 'string' ? {path: probe, kind: 'api', expectedContentType: 'application/json'} : probe, '呼叫端指定');

  if (!probes.some(probe => (probe.kind || 'api') === 'api')) {
    for (const service of (topology?.services || []).filter(item => ['backend', 'worker'].includes(item.type))) {
      const path = service.healthCheck?.path;
      if (!path || !path.startsWith('/') || service.healthCheck?.inferred) {
        skipped.push({name: `frontend_proxy:${service.id}`, reason: `${service.id} 沒有可靠的健康檢查端點（偵測不到，或只是推測值），無法據此驗證前端到後端的轉發。請在 taskflow.runtime.json 的 validationProbes 指定一個實際端點。`});
        continue;
      }
      if (!covered(path)) {
        skipped.push({name: `frontend_proxy:${service.id}`, path, reason: `${service.id} 的健康檢查端點 ${path} 不在前端的轉發範圍（${proxies.map(proxy => proxy.path).join('、') || '無'}）內，無法經由前端驗證。`});
        continue;
      }
      push({path, kind: 'api', expectedStatus: null, expectedContentType: service.healthCheck.expectedContentType || 'application/json', expectedJsonShape: null}, `${service.id} 的健康檢查端點`);
    }
  }

  for (const proxy of proxies.filter(item => item.kind === 'static')) {
    if (probes.some(probe => matchesPrefix(probe.path, proxy.path))) continue;
    skipped.push({
      name: `frontend_proxy:${proxy.path}`, path: proxy.path, kind: 'static',
      reason: `${proxy.path} 是檔案／媒體 namespace，沒有可驗證的實際檔案。它合法地可能回 301、404 或二進位內容，因此不套用 JSON 驗證。要驗的話請在 validationProbes 指定一個確實存在的檔案路徑。`,
    });
  }

  return {probes, skipped};
}
