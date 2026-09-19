import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCEPTANCE_CONFIG_FILE,
  acceptanceEnvironment,
  authenticatePreview,
  authenticatedHeaders,
  authenticationDiagnostic,
  cleanupAcceptanceContext,
  createAcceptanceContext,
  loadAcceptanceConfig,
  maskSecrets,
} from '../server/acceptance-auth.js';

// 真的起 HTTP 伺服器：假的 fetch 很容易寫出「只有自己看得懂」的回應，
// 而這裡要確認的正是 Set-Cookie、狀態碼與 JSON 解析在真實世界的行為。
async function server(t, routes) {
  const instance = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const handler = routes[`${req.method} ${req.url.split('?')[0]}`];
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
      if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
      handler(req, res, body);
    });
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

function injected(context) { context.injection = { environment: true, database: true, error: null }; return context; }

test('一次性驗收身份每次都是新的，而且不是任何寫死的測試帳密', () => {
  const first = createAcceptanceContext({}), second = createAcceptanceContext({});
  assert.notEqual(first.password, second.password);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.id, second.id);
  assert.ok(first.password.length > 10);
  for (const forbidden of ['admin123', 'admin@example.com', 'password']) {
    assert.notEqual(first.password, forbidden);
  }
});

test('環境變數注入帶著這一輪的身份，Preview 子程序才看得到', () => {
  const context = createAcceptanceContext({});
  const env = acceptanceEnvironment(context);
  assert.equal(env.TASKFLOW_ACCEPTANCE_MODE, '1');
  assert.equal(env.TASKFLOW_ACCEPTANCE_AUTH_MODE, 'credentials');
  assert.equal(env.TASKFLOW_ACCEPTANCE_USERNAME, 'taskflow-preview');
  assert.equal(env.TASKFLOW_ACCEPTANCE_PASSWORD, context.password);
  assert.equal(env.TASKFLOW_ACCEPTANCE_TOKEN, context.token);
});

test('專案設定檔決定登入方式，沒有設定檔才用有限的 convention', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-acceptance-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ACCEPTANCE_CONFIG_FILE), JSON.stringify({
    authentication: { mode: 'credentials', login: { method: 'POST', path: '/session', body: { email: '$acceptance.email', password: '$acceptance.password' } } },
  }));
  const config = loadAcceptanceConfig(dir);
  assert.equal(config.mode, 'credentials');
  assert.equal(config.login.path, '/session');
  const context = createAcceptanceContext({ projectPath: dir });
  assert.equal(context.source, 'config');
  assert.equal(createAcceptanceContext({ projectPath: join(dir, 'nowhere') }).source, 'default');
});

// --- 計畫書第二十章的測試需求 -------------------------------------------------

test('Test 2／3：credentials 登入成功並保存 cookie，後續請求帶得上去', async t => {
  const context = injected(createAcceptanceContext({}));
  let received = null;
  const url = await server(t, {
    'POST /api/login': (req, res, body) => { received = body; json(res, 200, { id: 'u1' }, { 'Set-Cookie': 'tf_session=abc; Path=/; HttpOnly' }); },
  });

  const result = await authenticatePreview({ context, url });
  assert.equal(result.passed, true);
  assert.equal(result.status, 200);
  assert.equal(result.sessionType, 'cookie');
  assert.equal(received.username, context.username);
  assert.equal(received.password, context.password); // validator 用的就是注入的那一組
  assert.equal(authenticatedHeaders(context).Cookie, 'tf_session=abc');
});

test('Test 4：登入回 token 時用 Authorization: Bearer 帶下去', async t => {
  const context = injected(createAcceptanceContext({}));
  const url = await server(t, { 'POST /api/login': (req, res) => json(res, 200, { token: 'jwt-value-xyz' }) });
  const result = await authenticatePreview({ context, url });
  assert.equal(result.passed, true);
  assert.equal(result.sessionType, 'bearer');
  assert.equal(authenticatedHeaders(context).Authorization, 'Bearer jwt-value-xyz');
});

test('bearer 模式不需要登入端點，直接用注入 Preview 的一次性 token', async () => {
  const context = injected(createAcceptanceContext({ config: { mode: 'bearer' } }));
  const result = await authenticatePreview({ context, url: 'http://127.0.0.1:1' });
  assert.equal(result.passed, true);
  assert.equal(result.sessionType, 'bearer');
  assert.equal(authenticatedHeaders(context).Authorization, `Bearer ${context.token}`);
});

test('none 模式直接視為通過，不打任何登入請求', async () => {
  const context = createAcceptanceContext({ config: { mode: 'none' } });
  const result = await authenticatePreview({ context, url: 'http://127.0.0.1:1' });
  assert.equal(result.passed, true);
  assert.equal(result.attempted, false);
});

test('Test 5：帳密錯誤是 authentication_failed，責任歸屬在專案', async t => {
  const context = injected(createAcceptanceContext({}));
  const url = await server(t, { 'POST /api/login': (req, res) => json(res, 401, { error: 'Invalid credentials' }) });
  const result = await authenticatePreview({ context, url });
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'authentication_failed');
  assert.equal(result.failureCategory, 'project_defect');
  assert.equal(result.status, 401);
});

test('Test 6：帳密沒有注入時不得真的送出登入請求，而且要標成 TaskFlow 基礎設施問題', async t => {
  const context = createAcceptanceContext({}); // injection 全部 false
  let called = 0;
  const url = await server(t, { 'POST /api/login': (req, res) => { called += 1; json(res, 200, {}); } });
  const result = await authenticatePreview({ context, url });
  assert.equal(called, 0);
  assert.equal(result.attempted, false);
  assert.equal(result.failureCode, 'credentials_not_injected');
  assert.equal(result.failureCategory, 'taskflow_infrastructure');
});

test('沒有帳密就是 credentials_missing，一樣算 TaskFlow 基礎設施問題', async () => {
  const context = injected(createAcceptanceContext({}));
  context.password = null;
  const result = await authenticatePreview({ context, url: 'http://127.0.0.1:1' });
  assert.equal(result.failureCode, 'credentials_missing');
  assert.equal(result.failureCategory, 'taskflow_infrastructure');
});

test('登入端點不存在是架構缺陷，不是「未登入的正常行為」', async t => {
  const context = injected(createAcceptanceContext({}));
  const url = await server(t, {}); // 每個路徑都 404
  const result = await authenticatePreview({ context, url });
  assert.equal(result.failureCode, 'login_endpoint_not_found');
  assert.equal(result.endpoint, 'POST /api/login'); // 回報預設端點，不是 discovery 的最後一個候選
  assert.ok(result.triedEndpoints.length > 1);
});

test('欄位不對才換一組欄位；401 不會把同一個錯誤再問一次', async t => {
  const context = injected(createAcceptanceContext({}));
  const seen = [];
  const url = await server(t, {
    'POST /api/login': (req, res, body) => {
      seen.push(Object.keys(body).join(','));
      if ('username' in body) return json(res, 422, { error: 'email is required' });
      json(res, 200, { token: 'ok-token-value' });
    },
  });
  const result = await authenticatePreview({ context, url });
  assert.deepEqual(seen, ['username,password', 'email,password']);
  assert.equal(result.passed, true);
});

test('登入 200 但沒有 cookie 也沒有 token，算 session_not_propagated', async t => {
  const context = injected(createAcceptanceContext({}));
  const url = await server(t, { 'POST /api/login': (req, res) => json(res, 200, { ok: true }) });
  const result = await authenticatePreview({ context, url });
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'session_not_propagated');
  assert.equal(result.failureCategory, 'taskflow_infrastructure');
});

test('Test 8：診斷訊息說得出該說的，但不得洩漏 password／token／cookie', async t => {
  const context = injected(createAcceptanceContext({}));
  const url = await server(t, {
    'POST /api/login': (req, res, body) => json(res, 401, { error: 'Invalid credentials', attempted: body.password }),
  });
  const result = await authenticatePreview({ context, url });
  const diagnostic = authenticationDiagnostic(context, result);
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.credentialsInjected, true);
  assert.equal(diagnostic.endpoint, 'POST /api/login');
  assert.equal(diagnostic.requestFields, 'username,password');
  assert.equal(diagnostic.failureCode, 'authentication_failed');
  assert.ok(!serialized.includes(context.password));
  assert.ok(!serialized.includes(context.token));
  assert.match(serialized, /redacted/);
});

test('遮蔽函式擋得住 password、token、cookie 與 Authorization', () => {
  const context = injected(createAcceptanceContext({}));
  context.session = { cookie: 'tf_session=abcdef123456', authorization: 'Bearer zzz-token-value', type: 'cookie' };
  const text = `password=${context.password} token=${context.token} Cookie: tf_session=abcdef123456 Authorization: Bearer zzz-token-value`;
  const masked = maskSecrets(text, context);
  for (const secret of [context.password, context.token, 'abcdef123456', 'zzz-token-value']) {
    assert.ok(!masked.includes(secret), `still leaks: ${secret}`);
  }
});

test('驗收結束後祕密從記憶體消失', () => {
  const context = injected(createAcceptanceContext({}));
  context.session = { cookie: 'tf_session=abc', authorization: 'Bearer x', type: 'cookie' };
  cleanupAcceptanceContext(context);
  assert.equal(context.password, null);
  assert.equal(context.token, null);
  assert.equal(context.session.cookie, null);
  assert.deepEqual(authenticatedHeaders(context), {});
});
