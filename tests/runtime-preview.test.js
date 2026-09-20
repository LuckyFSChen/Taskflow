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

const rmDirSafe = path => rmSync(path, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
const fakeNpm = async (path, args) => { if (args[0] === 'install') mkdirSync(join(path, 'node_modules'), {recursive: true}); };

// 後端：只用 node 內建模組，不需要安裝任何東西。啟動時寫一個 marker，
// 用來證明「backend 先 ready，frontend 才起」這個順序真的成立。
const BACKEND = healthy => `
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const port = Number(process.env.PORT);
writeFileSync(process.env.TF_MARKER, JSON.stringify({
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

const SPA = '<!DOCTYPE html><html><head><title>fixture</title></head><body><div id="app">frontend</div></body></html>';

function writeFixture({healthy = true, proxyPaths = ['/api', '/uploads']} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tf-runtime-'));
  mkdirSync(join(root, 'backend'), {recursive: true});
  mkdirSync(join(root, 'frontend/dist'), {recursive: true});
  writeFileSync(join(root, 'backend/package.json'), JSON.stringify({type: 'module', dependencies: {express: '^4'}, scripts: {dev: 'node server.js'}}));
  writeFileSync(join(root, 'backend/server.js'), BACKEND(healthy));
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
        {id: 'frontend', type: 'frontend', cwd: 'frontend', dependsOn: ['backend'], browserEntry: true, proxyPaths},
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

test('Test 4 — backend 健康檢查失敗時，整組 runtime 不成立，Browser Validation 不會開始', async t => {
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
});

test('Test 5 — 轉發沒涵蓋 /api 時，SPA fallback 的 200 被判定為 proxy_routing_failure 而非通過', async t => {
  // 這正是整改前 idv-web 的形狀：frontend preview 開得起來、/api/* 回 200，
  // 但內容是 index.html。整改後必須辨識得出來，並說得出「expected json, received html」。
  const root = writeFixture({proxyPaths: ['/nothing']});
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
