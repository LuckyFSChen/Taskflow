// Runtime Topology / Validation / Recovery 的純函式驗證。
//
// 這些測試守住整改的語意核心：
//   * 單一服務專案的行為完全不變（Test 1）
//   * frontend/backend 分離的專案會被辨識成兩個服務（Test 2）
//   * 相依順序、環狀相依、缺少相依都有明確結論（Test 3）
//   * HTTP 200 + text/html 在期待 JSON 時一律判定為轉發失敗（Test 5／6 的核心判準）
//   * runtime 失敗不會變成 waiting_input，也不會直接叫 Repair Agent（Test 9／10）
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  detectTopology, resolveRuntimeTopology, normalizeTopology, orderRuntimeServices,
  dependentsOf, runtimeServiceFingerprint, detectProxyPaths, detectPackageManager, detectHealthPath,
} from '../server/runtime-topology.js';
import {validateApiResponse, validateConnectivity, RUNTIME_FAILURE_KINDS} from '../server/runtime-validation.js';
import {
  isRecoverableRuntimeFailure, requiresUserInput, shouldTriggerRepair, failureOwner,
  recoveryPlan, MAX_RUNTIME_RECOVERY_ATTEMPTS,
} from '../server/runtime-recovery.js';
import {detectWebProject} from '../server/project-preview.js';

const rmDirSafe = path => rmSync(path, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
const fixture = () => mkdtempSync(join(tmpdir(), 'tf-topology-'));

function writeFrontend(root, {proxy = true, name = 'frontend'} = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), {recursive: true});
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name, devDependencies: {vite: '^5'}, dependencies: {vue: '^3'}, scripts: {build: 'vite build', preview: 'vite preview'}}));
  writeFileSync(join(dir, 'vite.config.ts'), `import {defineConfig} from 'vite';
export default defineConfig({
  resolve: {alias: {'@': './src'}},
  server: {port: 5173, proxy: ${proxy ? `{'/api': {target: 'http://localhost:3001'}, '/uploads': {target: 'http://localhost:3001'}}` : '{}'}},
});`);
  return dir;
}

function writeBackend(root, {name = 'backend', health = true} = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), {recursive: true});
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name, dependencies: {express: '^4', '@prisma/client': '^5'}, scripts: {dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js'}}));
  writeFileSync(join(dir, 'src/app.ts'), health ? `app.get('/api/health', (_req, res) => res.json({ok: true}));` : `app.get('/api/things', (_req, res) => res.json([]));`);
  return dir;
}

// --- Test 1：單一服務專案的行為不可改變 ---------------------------------------
test('Test 1 — 單一服務專案不會被當成 multi-service，既有 Preview 流程照舊', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFileSync(join(root, 'package.json'), JSON.stringify({devDependencies: {vite: '^6'}, scripts: {build: 'vite build'}}));
  writeFileSync(join(root, 'index.html'), '<div id="app"></div>');

  assert.equal(resolveRuntimeTopology(root), null, '根目錄就是網頁專案時不該產生 topology');
  assert.equal(detectWebProject(root), 'vite', '單一服務專案仍然要被認出是網頁專案');
});

test('Test 1b — 只有前端、沒有後端的 monorepo 仍然走單一服務路徑', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFrontend(root);
  assert.equal(detectTopology(root), null, '沒有後端就沒有多服務可言');
});

// --- Test 2：frontend/backend 必須被偵測成兩個服務 -----------------------------
test('Test 2 — frontend/backend 同時存在時偵測出兩個 service，且不再只挑一個目錄', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFrontend(root);
  writeBackend(root);

  const topology = resolveRuntimeTopology(root);
  assert.ok(topology, '前後端分離的專案必須產生 topology');
  assert.equal(topology.source, 'auto_detection');
  assert.equal(topology.services.length, 2);

  const backend = topology.services.find(service => service.id === 'backend');
  const frontend = topology.services.find(service => service.id === 'frontend');
  assert.equal(backend.type, 'backend');
  assert.equal(backend.cwd, 'backend');
  assert.equal(backend.startCommand, 'npm run dev');
  assert.equal(backend.healthCheck.path, '/api/health', 'health 路徑要從專案原始碼掃出來，不是寫死的');
  assert.equal(backend.browserEntry, false);

  assert.equal(frontend.type, 'frontend');
  assert.equal(frontend.cwd, 'frontend');
  assert.equal(frontend.browserEntry, true);
  assert.deepEqual(frontend.dependsOn, ['backend']);
  assert.deepEqual(frontend.proxyPaths, ['/api', '/uploads'], 'proxy 路徑取自專案自己的 vite 設定');

  // detectWebProject 必須仍然回報「這是網頁專案」，否則 Browser Validation 根本不會被要求。
  assert.equal(detectWebProject(root), 'vite');
});

test('Test 2b — client/server、apps/web + apps/api 也算 multi-service；health 掃不到時標成 inferred', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFrontend(root, {name: 'client'});
  writeBackend(root, {name: 'server', health: false});
  const topology = resolveRuntimeTopology(root);
  assert.deepEqual(topology.services.map(service => service.id).sort(), ['client', 'server']);
  const server = topology.services.find(service => service.id === 'server');
  assert.equal(server.healthCheck.inferred, true);
  assert.equal(server.healthCheck.anyHttpResponse, true, '掃不到 health route 時不假裝有一個，改用較弱但誠實的判準');

  const mono = fixture();
  t.after(() => rmDirSafe(mono));
  mkdirSync(join(mono, 'apps'), {recursive: true});
  writeFrontend(join(mono, 'apps'), {name: 'web'});
  writeBackend(join(mono, 'apps'), {name: 'api'});
  const monoTopology = resolveRuntimeTopology(mono);
  assert.deepEqual(monoTopology.services.map(service => service.cwd).sort(), ['apps/api', 'apps/web']);
});

test('Test 2c — 兩個前端候選且沒有一個命中慣用名稱時，寧可不判定也不挑錯', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFrontend(root, {name: 'alpha'});
  writeFrontend(root, {name: 'beta'});
  writeBackend(root);
  assert.equal(detectTopology(root), null);
});

// --- Test 3：相依順序 ---------------------------------------------------------
test('Test 3 — dependsOn 決定啟動順序，環狀與缺漏都有明確錯誤', () => {
  const services = normalizeTopology({
    services: [
      {id: 'frontend', type: 'frontend', cwd: '', dependsOn: ['backend'], browserEntry: true, startCommand: 'npm run preview'},
      {id: 'backend', type: 'backend', cwd: '', dependsOn: ['database'], startCommand: 'npm run dev'},
      {id: 'database', type: 'database', cwd: '', startCommand: 'node db.js'},
    ],
  }, '/tmp').services;
  assert.deepEqual(orderRuntimeServices(services).map(service => service.id), ['database', 'backend', 'frontend']);
  assert.deepEqual(dependentsOf(services, 'database').sort(), ['backend', 'frontend']);

  assert.throws(() => normalizeTopology({services: [
    {id: 'a', cwd: '', dependsOn: ['b'], startCommand: 'node a.js'},
    {id: 'b', cwd: '', dependsOn: ['a'], startCommand: 'node b.js'},
  ]}, '/tmp'), /成環/);

  assert.throws(() => normalizeTopology({services: [
    {id: 'a', cwd: '', dependsOn: ['missing'], startCommand: 'node a.js'},
  ]}, '/tmp'), /依賴不存在/);
});

// --- Explicit runtime config 優先於自動偵測 ------------------------------------
test('明確 runtime 設定優先於自動偵測，且 cwd 不得逃出專案目錄', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFrontend(root);
  writeBackend(root);
  writeFileSync(join(root, 'taskflow.runtime.json'), JSON.stringify({
    runtime: {services: [
      {id: 'api', type: 'backend', cwd: 'backend', startCommand: 'npm run start', healthCheck: {path: '/healthz', expectedStatus: 200, expectedContentType: 'application/json'}},
      {id: 'web', type: 'frontend', cwd: 'frontend', dependsOn: ['api'], browserEntry: true, proxyPaths: ['/api', '/graphql']},
    ]},
  }));
  const topology = resolveRuntimeTopology(root);
  assert.equal(topology.source, 'explicit_config');
  assert.equal(topology.configFile, 'taskflow.runtime.json');
  assert.deepEqual(topology.services.map(service => service.id), ['api', 'web']);
  assert.equal(topology.services[0].healthCheck.path, '/healthz');
  assert.equal(topology.services[1].mode, 'managed', '沒有 startCommand 的前端由 TaskFlow 自管並負責轉發');
  assert.equal(topology.services[0].mode, 'spawn');

  assert.throws(() => normalizeTopology({services: [{id: 'x', cwd: '../outside', startCommand: 'node x.js'}]}, root), /必須位於專案目錄內/);
});

test('package manager 逐一服務判斷，不把整個專案當成同一個', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  const frontend = writeFrontend(root);
  const backend = writeBackend(root);
  writeFileSync(join(frontend, 'pnpm-lock.yaml'), '');
  writeFileSync(join(backend, 'package-lock.json'), '{}');
  assert.equal(detectPackageManager(frontend), 'pnpm');
  assert.equal(detectPackageManager(backend), 'npm');
});

// --- Test 7／8：runtime fingerprint --------------------------------------------
test('Test 7／8 — 改動 vite.config.ts 或後端 runtime 設定會讓指紋改變（既有 runtime 即為 stale）', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  writeFrontend(root);
  writeBackend(root);
  const topology = resolveRuntimeTopology(root);
  const frontend = topology.services.find(service => service.id === 'frontend');
  const backend = topology.services.find(service => service.id === 'backend');

  const frontendBefore = runtimeServiceFingerprint(frontend, {projectRoot: root, headCommit: 'abc'});
  const backendBefore = runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'abc'});

  writeFileSync(join(root, 'frontend/vite.config.ts'), 'export default {server:{proxy:{"/api":{}}}}');
  assert.notEqual(runtimeServiceFingerprint(frontend, {projectRoot: root, headCommit: 'abc'}), frontendBefore, 'vite.config.ts 改了，前端就是 stale');
  assert.equal(runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'abc'}), backendBefore, '前端的改動不應該讓後端變 stale');

  writeFileSync(join(root, 'backend/package.json'), JSON.stringify({name: 'backend', dependencies: {express: '^5'}, scripts: {dev: 'tsx watch src/index.ts'}}));
  assert.notEqual(runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'abc'}), backendBefore, '後端 runtime 設定改了，後端就是 stale');

  // HEAD 與未提交變更也算輸入：同樣的檔案、不同的 commit，指紋必須不同。
  assert.notEqual(
    runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'def'}),
    runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'abc'}),
  );
  assert.notEqual(
    runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'abc', workingTreeDigest: 'dirty'}),
    runtimeServiceFingerprint(backend, {projectRoot: root, headCommit: 'abc'}),
  );
});

// --- Test 5／6：API 回應語意 ---------------------------------------------------
const response = (status, contentType, body) => ({
  status,
  headers: {get: name => (name.toLowerCase() === 'content-type' ? contentType : null)},
  text: async () => body,
});

test('Test 5 — SPA fallback 的 200 text/html 在期待 JSON 時判定為 proxy_routing_failure', async () => {
  const outcome = await validateApiResponse('http://127.0.0.1:1/api/profile',
    {expectedStatus: null, expectedContentType: 'application/json', via: 'frontend'},
    {fetchImpl: async () => response(200, 'text/html; charset=utf-8', '<!DOCTYPE html><html><body><div id="app"></div></body></html>')});
  assert.equal(outcome.passed, false, 'HTTP 200 不等於 API 成功');
  assert.equal(outcome.status, 200);
  assert.equal(outcome.failureKind, 'proxy_routing_failure');
  assert.match(outcome.detail, /expected application\/json/);
  assert.match(outcome.detail, /received text\/html/);
  assert.match(outcome.detail, /SPA fallback/);
});

test('Test 6 — 真正經由轉發拿到 application/json 才算 connectivity 通過', async () => {
  const outcome = await validateConnectivity({
    frontendUrl: 'http://127.0.0.1:1',
    probes: [{path: '/api/health', expectedContentType: 'application/json'}],
    fetchImpl: async () => response(200, 'application/json', JSON.stringify({ok: true})),
  });
  assert.equal(outcome.passed, true);
  assert.equal(outcome.checks[0].actual, '200 application/json');

  // 401／403 仍算「後端真的接到了」：重點是型別，不是狀態碼。
  const unauthorized = await validateConnectivity({
    frontendUrl: 'http://127.0.0.1:1',
    probes: [{path: '/api/profile', expectedContentType: 'application/json'}],
    fetchImpl: async () => response(401, 'application/json', JSON.stringify({error: 'unauthorized'})),
  });
  assert.equal(unauthorized.passed, true);
});

test('expectedJsonShape 不符時仍然判定未通過，不因為 Content-Type 對了就放行', async () => {
  const outcome = await validateApiResponse('http://127.0.0.1:1/api/health',
    {expectedStatus: 200, expectedContentType: 'application/json', expectedJsonShape: {ok: true}},
    {fetchImpl: async () => response(200, 'application/json', JSON.stringify({ok: false}))});
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failureKind, 'unexpected_content_type');
});

// --- Test 9／10：waiting_input 與 Repair Agent 的界線 ---------------------------
test('Test 9 — 可回復的 runtime 失敗會自動重試，且一律不得進 waiting_input', () => {
  for (const kind of ['service_not_started', 'service_start_failed', 'service_unhealthy', 'dependency_unavailable', 'port_conflict', 'proxy_routing_failure', 'runtime_timeout', 'stale_runtime']) {
    assert.equal(isRecoverableRuntimeFailure(kind), true, `${kind} 應該可以自動回復`);
    assert.equal(requiresUserInput(kind), false, `${kind} 不是需要使用者回答的問題`);
    assert.equal(recoveryPlan(kind, {attempt: 0}).action, 'restart_runtime');
  }
  // 重試有上限，超過就 block，不是無限迴圈也不是靜靜放行。
  assert.equal(recoveryPlan('proxy_routing_failure', {attempt: MAX_RUNTIME_RECOVERY_ATTEMPTS}).action, 'block');
  assert.equal(MAX_RUNTIME_RECOVERY_ATTEMPTS, 2);
});

test('Test 10 — 只有真的需要使用者提供資訊的失敗才進 waiting_input', () => {
  assert.equal(requiresUserInput('topology_unresolved'), true);
  assert.equal(failureOwner('topology_unresolved'), 'user');
  // 其餘全部不是。
  for (const kind of RUNTIME_FAILURE_KINDS.filter(item => item !== 'topology_unresolved')) {
    assert.equal(requiresUserInput(kind), false, `${kind} 不該變成 waiting_input`);
  }
});

test('runtime 層的失敗不得直接觸發 Repair Agent；只有專案自己的程序問題才算功能失敗', () => {
  for (const kind of ['proxy_routing_failure', 'unexpected_content_type', 'stale_runtime', 'port_conflict', 'runtime_timeout', 'dependency_unavailable', 'service_not_started']) {
    assert.equal(failureOwner(kind), 'taskflow', `${kind} 是 TaskFlow 自己的執行環境問題`);
    assert.equal(shouldTriggerRepair(kind), false, `${kind} 不該讓 Repair Agent 去改專案的程式`);
  }
  for (const kind of ['service_start_failed', 'service_unhealthy', 'browser_failure']) {
    assert.equal(failureOwner(kind), 'project');
    assert.equal(shouldTriggerRepair(kind), true, `${kind} 是專案自己的問題，該進修正流程`);
  }
  assert.equal(shouldTriggerRepair(null), true, '沒有 runtime 失敗的一般驗證失敗照舊進修正流程');
});

test('detectProxyPaths 只取路徑、不沿用寫死的 target；沒有 proxy 設定時預設 /api', t => {
  const root = fixture();
  t.after(() => rmDirSafe(root));
  const withProxy = writeFrontend(root, {name: 'frontend'});
  assert.deepEqual(detectProxyPaths(withProxy), ['/api', '/uploads']);
  const withoutProxy = writeFrontend(root, {name: 'plain', proxy: false});
  assert.deepEqual(detectProxyPaths(withoutProxy), ['/api']);
  assert.equal(detectHealthPath(writeBackend(root, {name: 'svc'})), '/api/health');
});
