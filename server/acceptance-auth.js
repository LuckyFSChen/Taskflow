// 驗收身份執行期（Acceptance Authentication Runtime）。
//
// 解決的問題很具體：需要登入的 Preview 專案，部署驗收永遠停在 /api/login 401。
// 根因是「產生帳密」與「帳密真的送到 Preview」是兩件各自為政的事——密碼每次重新亂數產生，
// 但只在 Preview 資料庫「完全沒有使用者」時才寫進去，而 Preview 資料庫是跨次保留的。
// 第二次之後，validator 手上的密碼與 Preview 裡的雜湊永遠對不起來。
//
// 這個模組把那條資料流收斂成單一物件 AcceptanceContext：帳密由它產生，Preview 與
// Validator 都只能從它拿，不得各自產生、也不得讀取專案正式 .env 的任何密碼。
//
// 四個不可妥協的原則：
//   1. 驗收身份是一次性的，只存在於 Preview 執行期間；驗收結束立刻銷毀。
//   2. 絕不使用專案的正式帳密，也不寫死任何測試帳密。
//   3. 完整的 password／token／cookie 不得離開這個行程的記憶體與子程序環境變數——
//      log、資料庫、任務結果、UI、通知一律只能看到遮蔽後的值。
//   4. 認證失敗必須回報**可判讀的代碼**與**責任歸屬**（TaskFlow 基礎設施 vs 專案缺陷），
//      不是一句「需要登入（尚未認證）」。
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUTH_MODES = ['none', 'credentials', 'bearer', 'custom'];

/** 專案可以放在根目錄，用來明確宣告驗收要怎麼登入。有這個檔就不做任何猜測。 */
export const ACCEPTANCE_CONFIG_FILE = 'taskflow.acceptance.json';

export const ACCEPTANCE_USERNAME = 'taskflow-preview';

/** 沒有設定檔時的預設登入端點；discovery 只在預設端點回 404 時才往下試。 */
const LOGIN_PATH_CANDIDATES = ['/api/login', '/login', '/api/auth/login'];

/** 沒有設定檔時的預設登入欄位；只有在伺服器回「欄位不對」(400/422) 時才換下一組。 */
const LOGIN_BODY_CANDIDATES = [
  { username: '$acceptance.username', password: '$acceptance.password' },
  { email: '$acceptance.email', password: '$acceptance.password' },
];

const DEFAULT_STATE_PATH = '/api/state';

/**
 * 認證失敗代碼。category 決定這次失敗該算在誰頭上——這一點直接影響使用者要做什麼：
 *   taskflow_infrastructure：TaskFlow 自己沒把驗收身份準備好，不是專案的錯，不得判成「專案驗收失敗」。
 *   project_defect：專案的登入真的壞了或帳密不被接受，這才是驗收失敗。
 *   preview_runtime：Preview 程序或網路層的問題，兩邊都還沒證明對錯。
 */
export const FAILURE_CODES = {
  credentials_missing: { category: 'taskflow_infrastructure', message: 'TaskFlow 沒有為這次驗收產生一次性帳密，登入無法進行。' },
  credentials_not_injected: { category: 'taskflow_infrastructure', message: 'TaskFlow 產生了一次性帳密，但沒有成功送進 Preview 執行環境。' },
  session_not_propagated: { category: 'taskflow_infrastructure', message: '登入成功但沒有取得可用的工作階段（cookie 或 token），後續請求無法帶上身份。' },
  login_endpoint_not_found: { category: 'project_defect', message: '找不到登入端點：這個路徑不存在，屬於架構缺陷，不是「未登入的正常行為」。' },
  login_payload_invalid: { category: 'project_defect', message: '登入端點不接受這組欄位（例如要的是 email 而不是 username）。' },
  authentication_failed: { category: 'project_defect', message: '登入端點拒絕了這組一次性驗收帳密。' },
  login_server_error: { category: 'project_defect', message: '登入端點發生伺服器內部錯誤。' },
  login_unreachable: { category: 'preview_runtime', message: 'Preview 沒有回應登入請求。' },
  auth_mode_unsupported: { category: 'taskflow_infrastructure', message: '這個專案宣告的認證方式 TaskFlow 尚未支援，驗收無法進行。' },
};

export function failureCategory(code) {
  return FAILURE_CODES[code]?.category || 'taskflow_infrastructure';
}

// --- 設定檔 ------------------------------------------------------------------

function normaliseRequest(value, fallbackPath) {
  if (!value || typeof value !== 'object') return null;
  const path = typeof value.path === 'string' && value.path.startsWith('/') ? value.path : fallbackPath;
  if (!path) return null;
  const method = typeof value.method === 'string' ? value.method.toUpperCase() : 'POST';
  const body = value.body && typeof value.body === 'object' && !Array.isArray(value.body) ? value.body : null;
  return { method, path, body };
}

/**
 * 讀取專案宣告的驗收設定。讀不到、格式不對一律回 null——設定檔是選用的，
 * 但只要存在就以它為準，絕不混用猜測。
 */
export function loadAcceptanceConfig(projectPath, { read = readFileSync } = {}) {
  if (!projectPath) return null;
  let parsed;
  try { parsed = JSON.parse(read(join(projectPath, ACCEPTANCE_CONFIG_FILE), 'utf8')); }
  catch { return null; }
  const authentication = parsed?.authentication;
  if (!authentication || typeof authentication !== 'object') return null;
  const mode = AUTH_MODES.includes(authentication.mode) ? authentication.mode : null;
  if (!mode) return null;
  return {
    mode,
    login: normaliseRequest(authentication.login, LOGIN_PATH_CANDIDATES[0]),
    state: normaliseRequest(authentication.state || parsed?.state, DEFAULT_STATE_PATH),
    sessionType: ['cookie', 'bearer'].includes(authentication.session?.type) ? authentication.session.type : null,
  };
}

// --- AcceptanceContext -------------------------------------------------------

/**
 * 建立這次 Preview 的驗收身份。帳密在這裡產生，之後 Preview 與 Validator 都只能從
 * 這個物件拿；任何一邊自己再產生一組，就是把 401 重新製造出來。
 */
export function createAcceptanceContext({ projectPath = null, key = null, config = undefined, secret = () => randomBytes(18).toString('base64url') } = {}) {
  const resolved = config === undefined ? loadAcceptanceConfig(projectPath) : config;
  const mode = resolved?.mode || 'credentials';
  const username = ACCEPTANCE_USERNAME;
  const password = secret();
  const token = secret();
  return {
    id: randomUUID(),
    key,
    mode,
    source: resolved ? 'config' : 'default',
    username,
    email: `${username}@taskflow.invalid`,
    password,
    token,
    login: resolved?.login || null,
    statePath: resolved?.state?.path || DEFAULT_STATE_PATH,
    sessionType: resolved?.sessionType || null,
    // Preview 那一端到底收到了什麼，由 project-preview.js 如實填進來。
    // 兩條路都沒送成功時，401 是 TaskFlow 自己的問題，不得算在專案頭上。
    injection: { environment: false, database: false, error: null },
    session: { cookie: null, authorization: null, type: null },
  };
}

/** 注入 Preview 子程序的環境變數。完整密碼只在這裡與 child process 之間傳遞。 */
export function acceptanceEnvironment(context) {
  if (!context) return {};
  return {
    TASKFLOW_ACCEPTANCE_MODE: '1',
    TASKFLOW_ACCEPTANCE_ID: context.id,
    TASKFLOW_ACCEPTANCE_AUTH_MODE: context.mode,
    TASKFLOW_ACCEPTANCE_USERNAME: context.username,
    TASKFLOW_ACCEPTANCE_EMAIL: context.email,
    TASKFLOW_ACCEPTANCE_PASSWORD: context.password,
    TASKFLOW_ACCEPTANCE_TOKEN: context.token,
  };
}

/** $acceptance.xxx 佔位符換成這次的真值。只認白名單欄位，不做任意取值。 */
export function resolveTemplate(value, context) {
  if (typeof value === 'string' && value.startsWith('$acceptance.')) {
    const field = value.slice('$acceptance.'.length);
    return ['username', 'email', 'password', 'token', 'id'].includes(field) ? context[field] : value;
  }
  if (Array.isArray(value)) return value.map(item => resolveTemplate(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplate(v, context)]));
  return value;
}

/** 後續請求要帶的身份。沒有工作階段就回空物件，絕不用未認證的請求假裝驗過。 */
export function authenticatedHeaders(context) {
  const session = context?.session;
  if (!session) return {};
  return {
    ...(session.cookie ? { Cookie: session.cookie } : {}),
    ...(session.authorization ? { Authorization: session.authorization } : {}),
  };
}

export function hasSession(context) {
  return !!(context?.session?.cookie || context?.session?.authorization);
}

/**
 * 把敏感值從任何要外流的字串裡拿掉。診斷訊息、log、任務結果都必須先過這一關。
 * 用固定遮罩字串，不保留長度也不保留前綴——長度本身就是線索。
 */
export function maskSecrets(text, context) {
  if (text === null || text === undefined) return text;
  let output = String(text);
  const secrets = [context?.password, context?.token, context?.session?.cookie, context?.session?.authorization]
    .filter(value => typeof value === 'string' && value.length >= 6);
  for (const secret of secrets) output = output.split(secret).join('[redacted]');
  // cookie 值可能被伺服器改寫過（例如 tf_session=<新值>），字串比對抓不到，靠形狀再掃一次。
  output = output.replace(/((?:set-)?cookie"?\s*[:=]\s*"?)[^\s",;}]+/gi, '$1[redacted]')
    .replace(/(authorization"?\s*[:=]\s*"?)(?:bearer\s+)?[^\s",}]+/gi, '$1[redacted]')
    .replace(/("?(?:password|token|accessToken|access_token|jwt)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1[redacted]');
  return output;
}

/** 驗收結束：把祕密從記憶體抹掉。物件本身留著，讓呼叫端還看得到 id 與結果。 */
export function cleanupAcceptanceContext(context) {
  if (!context) return null;
  context.password = null;
  context.token = null;
  context.session = { cookie: null, authorization: null, type: null };
  context.cleaned = true;
  return context;
}

// --- 登入 --------------------------------------------------------------------

function collectSetCookie(response) {
  const raw = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers?.get?.('set-cookie')].filter(Boolean);
  const pairs = raw.map(entry => String(entry).split(';')[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

function findToken(json) {
  if (!json || typeof json !== 'object') return null;
  for (const key of ['token', 'accessToken', 'access_token', 'jwt', 'idToken']) {
    if (typeof json[key] === 'string' && json[key]) return json[key];
  }
  for (const nested of ['data', 'result', 'session']) {
    const value = findToken(json[nested]);
    if (value) return value;
  }
  return null;
}

async function postLogin(fetchImpl, url, path, { method, body, timeoutMs }) {
  const response = await fetchImpl(`${url}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null, text = '';
  try { text = await response.text(); json = JSON.parse(text); } catch { /* 不是 JSON 就只留原文 */ }
  return { status: response.status, json, text, setCookie: collectSetCookie(response) };
}

function statusFailureCode(status) {
  if (status === 404) return 'login_endpoint_not_found';
  if (status === 400 || status === 422) return 'login_payload_invalid';
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status >= 500) return 'login_server_error';
  return 'authentication_failed';
}

function outcome(context, patch) {
  const failureCode = patch.failureCode || null;
  return {
    mode: context.mode,
    attempted: true,
    passed: false,
    endpoint: null,
    status: null,
    sessionType: null,
    failureCode,
    failureCategory: failureCode ? failureCategory(failureCode) : null,
    detail: failureCode ? FAILURE_CODES[failureCode]?.message || '' : '',
    responseBody: null,
    ...patch,
  };
}

/**
 * 取得這次驗收的身份。成功時把工作階段寫回 context.session，讓 API 驗收與
 * Browser Validation 共用同一個身份，不會各自登入成兩個不同的人。
 */
export async function authenticatePreview({ context, url, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!context) return outcome({ mode: 'credentials' }, { attempted: false, failureCode: 'credentials_missing' });

  if (context.mode === 'none') {
    return outcome(context, { attempted: false, passed: true, failureCode: null, detail: '這個專案宣告不需要登入。' });
  }

  if (context.mode === 'custom') {
    return outcome(context, { failureCode: 'auth_mode_unsupported', detail: '專案宣告 custom 認證，但沒有提供可執行的 acceptance adapter。' });
  }

  if (context.mode === 'bearer') {
    if (!context.token) return outcome(context, { attempted: false, failureCode: 'credentials_missing' });
    if (!context.injection?.environment) return outcome(context, { attempted: false, failureCode: 'credentials_not_injected' });
    context.session = { cookie: null, authorization: `Bearer ${context.token}`, type: 'bearer' };
    return outcome(context, { passed: true, failureCode: null, sessionType: 'bearer', detail: '使用注入 Preview 的一次性 token，不需要登入端點。' });
  }

  // credentials 模式
  if (!context.username || !context.password) return outcome(context, { attempted: false, failureCode: 'credentials_missing' });
  if (!context.injection?.environment && !context.injection?.database) {
    return outcome(context, {
      attempted: false,
      failureCode: 'credentials_not_injected',
      detail: `${FAILURE_CODES.credentials_not_injected.message}${context.injection?.error ? `（${maskSecrets(context.injection.error, context)}）` : ''}`,
    });
  }

  // 設定檔優先；沒有設定檔才用有限的 convention detection，而且只在 404 時往下試。
  const paths = context.login?.path ? [context.login.path] : LOGIN_PATH_CANDIDATES;
  const bodies = context.login?.body ? [context.login.body] : LOGIN_BODY_CANDIDATES;
  const method = context.login?.method || 'POST';
  let last = null;
  const tried = [];

  for (const path of paths) {
    for (const template of bodies) {
      let response;
      try { response = await postLogin(fetchImpl, url, path, { method, body: resolveTemplate(template, context), timeoutMs }); }
      catch (error) {
        return outcome(context, { endpoint: `${method} ${path}`, failureCode: 'login_unreachable', detail: maskSecrets(String(error?.message || error), context).slice(0, 200) });
      }

      const endpoint = `${method} ${path}`;
      const fields = Object.keys(template).join(',');
      tried.push(endpoint);

      if (response.status >= 200 && response.status < 300) {
        const cookie = response.setCookie;
        const token = findToken(response.json);
        if (!cookie && !token) {
          return outcome(context, { endpoint, status: response.status, failureCode: 'session_not_propagated', responseBody: maskSecrets(response.text, context).slice(0, 300) });
        }
        context.session = {
          cookie,
          authorization: token ? `Bearer ${token}` : null,
          type: cookie && token ? 'cookie+bearer' : cookie ? 'cookie' : 'bearer',
        };
        return outcome(context, { passed: true, endpoint, status: response.status, failureCode: null, sessionType: context.session.type, detail: `登入成功，工作階段型態：${context.session.type}。`, requestFields: fields });
      }

      last = outcome(context, {
        endpoint,
        status: response.status,
        failureCode: statusFailureCode(response.status),
        responseBody: maskSecrets(response.text, context).slice(0, 300),
        requestFields: fields,
      });

      // 只有「欄位不對」才換下一組欄位；401 換欄位只是把同一個錯誤再問一次。
      if (last.failureCode !== 'login_payload_invalid') break;
    }
    // 只有「這個路徑不存在」才往下找別的路徑。
    if (last?.failureCode !== 'login_endpoint_not_found') break;
  }

  if (!last) return outcome(context, { failureCode: 'authentication_failed' });
  // 所有候選路徑都不存在時，回報的是**專案宣告或預設的**那一個端點，
  // 後面附上實際試過哪些；不要把 discovery 的最後一個候選講得像專案本來的設計。
  if (last.failureCode === 'login_endpoint_not_found') {
    const endpoints = [...new Set(tried)];
    last.endpoint = `${method} ${paths[0]}`;
    last.triedEndpoints = endpoints;
    if (endpoints.length > 1) last.detail += `實際嘗試過的路徑：${endpoints.join('、')}。`;
  }
  return last;
}

/**
 * 給人看的安全版診斷。刻意列出「有沒有注入」「打了哪個端點」「送了哪些欄位」，
 * 因為 401 的除錯價值全在這三件事上；password／token／cookie 一律不得出現。
 */
export function authenticationDiagnostic(context, result) {
  if (!result) return null;
  return {
    mode: result.mode,
    endpoint: result.endpoint,
    status: result.status,
    failureCode: result.failureCode,
    failureCategory: result.failureCategory,
    credentialsInjected: !!(context?.injection?.environment || context?.injection?.database),
    injection: {
      environment: !!context?.injection?.environment,
      database: !!context?.injection?.database,
      error: context?.injection?.error ? maskSecrets(context.injection.error, context).slice(0, 200) : null,
    },
    requestFields: result.requestFields || null,
    responseBody: result.responseBody || null,
    configSource: context?.source || null,
  };
}
