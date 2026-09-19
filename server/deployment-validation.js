// 部署後的結構化 API 驗收。
//
// 取代的行為：目前這一段要嘛由人開 PowerShell 打 curl.exe，要嘛由 AI 用自然語言宣稱
// 「頁面看起來正常」。兩者都不是可稽核的結論。這裡改成固定的三個檢查、固定的判定規則，
// 結果是結構化的證據（每一項的預期、實際、通過與否）。
//
// 三個不可妥協的判定規則：
//   1. 狀態碼的意義不可混用。404 代表這個 Preview 缺少該路由，是架構缺陷；
//      401 代表尚未登入；403 代表已登入但權限不足。不得把 404 說成「未登入的正常行為」。
//   2. 核心 API 回 404 時，即使頁面本身載得起來，也不得宣稱驗收通過。
//   3. 做不到的檢查一律標成未通過，不是略過。沒有帳密、連不上、逾時——都不是通過。
//
// 這個模組只做 HTTP 層的驗收，不啟動也不停止任何程序（那是呼叫端的事），
// 也不取代 Browser Validation：畫面互動仍然需要真的開瀏覽器。

export const DEPLOYMENT_CHECK_NAMES = ['health', 'login', 'state'];

const STATUS_MEANING = {
  404: '這個路徑不存在：服務缺少該 API，屬於架構缺陷，不是「未登入的正常行為」。',
  401: '需要登入（尚未認證）。',
  403: '已認證但權限不足。',
  500: '伺服器內部錯誤。',
};

const describe = status => STATUS_MEANING[status] || `HTTP ${status}`;

function check(name, method, path, expected, { passed, actual, detail = '' }) {
  return { name, method, path, expected, actual, passed, detail };
}

async function request(fetchImpl, url, path, { method = 'GET', body = null, cookie = null, timeoutMs }) {
  const response = await fetchImpl(`${url}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await response.json(); } catch { /* 不是 JSON 就讓檢查自己判定失敗 */ }
  return { status: response.status, json, setCookie: response.headers?.get?.('set-cookie') || null };
}

/**
 * 對一個已啟動的 TaskFlow 服務（正式或 Preview）執行三個結構化檢查。
 * @param {object} options
 * @param {string} options.url 例如 http://127.0.0.1:61347
 * @param {{username:string,password:string}|null} options.credentials 只給後端內部使用的一次性帳密
 */
export async function validateDeployment({ url, credentials = null, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const checks = [];
  const at = new Date().toISOString();

  // 1) 健康檢查：要的不只是 200，還要是 TaskFlow 自己的回應格式。
  try {
    const { status, json } = await request(fetchImpl, url, '/api/health', { timeoutMs });
    const shaped = json?.ok === true && json?.service === 'taskflow';
    checks.push(check('health', 'GET', '/api/health', '200 且 {ok:true,service:"taskflow"}', {
      passed: status === 200 && shaped,
      actual: `HTTP ${status}${json ? ` ${JSON.stringify(json).slice(0, 120)}` : ''}`,
      detail: status !== 200 ? describe(status) : shaped ? '' : '回應格式不是 TaskFlow 的健康檢查結果。',
    }));
  } catch (error) {
    checks.push(check('health', 'GET', '/api/health', '200 且 {ok:true,service:"taskflow"}', {
      passed: false, actual: '沒有回應', detail: String(error?.message || error).slice(0, 200),
    }));
  }

  // 沒有帳密就做不到登入與狀態查詢。做不到一律標成未通過，不是略過。
  if (!credentials?.username || !credentials?.password) {
    for (const [name, method, path] of [['login', 'POST', '/api/login'], ['state', 'GET', '/api/state']]) {
      checks.push(check(name, method, path, '200', { passed: false, actual: '未執行', detail: '沒有可用的一次性測試帳密，這兩項無法驗證（未通過，不是略過）。' }));
    }
    return { passed: false, at, url, checks };
  }

  // 2) 登入：核心 API 回 404 一律視為架構缺陷。
  let cookie = null;
  try {
    const { status, json, setCookie } = await request(fetchImpl, url, '/api/login', {
      method: 'POST', body: { username: credentials.username, password: credentials.password }, timeoutMs,
    });
    cookie = setCookie ? String(setCookie).split(';')[0] : null;
    checks.push(check('login', 'POST', '/api/login', '200 並取得工作階段 cookie', {
      passed: status === 200 && !!cookie,
      actual: `HTTP ${status}`,
      detail: status !== 200 ? describe(status) : cookie ? '' : '登入成功但沒有取得工作階段 cookie。',
    }));
    void json;
  } catch (error) {
    checks.push(check('login', 'POST', '/api/login', '200 並取得工作階段 cookie', {
      passed: false, actual: '沒有回應', detail: String(error?.message || error).slice(0, 200),
    }));
  }

  // 3) 狀態查詢：沒有 cookie 就直接判未通過，不用未認證的請求假裝驗過。
  if (!cookie) {
    checks.push(check('state', 'GET', '/api/state', '200 且包含 user 與 tasks', {
      passed: false, actual: '未執行', detail: '登入沒有成功，無法驗證已認證的狀態查詢。',
    }));
  } else {
    try {
      const { status, json } = await request(fetchImpl, url, '/api/state', { cookie, timeoutMs });
      const shaped = !!json?.user && Array.isArray(json?.tasks);
      checks.push(check('state', 'GET', '/api/state', '200 且包含 user 與 tasks', {
        passed: status === 200 && shaped,
        actual: `HTTP ${status}`,
        detail: status !== 200 ? describe(status) : shaped ? '' : '回應缺少 user 或 tasks 欄位。',
      }));
    } catch (error) {
      checks.push(check('state', 'GET', '/api/state', '200 且包含 user 與 tasks', {
        passed: false, actual: '沒有回應', detail: String(error?.message || error).slice(0, 200),
      }));
    }
  }

  return { passed: checks.every(item => item.passed), at, url, checks };
}
