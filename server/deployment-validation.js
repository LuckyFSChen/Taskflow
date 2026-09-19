// 部署後的結構化 API 驗收。
//
// 取代的行為：目前這一段要嘛由人開 PowerShell 打 curl.exe，要嘛由 AI 用自然語言宣稱
// 「頁面看起來正常」。兩者都不是可稽核的結論。這裡改成固定的驗收階段、固定的判定規則，
// 結果是結構化的證據（每一項的預期、實際、通過與否，以及失敗在哪一層）。
//
// 四個不可妥協的判定規則：
//   1. 狀態碼的意義不可混用。404 代表這個 Preview 缺少該路由，是架構缺陷；
//      401 代表尚未登入；403 代表已登入但權限不足。不得把 404 說成「未登入的正常行為」。
//   2. 核心 API 回 404 時，即使頁面本身載得起來，也不得宣稱驗收通過。
//   3. 做不到的檢查一律標成未通過，不是略過。沒有帳密、連不上、逾時——都不是通過。
//   4. 認證失敗要說得出是哪一種失敗（failureCode）與該算在誰頭上（failureCategory）。
//      「需要登入（尚未認證）」對除錯沒有價值，不得當成最終結論。
//
// 這個模組只做 HTTP 層的驗收，不啟動也不停止任何程序（那是呼叫端的事），
// 也不取代 Browser Validation：畫面互動仍然需要真的開瀏覽器。
import {
  authenticatePreview,
  authenticatedHeaders,
  authenticationDiagnostic,
  createAcceptanceContext,
  maskSecrets,
} from './acceptance-auth.js';

export const DEPLOYMENT_CHECK_NAMES = ['health', 'login', 'state'];

/** 驗收狀態機。UI 靠這個知道「到底走到哪一層才斷掉」，而不是只看到一句失敗。 */
export const VALIDATION_STATES = [
  'PREVIEW_READY', 'HEALTH_VALIDATED', 'AUTHENTICATING', 'AUTHENTICATED', 'API_VALIDATED', 'PASSED',
];
export const VALIDATION_FAILURE_STATES = ['HEALTH_FAILED', 'AUTH_FAILED', 'API_FAILED'];

const STATUS_MEANING = {
  404: '這個路徑不存在：服務缺少該 API，屬於架構缺陷，不是「未登入的正常行為」。',
  401: '需要登入（尚未認證）。',
  403: '已認證但權限不足。',
  500: '伺服器內部錯誤。',
};

const CATEGORY_LABEL = {
  taskflow_infrastructure: 'TaskFlow 驗收基礎設施',
  project_defect: '專案',
  preview_runtime: 'Preview 執行環境',
};

const describe = status => STATUS_MEANING[status] || `HTTP ${status}`;

function check(name, method, path, expected, { passed, actual, detail = '' }) {
  return { name, method, path, expected, actual, passed, detail };
}

async function request(fetchImpl, url, path, { method = 'GET', body = null, headers = {}, timeoutMs }) {
  const response = await fetchImpl(`${url}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await response.json(); } catch { /* 不是 JSON 就讓檢查自己判定失敗 */ }
  return { status: response.status, json };
}

/** 舊呼叫端只給 {username,password}；包成 credentials 模式的 context，行為完全不變。 */
function toContext(acceptance, credentials) {
  if (acceptance) return acceptance;
  if (!credentials?.username || !credentials?.password) return null;
  const context = createAcceptanceContext({ config: null });
  context.username = credentials.username;
  context.password = credentials.password;
  context.email = credentials.email || context.email;
  // 舊路徑沒有注入回報，但帳密確實是呼叫端從 Preview 拿到的，視為已送達。
  context.injection = { environment: true, database: true, error: null };
  return context;
}

function authDetail(result) {
  const parts = [];
  if (result.status) parts.push(describe(result.status));
  if (result.detail) parts.push(result.detail);
  if (result.failureCode) parts.push(`failureCode=${result.failureCode}（責任歸屬：${CATEGORY_LABEL[result.failureCategory] || result.failureCategory}）`);
  return parts.join(' ');
}

/**
 * 對一個已啟動的服務（正式或 Preview）執行結構化驗收。
 * @param {object} options
 * @param {string} options.url 例如 http://127.0.0.1:61347
 * @param {object|null} options.acceptance AcceptanceContext（server/acceptance-auth.js）
 * @param {{username:string,password:string}|null} options.credentials 舊介面：一次性帳密
 */
export async function validateDeployment({ url, acceptance = null, credentials = null, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const checks = [];
  const at = new Date().toISOString();
  const context = toContext(acceptance, credentials);
  const states = ['PREVIEW_READY'];
  const result = {
    at,
    url,
    passed: false,
    state: 'PREVIEW_READY',
    states,
    checks,
    health: { passed: false, status: null },
    authentication: { required: false, attempted: false, passed: false, mode: context?.mode || null, endpoint: null, status: null, failureCode: null, failureCategory: null, diagnostic: null },
    apiState: { attempted: false, passed: false, status: null, skippedReason: null },
  };

  // 1) 健康檢查：要的不只是 200，還要是 TaskFlow 自己的回應格式。
  try {
    const { status, json } = await request(fetchImpl, url, '/api/health', { timeoutMs });
    const shaped = json?.ok === true && json?.service === 'taskflow';
    result.health = { passed: status === 200 && shaped, status };
    checks.push(check('health', 'GET', '/api/health', '200 且 {ok:true,service:"taskflow"}', {
      passed: result.health.passed,
      actual: `HTTP ${status}${json ? ` ${JSON.stringify(json).slice(0, 120)}` : ''}`,
      detail: status !== 200 ? describe(status) : shaped ? '' : '回應格式不是 TaskFlow 的健康檢查結果。',
    }));
  } catch (error) {
    checks.push(check('health', 'GET', '/api/health', '200 且 {ok:true,service:"taskflow"}', {
      passed: false, actual: '沒有回應', detail: String(error?.message || error).slice(0, 200),
    }));
  }
  states.push(result.health.passed ? 'HEALTH_VALIDATED' : 'HEALTH_FAILED');
  result.state = states.at(-1);

  // 2) 認證：這是一個正式的驗收階段，不是一個普通的 HTTP 請求。
  const authRequired = context?.mode !== 'none';
  result.authentication.required = authRequired;
  result.authentication.mode = context?.mode || null;

  if (!context) {
    // 沒有驗收身份：這是 TaskFlow 自己的問題，而且做不到的檢查一律標成未通過，不是略過。
    result.authentication = {
      ...result.authentication,
      required: true, attempted: false, passed: false, mode: 'credentials',
      failureCode: 'credentials_missing', failureCategory: 'taskflow_infrastructure',
      diagnostic: { credentialsInjected: false, failureCode: 'credentials_missing', failureCategory: 'taskflow_infrastructure' },
    };
    checks.push(check('login', 'POST', '/api/login', '200', {
      passed: false, actual: '未執行',
      detail: '沒有可用的一次性驗收帳密，登入無法進行（未通過，不是略過）。failureCode=credentials_missing（責任歸屬：TaskFlow 驗收基礎設施）',
    }));
    checks.push(check('state', 'GET', '/api/state', '200', {
      passed: false, actual: '未執行',
      detail: '沒有可用的一次性驗收帳密，這一項無法驗證（未通過，不是略過）。',
    }));
    result.apiState.skippedReason = 'credentials_missing';
    result.state = 'AUTH_FAILED';
    states.push('AUTH_FAILED');
    return result;
  }

  states.push('AUTHENTICATING');
  const auth = await authenticatePreview({ context, url, fetchImpl, timeoutMs });
  result.authentication = {
    ...result.authentication,
    attempted: auth.attempted,
    passed: auth.passed,
    mode: auth.mode,
    endpoint: auth.endpoint,
    status: auth.status,
    sessionType: auth.sessionType || null,
    failureCode: auth.failureCode,
    failureCategory: auth.failureCategory,
    diagnostic: authenticationDiagnostic(context, auth),
  };
  states.push(auth.passed ? 'AUTHENTICATED' : 'AUTH_FAILED');
  result.state = states.at(-1);

  const loginPath = auth.endpoint ? auth.endpoint.split(' ')[1] : (context.login?.path || '/api/login');
  const loginMethod = auth.endpoint ? auth.endpoint.split(' ')[0] : (context.login?.method || 'POST');
  checks.push(check('login', loginMethod, loginPath, authRequired ? '200 並取得可用的工作階段' : '不需要登入', {
    passed: auth.passed,
    actual: auth.status ? `HTTP ${auth.status}` : auth.attempted ? '沒有回應' : authRequired ? '未執行' : '不需要登入',
    detail: authDetail(auth),
  }));

  // 3) 狀態查詢：沒有身份就直接判未通過，不用未認證的請求假裝驗過。
  const statePath = context.statePath || '/api/state';
  if (!auth.passed) {
    result.apiState.skippedReason = auth.failureCode || 'authentication_failed';
    checks.push(check('state', 'GET', statePath, '200 且包含 user 與 tasks', {
      passed: false, actual: '未執行',
      detail: `登入沒有成功，無法驗證已認證的狀態查詢（skippedReason=${result.apiState.skippedReason}）。`,
    }));
    return result;
  }

  const strictShape = context.source !== 'config';
  try {
    result.apiState.attempted = true;
    const { status, json } = await request(fetchImpl, url, statePath, { headers: authenticatedHeaders(context), timeoutMs });
    const shaped = strictShape ? (!!json?.user && Array.isArray(json?.tasks)) : true;
    result.apiState = { ...result.apiState, passed: status === 200 && shaped, status, skippedReason: null };
    // 登入成功卻在這裡被擋下來，代表工作階段沒有正確帶到後續請求——那是 TaskFlow 的問題。
    if (status === 401 || status === 403) {
      result.authentication.failureCode = 'session_not_propagated';
      result.authentication.failureCategory = 'taskflow_infrastructure';
    }
    checks.push(check('state', 'GET', statePath, strictShape ? '200 且包含 user 與 tasks' : '200', {
      passed: result.apiState.passed,
      actual: `HTTP ${status}`,
      detail: status !== 200
        ? `${describe(status)}${status === 401 || status === 403 ? ' 登入已經成功，卻仍被擋下：工作階段沒有帶到後續請求。failureCode=session_not_propagated（責任歸屬：TaskFlow 驗收基礎設施）' : ''}`
        : shaped ? '' : '回應缺少 user 或 tasks 欄位。',
    }));
  } catch (error) {
    checks.push(check('state', 'GET', statePath, strictShape ? '200 且包含 user 與 tasks' : '200', {
      passed: false, actual: '沒有回應', detail: maskSecrets(String(error?.message || error), context).slice(0, 200),
    }));
  }
  states.push(result.apiState.passed ? 'API_VALIDATED' : 'API_FAILED');
  result.state = states.at(-1);

  result.passed = checks.every(item => item.passed);
  if (result.passed) { states.push('PASSED'); result.state = 'PASSED'; }
  return result;
}
