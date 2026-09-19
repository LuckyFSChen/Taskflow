import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {validateDeployment} from '../server/deployment-validation.js';
import {createAcceptanceContext} from '../server/acceptance-auth.js';

// Preview 已經把身份注入進去的 AcceptanceContext。驗收流程要的前提只有這個。
function acceptance(config) {
  const context = createAcceptanceContext(config === undefined ? {} : {config});
  context.injection = {environment: true, database: true, error: null};
  return context;
}

// 起一個真的 HTTP 伺服器來驗：假的 fetch 很容易寫出「只有自己看得懂」的回應，
// 而這裡要確認的正是真實世界的狀態碼、header 與 JSON 解析。
async function server(t, routes) {
  const instance = createServer((req, res) => {
    const handler = routes[`${req.method} ${req.url.split('?')[0]}`];
    if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    handler(req, res);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const credentials = { username: 'taskflow-preview', password: 'secret' };
const healthy = { 'GET /api/health': (req, res) => json(res, 200, { ok: true, service: 'taskflow' }) };
const loginOk = { 'POST /api/login': (req, res) => json(res, 200, { id: 'u1' }, { 'Set-Cookie': 'tf_session=abc; Path=/; HttpOnly' }) };
const find = (report, name) => report.checks.find(item => item.name === name);

test('三個檢查都通過才算通過，並留下逐項證據', async t => {
  const url = await server(t, {
    ...healthy, ...loginOk,
    'GET /api/state': (req, res) => {
      assert.match(req.headers.cookie || '', /tf_session=abc/); // 必須帶著剛拿到的 cookie
      json(res, 200, { user: { id: 'u1' }, tasks: [] });
    },
  });

  const report = await validateDeployment({ url, credentials });
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks.map(c => c.name), ['health', 'login', 'state']);
  assert.ok(report.checks.every(c => c.passed));
  assert.equal(report.url, url);
});

test('核心 API 回 404 要判成架構缺陷，不可以說成「未登入的正常行為」', async t => {
  const url = await server(t, healthy); // 沒有 /api/login
  const report = await validateDeployment({ url, credentials });

  assert.equal(report.passed, false);
  assert.equal(find(report, 'health').passed, true);   // 頁面本身活著也不能救它
  const login = find(report, 'login');
  assert.equal(login.passed, false);
  assert.equal(login.actual, 'HTTP 404');
  assert.match(login.detail, /架構缺陷/);
  // 訊息必須主動否定那個常見的誤判，而不是只有不提到它
  assert.match(login.detail, /不是「未登入的正常行為」/);
});

test('401 與 403 的意義不同，且都不等於 404', async t => {
  const unauthorized = await server(t, { ...healthy, 'POST /api/login': (req, res) => json(res, 401, { error: 'bad credentials' }) });
  const report401 = await validateDeployment({ url: unauthorized, credentials });
  assert.match(find(report401, 'login').detail, /尚未認證/);

  const forbidden = await server(t, { ...healthy, 'POST /api/login': (req, res) => json(res, 403, { error: 'no' }) });
  const report403 = await validateDeployment({ url: forbidden, credentials });
  assert.match(find(report403, 'login').detail, /權限不足/);
});

test('登入沒成功就不用未認證的請求假裝驗過狀態查詢', async t => {
  const url = await server(t, { ...healthy, 'POST /api/login': (req, res) => json(res, 401, {}) });
  const report = await validateDeployment({ url, credentials });
  const state = find(report, 'state');
  assert.equal(state.passed, false);
  assert.equal(state.actual, '未執行');
  assert.match(state.detail, /登入沒有成功/);
});

test('健康檢查要的不只是 200，還要是 TaskFlow 自己的格式', async t => {
  const url = await server(t, { 'GET /api/health': (req, res) => json(res, 200, { ok: true }) });
  const report = await validateDeployment({ url, credentials });
  const health = find(report, 'health');
  assert.equal(health.passed, false);
  assert.match(health.detail, /不是 TaskFlow/);
});

test('狀態查詢回 200 但缺欄位也算未通過', async t => {
  const url = await server(t, { ...healthy, ...loginOk, 'GET /api/state': (req, res) => json(res, 200, { user: { id: 'u1' } }) });
  const report = await validateDeployment({ url, credentials });
  assert.equal(find(report, 'state').passed, false);
  assert.match(find(report, 'state').detail, /缺少 user 或 tasks/);
});

test('沒有帳密時，登入與狀態查詢標成未通過，不是略過', async t => {
  const url = await server(t, healthy);
  const report = await validateDeployment({ url, credentials: null });
  assert.equal(report.passed, false);
  assert.equal(find(report, 'health').passed, true);
  for (const name of ['login', 'state']) {
    assert.equal(find(report, name).passed, false);
    assert.match(find(report, name).detail, /未通過，不是略過/);
  }
});

test('連不上時每一項都是未通過，而且留下原因', async () => {
  const report = await validateDeployment({ url: 'http://127.0.0.1:1', credentials, timeoutMs: 300 });
  assert.equal(report.passed, false);
  assert.equal(find(report, 'health').actual, '沒有回應');
  assert.ok(find(report, 'health').detail.length > 0);
});

// --- 驗收狀態機與認證階段（計畫書第十一、十二、十三、十七、十八章） -------------

test('Test 1：專案宣告不需要登入時，health → state 就走完，不會卡在登入', async t => {
  const url = await server(t, {
    ...healthy,
    'GET /api/state': (req, res) => {
      assert.equal(req.headers.cookie, undefined); // 沒有身份就不該憑空生出一個
      json(res, 200, { user: { id: 'u1' }, tasks: [] });
    },
  });

  const report = await validateDeployment({ url, acceptance: acceptance({ mode: 'none' }) });
  assert.equal(report.passed, true);
  assert.equal(report.state, 'PASSED');
  assert.equal(report.authentication.required, false);
  assert.equal(report.authentication.attempted, false);
  assert.equal(find(report, 'login').passed, true);
});

test('Test 2：credentials 登入成功後，整條狀態機走到 PASSED', async t => {
  const context = acceptance();
  const url = await server(t, {
    ...healthy, ...loginOk,
    'GET /api/state': (req, res) => { assert.match(req.headers.cookie || '', /tf_session=abc/); json(res, 200, { user: { id: 'u1' }, tasks: [] }); },
  });

  const report = await validateDeployment({ url, acceptance: context });
  assert.equal(report.passed, true);
  assert.equal(report.authentication.passed, true);
  assert.equal(report.authentication.sessionType, 'cookie');
  assert.equal(report.apiState.passed, true);
  assert.deepEqual(report.states, ['PREVIEW_READY', 'HEALTH_VALIDATED', 'AUTHENTICATING', 'AUTHENTICATED', 'API_VALIDATED', 'PASSED']);
});

test('Test 4：bearer 模式用注入的 token 通過狀態查詢', async t => {
  const context = acceptance({ mode: 'bearer' });
  const url = await server(t, {
    ...healthy,
    'GET /api/state': (req, res) => {
      if (req.headers.authorization !== `Bearer ${context.token}`) return json(res, 401, { error: 'unauthorized' });
      json(res, 200, { user: { id: 'u1' }, tasks: [] });
    },
  });

  const report = await validateDeployment({ url, acceptance: context });
  assert.equal(report.passed, true);
  assert.equal(report.authentication.sessionType, 'bearer');
});

test('Test 5：401 停在 AUTH_FAILED，狀態查詢標成 skipped 並留下 failureCode', async t => {
  const url = await server(t, { ...healthy, 'POST /api/login': (req, res) => json(res, 401, { error: 'Invalid credentials' }) });
  const report = await validateDeployment({ url, acceptance: acceptance() });

  assert.equal(report.passed, false);
  assert.equal(report.state, 'AUTH_FAILED');
  assert.equal(report.authentication.failureCode, 'authentication_failed');
  assert.equal(report.authentication.failureCategory, 'project_defect');
  assert.equal(report.apiState.attempted, false);
  assert.equal(report.apiState.skippedReason, 'authentication_failed');
  // 不得只留下「需要登入（尚未認證）」這種對除錯沒有價值的結論
  assert.match(find(report, 'login').detail, /failureCode=authentication_failed/);
});

test('Test 6：帳密沒被注入時不送出空帳密登入，且標成 TaskFlow 基礎設施問題', async t => {
  const context = createAcceptanceContext({}); // 沒有任何注入
  let loginCalls = 0;
  const url = await server(t, { ...healthy, 'POST /api/login': (req, res) => { loginCalls += 1; json(res, 200, {}); } });

  const report = await validateDeployment({ url, acceptance: context });
  assert.equal(loginCalls, 0);
  assert.equal(report.authentication.failureCode, 'credentials_not_injected');
  assert.equal(report.authentication.failureCategory, 'taskflow_infrastructure');
  assert.equal(report.passed, false);
});

test('登入成功卻在 /api/state 被擋下，要算成工作階段沒有傳遞，不是專案拒絕帳密', async t => {
  const url = await server(t, { ...healthy, ...loginOk, 'GET /api/state': (req, res) => json(res, 401, { error: 'unauthorized' }) });
  const report = await validateDeployment({ url, acceptance: acceptance() });

  assert.equal(report.passed, false);
  assert.equal(report.state, 'API_FAILED');
  assert.equal(report.authentication.failureCode, 'session_not_propagated');
  assert.equal(report.authentication.failureCategory, 'taskflow_infrastructure');
  assert.match(find(report, 'state').detail, /工作階段沒有帶到後續請求/);
});

test('Test 8：報告裡不得出現 password、token 或 cookie 值', async t => {
  const context = acceptance();
  const url = await server(t, {
    ...healthy,
    'POST /api/login': (req, res) => json(res, 401, { error: 'Invalid credentials', echo: `password=${context.password}` }),
  });
  const report = await validateDeployment({ url, acceptance: context });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(context.password));
  assert.ok(!serialized.includes(context.token));
});

test('專案設定檔指定的登入端點與欄位會被照著用，不做 convention 猜測', async t => {
  const context = acceptance({ mode: 'credentials', login: { method: 'POST', path: '/session', body: { email: '$acceptance.email', password: '$acceptance.password' } }, state: { method: 'GET', path: '/me' } });
  let received = null;
  const url = await server(t, {
    ...healthy,
    'POST /session': (req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { received = JSON.parse(body); json(res, 200, { token: 'abc-token-123' }); }); },
    'GET /me': (req, res) => json(res, req.headers.authorization === 'Bearer abc-token-123' ? 200 : 401, { id: 'u1' }),
  });

  const report = await validateDeployment({ url, acceptance: context });
  assert.equal(received.email, context.email);
  assert.equal(find(report, 'login').path, '/session');
  assert.equal(find(report, 'state').path, '/me');
  assert.equal(report.passed, true);
});
