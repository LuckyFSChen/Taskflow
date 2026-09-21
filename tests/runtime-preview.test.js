// Multi-Service Preview 的端到端驗證：真的起兩個服務、真的經由前端打後端、真的停乾淨。
//
// 單元測試證明得了每一段判斷，證明不了這條資料流沒有斷。這個檔案要證明的是：
//   backend 先 ready → frontend 才起 → /api/* 經由 frontend 真的到得了 backend →
//   停止後 PID 消失且連接埠釋放。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectPreview} from '../server/project-preview.js';
import {isAlive} from '../server/process-lifecycle.js';
import {portInUse, waitForPortRelease} from '../server/runtime-manager.js';
import {runtimePreflight} from '../server/runtime-recovery.js';
import {RESERVED_PORTS, createRuntimePortManager, isReservedPort} from '../server/runtime-port-manager.js';

const rmDirSafe = path => rmSync(path, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
const fakeNpm = async (path, args) => { if (args[0] === 'install') mkdirSync(join(path, 'node_modules'), {recursive: true}); };

// 後端：只用 node 內建模組，不需要安裝任何東西。啟動時寫一個 marker，
// 用來證明「backend 先 ready，frontend 才起」這個順序真的成立。
const BACKEND = healthy => `
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const port = Number(process.env.PORT);
writeFileSync(process.env.TF_MARKER, JSON.stringify({
  pid: process.pid,
  port,
  backendPort: process.env.BACKEND_PORT || null,
  frontendPort: process.env.FRONTEND_PORT || null,
  startedAt: Date.now(),
}));
createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
  if (req.url === '/api/health') return ${healthy ? `json(200, {ok: true})` : `(res.writeHead(500, {'Content-Type': 'text/plain'}), res.end('not ready'))`};
  if (req.url === '/api/profile') return json(200, {id: 'u1', name: 'preview user'});
  if (req.url.startsWith('/uploads/')) return json(200, {upload: true});
  json(404, {error: 'not found'});
}).listen(port, '127.0.0.1');
`;

// Test 8 用：backend 真的 listen，但故意永遠不回應健康檢查請求，逼 waitForServiceHealth()
// 真的因為 fetch abort 逾時，走到 'runtime_timeout' 這條路徑，而不是 ECONNREFUSED 的
// 'service_unhealthy'。process 本身不能自己結束，否則驗不到「還活著但清不掉」這個情境。
const HANGING_BACKEND = `
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const port = Number(process.env.PORT);
writeFileSync(process.env.TF_MARKER, JSON.stringify({pid: process.pid, port}));
createServer((req, res) => { /* 故意不回應，逼健康檢查逾時 */ }).listen(port, '127.0.0.1');
`;

// Test 10 用：backend 自己再開一個孫行程，真正 listen 的是孫行程，TaskFlow 追蹤的 PID
// （runtime-manager 直接 spawn 出來的那一個）只是 parent。用來證明 killTree() 的
// Windows `/T`（整棵 process tree）真的連孫行程一起清掉，不是只清掉 TaskFlow 認得的那個 PID。
const BACKEND_WITH_GRANDCHILD = `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const port = Number(process.env.PORT);
const grandchild = spawn(process.execPath, ['-e', \`
const {createServer} = require('node:http');
const port = Number(process.env.PORT);
createServer((req, res) => {
  if (req.url === '/api/health') { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ok: true})); return; }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
\`], {env: process.env, stdio: 'ignore', windowsHide: true});
writeFileSync(process.env.TF_MARKER, JSON.stringify({pid: process.pid, childPid: grandchild.pid, port}));
setInterval(() => {}, 60000);
`;

const SPA = '<!DOCTYPE html><html><head><title>fixture</title></head><body><div id="app">frontend</div></body></html>';

function writeFixture({healthy = true, proxyPaths = ['/api', '/uploads'], validationProbes = null, backendSource = null} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tf-runtime-'));
  mkdirSync(join(root, 'backend'), {recursive: true});
  mkdirSync(join(root, 'frontend/dist'), {recursive: true});
  writeFileSync(join(root, 'backend/package.json'), JSON.stringify({type: 'module', dependencies: {express: '^4'}, scripts: {dev: 'node server.js'}}));
  writeFileSync(join(root, 'backend/server.js'), backendSource || BACKEND(healthy));
  writeFileSync(join(root, 'frontend/package.json'), JSON.stringify({type: 'module', devDependencies: {vite: '^5'}, scripts: {build: 'vite build'}}));
  writeFileSync(join(root, 'frontend/dist/index.html'), SPA);
  writeFileSync(join(root, 'taskflow.runtime.json'), JSON.stringify({
    runtime: {
      services: [
        {
          id: 'backend', type: 'backend', cwd: 'backend', startCommand: 'node server.js',
          healthCheck: {path: '/api/health', expectedStatus: 200, expectedContentType: 'application/json', expectedJsonShape: {ok: true}},
          environment: {TF_MARKER: join(root, 'backend-started.json').split('\\').join('/')},
        },
        {id: 'frontend', type: 'frontend', cwd: 'frontend', dependsOn: ['backend'], browserEntry: true, proxyPaths, ...(validationProbes ? {validationProbes} : {})},
      ],
    },
  }));
  return root;
}

const markerPath = root => join(root, 'backend-started.json');

test('Test 3／6／11 — backend 先就緒、frontend 經由轉發真的到得了 backend、停止後連接埠釋放', async t => {
  const root = writeFixture();
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const info = await previews.start('multi-a', root);

  // Test 3：backend 必須在 frontend 之前就緒。marker 只在 backend 程序啟動時才寫得出來，
  // 而 frontend 的 URL 只在整組 start 回來之後才存在。
  assert.ok(existsSync(markerPath(root)), 'backend 程序必須已經啟動過');
  const marker = JSON.parse(readFileSync(markerPath(root), 'utf8'));

  assert.equal(info.kind, 'multi-service');
  assert.equal(info.runtime.services.length, 2);
  const [backend, frontend] = ['backend', 'frontend'].map(id => info.runtime.services.find(service => service.id === id));
  assert.equal(backend.status, 'READY');
  assert.equal(frontend.status, 'READY');
  assert.equal(frontend.browserEntry, true);
  assert.equal(info.url, frontend.url, 'Preview URL 必須是 browserEntry 那個服務的網址');

  // 每個服務各自的 port，不共用（計畫書第八／九章）。
  assert.notEqual(backend.port, frontend.port);
  assert.equal(marker.port, backend.port, 'backend 的 PORT 是它自己的 port');
  assert.equal(marker.frontendPort, null, 'backend 啟動時 frontend 還不存在，不該看得到 FRONTEND_PORT');
  assert.ok(Number.isInteger(backend.pid) && isAlive(backend.pid));
  assert.equal(frontend.pid, null, 'frontend 由 TaskFlow 自管，沒有子程序');

  // Test 6：**經由 frontend preview 的網址**打後端 API，必須真的拿到 JSON。
  const health = await fetch(`${info.url}/api/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /application\/json/, '/api/health 經由轉發必須是 JSON，不是 SPA fallback');
  assert.deepEqual(await health.json(), {ok: true});

  const profile = await fetch(`${info.url}/api/profile`);
  assert.match(profile.headers.get('content-type'), /application\/json/);
  assert.equal((await profile.json()).id, 'u1');

  const upload = await fetch(`${info.url}/uploads/x.png`);
  assert.match(upload.headers.get('content-type'), /application\/json/, 'vite 設定裡宣告的其他轉發路徑也要生效');

  // 前端本身仍然是 SPA：非轉發路徑照舊回 index.html。
  const page = await fetch(`${info.url}/some/client/route`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="app">/);

  // Test 11：停止後每個子程序都真的消失，連接埠也真的釋放。
  const stopped = await previews.stop('multi-a');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.verified, true);
  assert.equal(stopped.services.length, 2);
  for (const service of stopped.services) assert.equal(service.verified, true, `${service.id} 必須確認已結束`);
  assert.equal(isAlive(backend.pid), false, 'backend PID 必須真的不見了');
  assert.equal(await waitForPortRelease(backend.port), true);
  assert.equal(await portInUse(frontend.port), false, 'frontend 的連接埠必須釋放');
});

// Test 7 — validation failure cleanup：即使健康檢查未通過（相當於驗證流程內部 throw），
// backend 的 PID 與 port 也必須清乾淨，不能留下孤兒。
test('Test 4／7 — backend 健康檢查失敗時，整組 runtime 不成立，且 process／port 都清乾淨', async t => {
  const root = writeFixture({healthy: false});
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const events = [];
  const outcome = await runtimePreflight('multi-unhealthy', root, {
    previews, onEvent: (kind, payload) => events.push({kind, payload}),
    // 健康檢查逾時本身就要等；測試裡把回復次數降到 0，避免重跑好幾輪
    maxAttempts: 0,
  });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.failureKind, 'service_unhealthy', '要說得出是「健康檢查未通過」，不是籠統的 browser validation failed');
  assert.equal(outcome.owner, 'project', '專案自己的服務健康檢查不過，是專案的問題');
  assert.equal(outcome.needsUserInput, false, '後端沒起來不是需要使用者回答的問題');
  assert.equal(outcome.previewUrl, null, 'runtime 不成立就沒有可供 Browser Validation 使用的 URL');
  assert.ok(events.some(event => event.kind === 'runtime_service_failed'), '必須留下結構化的失敗事件');

  // 半開的 runtime 不可以留下來：前端不該還開著。
  assert.equal(previews.status('multi-unhealthy'), null);

  // Test 7：驗證失敗（這裡等同於健康檢查一路未通過而丟出 RuntimeFailure）也要清乾淨，
  // 不是只有成功路徑才清。backend 程序即使從未 ready，也必須真的被停掉、port 也要釋放。
  assert.ok(existsSync(markerPath(root)), 'backend 程序必須已經啟動過，才談得上要不要清乾淨');
  const marker = JSON.parse(readFileSync(markerPath(root), 'utf8'));
  assert.equal(isAlive(marker.pid), false, '健康檢查失敗後，backend PID 必須真的消失，不留孤兒');
  assert.equal(await portInUse(marker.port), false, '健康檢查失敗後，backend 的 port 必須釋放');
});

test('Test 5 — 宣告的驗證端點實際上沒有被轉發時，SPA fallback 的 200 判定為 proxy_routing_failure', async t => {
  // 這正是整改前 idv-web 的形狀：frontend preview 開得起來、被驗的那條路徑回 200，
  // 但內容是 index.html。這裡用「宣告了 /api/health 這個驗證端點，但轉發範圍其實沒有涵蓋它」
  // 來忠實重現——注意 namespace 本身（/api、/uploads）永遠不會被拿去打，那是另一回事。
  const root = writeFixture({proxyPaths: ['/nothing'], validationProbes: [{path: '/api/health'}]});
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  // 先確認這個 fixture 真的重現了那個假陽性：狀態碼確實是 200。
  const info = await previews.start('multi-spa', root);
  const raw = await fetch(`${info.url}/api/health`);
  assert.equal(raw.status, 200, 'fixture 必須真的重現「HTTP 200」這個假陽性');
  assert.match(raw.headers.get('content-type'), /text\/html/);
  await previews.stop('multi-spa');

  const outcome = await runtimePreflight('multi-spa', root, {previews, maxAttempts: 1});
  assert.equal(outcome.passed, false, 'HTTP 200 不得被當成 API 成功');
  assert.equal(outcome.failureKind, 'proxy_routing_failure');
  assert.equal(outcome.owner, 'taskflow');
  assert.equal(outcome.needsUserInput, false);
  const failed = outcome.checks.find(check => !check.passed);
  assert.match(failed.detail, /expected application\/json/);
  assert.match(failed.detail, /received text\/html/);
  // 自動回復用盡才 block，而且次數有上限。
  assert.ok(outcome.attempts.length >= 1 && outcome.attempts.length <= 2);
});

// --- 案例 4／5：recovery 之後的 authoritative runtime state ----------------------
// Windows 實測暴露的矛盾：事件裡明明有 runtime_service_ready backend／frontend，
// 步驟卻說「沒有後端服務」，shutdown 還回 []。原因是回復建立的新 runtime 沒有成為
// 呼叫端持有的那一份。這兩個測試把「誰是 authoritative runtime state」釘死。
test('案例 4 — 第一次失敗、第二次成功時，呼叫端拿到的是第二次那一組 runtime', async t => {
  const root = writeFixture();
  const real = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await real.close().catch(() => {}); rmDirSafe(root); });

  let starts = 0;
  const previews = {
    start: async (key, path) => {
      starts++;
      // 第一次以一個可回復的 runtime 失敗收場（例如連接埠被別人占走）。
      if (starts === 1) { const error = new Error('連接埠已被占用'); error.kind = 'port_conflict'; throw error; }
      return real.start(key, path);
    },
    stop: key => real.stop(key),
    status: key => real.status(key),
  };

  const outcome = await runtimePreflight('multi-recover', root, {previews});
  assert.equal(starts, 2, '第一次失敗之後必須真的重試一次');
  assert.equal(outcome.passed, true);
  assert.ok(outcome.runtime, '通過時也要帶著 authoritative runtime 狀態');
  assert.equal(outcome.runtime.services.length, 2);
  const backend = outcome.runtime.services.find(service => service.id === 'backend');
  assert.equal(backend.status, 'READY');
  // 這個 PID 必須是**現在真的活著**的那一個，不是第一輪留下的舊值。
  assert.equal(isAlive(backend.pid), true);
  assert.equal(outcome.previewUrl, real.status('multi-recover').url);
  // 經由這一組（而不是舊的）確認轉發真的通。
  const health = await fetch(`${outcome.previewUrl}/api/health`);
  assert.match(health.headers.get('content-type'), /application\/json/);

  const stopped = await previews.stop('multi-recover');
  assert.equal(stopped.services.length, 2);
  assert.equal(isAlive(backend.pid), false);
});

test('案例 5 — 回復用盡而 block 時，runtime 狀態與 shutdown 結果都要帶回來，不得是空的', async t => {
  const root = writeFixture({proxyPaths: ['/nothing'], validationProbes: [{path: '/api/health'}]});
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const outcome = await runtimePreflight('multi-blocked', root, {previews, maxAttempts: 1});
  assert.equal(outcome.passed, false);
  assert.equal(outcome.previewUrl, null, 'runtime 已經收掉了，不該再給一個指向死掉服務的網址');

  // 服務**確實**曾經 READY——這是「卡在轉發那一層」的唯一證據，不能被丟掉。
  assert.ok(outcome.runtime, 'block 的結論必須帶著最後一次實際建立的 runtime 狀態');
  const backend = outcome.runtime.services.find(service => service.id === 'backend');
  const frontend = outcome.runtime.services.find(service => service.id === 'frontend');
  assert.equal(backend.status, 'READY');
  assert.equal(frontend.status, 'READY');
  assert.ok(Number.isInteger(backend.pid));

  // shutdown 是 preflight 在回復流程裡做的，但結果必須交回呼叫端：不能是 []。
  assert.ok(outcome.shutdown, 'block 時也要回報關閉結果');
  assert.equal(outcome.shutdown.services.length, 2);
  for (const service of outcome.shutdown.services) assert.equal(service.verified, true);
  assert.equal(isAlive(backend.pid), false, '最後一組 runtime 的子程序必須真的被停掉');
  assert.equal(await portInUse(frontend.port), false);
  assert.equal(previews.status('multi-blocked'), null);
});

test('Test 7／8 — runtime 指紋改變時只重啟受影響的服務，沒變的沿用同一個程序', async t => {
  const root = writeFixture();
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const first = await previews.start('multi-stale', root);
  const backendPid = first.runtime.services.find(service => service.id === 'backend').pid;
  const frontendPort = first.runtime.services.find(service => service.id === 'frontend').port;

  // 沒有任何改動：不該重啟。
  const again = await previews.start('multi-stale', root);
  assert.equal(again.runtime.services.find(service => service.id === 'backend').pid, backendPid, '沒有改動就不該重啟');
  assert.equal(again.runtime.services.find(service => service.id === 'frontend').port, frontendPort);

  // 改動後端的 runtime 設定：後端 stale，必須換一個新的程序。
  writeFileSync(join(root, 'backend/package.json'), JSON.stringify({type: 'module', dependencies: {express: '^5'}, scripts: {dev: 'node server.js'}}));
  const restarted = await previews.start('multi-stale', root);
  const newBackend = restarted.runtime.services.find(service => service.id === 'backend');
  assert.notEqual(newBackend.pid, backendPid, '後端 runtime 設定改了就必須重啟');
  assert.equal(newBackend.status, 'READY');
  assert.equal(isAlive(backendPid), false, '舊的後端程序必須真的收掉，不能留下孤兒');
  // 前端依賴後端，後端換了 port，前端也必須重新接上（否則轉發指向一個已經死掉的 port）。
  const health = await fetch(`${restarted.url}/api/health`);
  assert.match(health.headers.get('content-type'), /application\/json/, '重啟之後轉發必須指向新的後端');

  await previews.stop('multi-stale');
});

test('單一服務專案完全不經過 multi-service 路徑（既有行為不被破壞）', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tf-single-'));
  mkdirSync(join(root, 'dist'), {recursive: true});
  writeFileSync(join(root, 'package.json'), JSON.stringify({devDependencies: {vite: '^5'}, scripts: {build: 'vite build'}}));
  writeFileSync(join(root, 'dist/index.html'), SPA);
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const info = await previews.start('single', root);
  assert.equal(info.kind, 'vite');
  assert.equal(info.runtime, undefined, '單一服務不該長出 runtime 服務清單');
  const page = await fetch(info.url);
  assert.equal(page.status, 200);
  const stopped = await previews.stop('single');
  assert.equal(stopped.verified, true);
});

// --- Runtime Port Pool / Lease 改造：需求書第二十二章 Test 5／8／9／10／14 ------------

// 需求書 Test 5 — parent PORT leakage：即使父行程（這個測試檔自己）的 process.env.PORT
// 是保留 port 4310，子行程實際收到的 PORT 也必須是這一輪 lease 配發的 450xx，不是繼承來的。
test('需求書 Test 5 — 子行程不受父行程 process.env.PORT=4310 污染，一律使用 lease 配發的 port', async t => {
  const root = writeFixture();
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const originalPort = process.env.PORT;
  process.env.PORT = '4310';
  t.after(() => { if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort; });

  const info = await previews.start('multi-portenv', root);
  const backend = info.runtime.services.find(service => service.id === 'backend');
  const marker = JSON.parse(readFileSync(markerPath(root), 'utf8'));
  assert.notEqual(marker.port, 4310, '子行程不得直接繼承父行程的 process.env.PORT=4310');
  assert.equal(marker.port, backend.port, '子行程實際收到的 PORT 必須是這次 lease 配發的 port');
  assert.ok(backend.port >= 45000 && backend.port <= 45099, 'lease 配發的 port 必須落在 Runtime Port Pool 範圍內');

  await previews.stop('multi-portenv');
});

// 需求書 Test 8 — timeout cleanup：backend 真的 listen 但永遠不回應，健康檢查逾時後，
// runtime 不成立，backend 的 PID 與 port 依然要清乾淨。
test('需求書 Test 8 — 健康檢查逾時（timeout）後，backend 的 process／port 一樣要清乾淨', async t => {
  const root = writeFixture({backendSource: HANGING_BACKEND});
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json'), healthTimeoutMs: 900});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  await assert.rejects(previews.start('multi-timeout', root), error => {
    assert.ok(['runtime_timeout', 'service_unhealthy'].includes(error.kind), `逾時應歸類為 runtime_timeout 或 service_unhealthy，實際是 ${error.kind}`);
    return true;
  });

  assert.ok(existsSync(markerPath(root)), 'backend 程序必須已經啟動過');
  const marker = JSON.parse(readFileSync(markerPath(root), 'utf8'));
  assert.equal(isAlive(marker.pid), false, '逾時後 backend PID 必須真的消失');
  assert.equal(await portInUse(marker.port), false, '逾時後 backend 的 port 必須釋放');
  assert.equal(previews.status('multi-timeout'), null);
});

// 需求書 Test 9 — cancellation cleanup：runtime 已經 READY，但使用者在做任何驗證之前
// 就直接取消（對應 previews.stop() 由任務取消／視窗關閉路徑呼叫），一樣要確認清乾淨。
test('需求書 Test 9 — 使用者取消（尚未開始驗證就呼叫 previews.stop）：process／port 全部釋放', async t => {
  const root = writeFixture();
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const info = await previews.start('multi-cancel', root);
  const [backend, frontend] = ['backend', 'frontend'].map(id => info.runtime.services.find(service => service.id === id));
  assert.equal(backend.status, 'READY');
  assert.equal(frontend.status, 'READY');

  // 模擬使用者立刻取消：完全不做任何 fetch／驗證，直接停止。
  const stopped = await previews.stop('multi-cancel');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.verified, true);
  for (const service of stopped.services) assert.equal(service.verified, true, `${service.id} 必須確認已結束`);
  assert.equal(isAlive(backend.pid), false);
  assert.equal(await waitForPortRelease(backend.port), true);
  assert.equal(await portInUse(frontend.port), false);
  assert.equal(previews.status('multi-cancel'), null);
});

// 需求書 Test 10 — process tree cleanup：backend 自己再開一個孫行程（真正 listen 的是它），
// TaskFlow 只直接認得 parent 的 PID。停止後 parent／孫行程都必須消失，不能只清掉認得的那一個。
test('需求書 Test 10 — process tree cleanup：backend 自己開的孫行程也要一起清乾淨', async t => {
  const root = writeFixture({backendSource: BACKEND_WITH_GRANDCHILD});
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });

  const info = await previews.start('multi-tree', root);
  const backend = info.runtime.services.find(service => service.id === 'backend');
  assert.equal(backend.status, 'READY');
  const marker = JSON.parse(readFileSync(markerPath(root), 'utf8'));
  assert.equal(marker.pid, backend.pid, 'TaskFlow 追蹤的 PID 是它直接 spawn 出來的 parent');
  assert.notEqual(marker.childPid, backend.pid, '真正在監聽的是 backend 自己開的孫行程，不是同一個 PID');
  assert.ok(isAlive(marker.pid) && isAlive(marker.childPid), '停止前 parent／孫行程都應該活著');

  await previews.stop('multi-tree');

  assert.equal(isAlive(marker.pid), false, 'parent 必須真的消失');
  assert.equal(isAlive(marker.childPid), false, '孫行程不能是清不掉的孤兒，killTree 必須連整棵樹一起處理');
  assert.equal(await portInUse(backend.port), false, '孫行程真正監聽的 port 也必須釋放');
});

// 需求書 Test 14 — Core / Guardian regression：4310 永遠只屬於 TaskFlow Core，
// 4311 永遠只屬於 Service Guardian，Runtime Port Pool 的改造不得動到這兩個 port。
test('需求書 Test 14 — 4310 仍然只屬於 TaskFlow Core、4311 仍然只屬於 Service Guardian', async t => {
  const indexSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const guardianSource = readFileSync(new URL('../server/service-guardian.js', import.meta.url), 'utf8');
  assert.match(indexSource, /process\.env\.PORT\s*\|\|\s*4310/, 'TaskFlow Core 的預設 listen port 必須仍然是 4310');
  assert.match(guardianSource, /lock\.listen\(4311/, 'Service Guardian 必須仍然佔住 4311 作為單例鎖');
  assert.deepEqual([...RESERVED_PORTS], [4310, 4311]);

  // 即使故意把範圍硬塞成只剩 4310~4311，這兩個 port 依然永遠配不出去。
  const reservedOnly = createRuntimePortManager({range: {start: 4310, end: 4311}, checkPortInUse: async () => false, log: () => {}});
  assert.equal(await reservedOnly.isAvailable(4310), false);
  assert.equal(await reservedOnly.isAvailable(4311), false);

  // 實機多服務場景：backend／frontend 也絕不會拿到這兩個保留 port。
  const root = writeFixture();
  const previews = createProjectPreview({npm: fakeNpm, registryPath: join(root, 'registry.json')});
  t.after(async () => { await previews.close().catch(() => {}); rmDirSafe(root); });
  const info = await previews.start('multi-regress-4310', root);
  for (const service of info.runtime.services) assert.ok(!isReservedPort(service.port), `${service.id} 不得拿到保留 port ${service.port}`);
  await previews.stop('multi-regress-4310');
});
