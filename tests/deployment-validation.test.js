import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {validateDeployment} from '../server/deployment-validation.js';

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
