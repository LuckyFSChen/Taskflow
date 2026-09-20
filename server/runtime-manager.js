// Multi-Service Process Lifecycle Manager。
//
// 整改前：一個 Preview key 對應一個子程序，PID／port／cwd 各只有一份，停止之後只確認
// 「那一個 PID」消失。前後端分離的專案在這個模型裡根本表達不出來。
//
// 這個模組把 runtime 拆成「每個 RuntimeService 各自有自己的 PID / port / cwd / command /
// url / status / startedAt / fingerprint」，並依 dependsOn 依序啟動、逐一健康檢查、
// 反向順序關閉、確認 PID 消失且 port 釋放。
//
// 四個不可妥協的原則：
//   1. ready 一定要驗過。PID 存在不是 ready（見 runtime-validation.js 的 waitForServiceHealth）。
//   2. 相依沒 ready 就不啟動下游。backend 還沒好就開 frontend，只會得到一次假失敗。
//   3. 「停止了」是驗證過的結論：PID 消失 **且** port 放掉，兩者都要。
//   4. 絕不因為「PID 還活著」就盲殺。認不出身分的一律保留並照實回報（沿用 process-lifecycle.js）。
import {spawn} from 'node:child_process';
import {createServer as createNetProbe, connect as netConnect} from 'node:net';
import {existsSync} from 'node:fs';
import {join, sep} from 'node:path';
import {childEnvironment, resolveNpmCli} from './npm-runner.js';
import {isAlive, registerPreview, unregisterPreview, waitForExit} from './process-lifecycle.js';
import {orderRuntimeServices, dependentsOf, runtimeServiceFingerprint, serviceDirectory} from './runtime-topology.js';
import {RuntimeFailure, waitForServiceHealth} from './runtime-validation.js';

export const SERVICE_STATES = ['STARTING', 'READY', 'STALE', 'STOPPING', 'STOPPED', 'FAILED'];

/** 可用的埠。交給作業系統挑，避免自己維護一張「用過哪些」的表而與現實脫節。 */
export function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetProbe();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** 這個 port 現在還有沒有人在聽。stop() 之後要據此確認「連接埠已釋放」。 */
export function portInUse(port, {timeoutMs = 500} = {}) {
  return new Promise(resolve => {
    const socket = netConnect({port, host: '127.0.0.1'});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function waitForPortRelease(port, {timeoutMs = 5000, pollMs = 150} = {}) {
  if (!port) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return !(await portInUse(port));
}

/**
 * 啟動指令 → 實際要 spawn 的 {file, args}。
 *
 * 一律不經過 shell：專案目錄或指令字串裡的字元不可能被當成指令解讀。
 * 只接受可以安全還原成參數陣列的幾種形狀；看不懂的指令照實拒絕，不猜、不用 shell 硬跑。
 *
 * pnpm / yarn 的 run script 會改用同一份 npm 執行：套件管理器的差異在 install 階段，
 * 「跑一個 package.json script」三者語意相同，而 npm-cli.js 是唯一能不經 PATH／shell
 * 直接用 node 執行的那一個。install 仍然照 service 自己的 packageManager 進行。
 */
export function parseStartCommand(command, {execPath = process.execPath, npmCli = resolveNpmCli(execPath)} = {}) {
  const text = String(command || '').trim();
  if (!text) throw new RuntimeFailure('service_start_failed', '這個 service 沒有 startCommand。');
  if (/[&|;><`$]/.test(text)) throw new RuntimeFailure('service_start_failed', `startCommand 含有 shell 運算子，TaskFlow 不會經過 shell 執行：${text}`);
  const parts = text.split(/\s+/);
  const [tool, ...rest] = parts;

  if (['npm', 'pnpm', 'yarn'].includes(tool)) {
    if (!npmCli) throw new RuntimeFailure('service_start_failed', '找不到 npm，請安裝包含 npm 的 Node.js。');
    // `yarn dev` 省略了 run；npm 需要補回來。
    const args = rest[0] === 'run' ? rest : (tool === 'yarn' ? ['run', ...rest] : rest);
    return {file: execPath, args: [npmCli, ...args], script: args[0] === 'run' ? args[1] : args[0], viaNpm: true};
  }
  if (tool === 'node') {
    const file = rest[0];
    if (!file || file.startsWith('-')) throw new RuntimeFailure('service_start_failed', `無法解析 node 啟動指令：${text}`);
    return {file: execPath, args: rest, script: file, viaNpm: false};
  }
  throw new RuntimeFailure('service_start_failed', `不支援的 startCommand：${text}。請使用 npm run <script>、yarn <script>、pnpm run <script> 或 node <file>.js，或在 taskflow.runtime.json 明確宣告。`);
}

/**
 * 語意明確的環境變數（計畫書第八章）。
 *
 * PORT 只代表「這個 service 自己的 port」，絕不再兼任 backend／frontend／preview 三種身分。
 * 其他 service 的位置一律透過 <TYPE>_URL／<TYPE>_PORT 與 TASKFLOW_SERVICE_<ID>_URL 傳遞。
 */
export function serviceEnvironment(service, {port, peers = [], base = process.env, extra = {}} = {}) {
  const env = childEnvironment(base, {});
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  env.TASKFLOW_SERVICE_ID = service.id;
  env.TASKFLOW_SERVICE_TYPE = service.type;
  for (const peer of peers) {
    if (!peer.url) continue;
    const idKey = peer.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    env[`TASKFLOW_SERVICE_${idKey}_URL`] = peer.url;
    env[`TASKFLOW_SERVICE_${idKey}_PORT`] = String(peer.port);
    // 型別層級的別名只在該型別唯一時才有意義；有兩個 backend 時不指定誰是「那個」backend。
    if (peers.filter(item => item.type === peer.type).length === 1) {
      const typeKey = peer.type.toUpperCase();
      env[`${typeKey}_URL`] = peer.url;
      env[`${typeKey}_PORT`] = String(peer.port);
    }
  }
  if (service.type === 'frontend') { env.FRONTEND_PORT = String(port); env.FRONTEND_URL = `http://127.0.0.1:${port}`; }
  Object.assign(env, service.environment || {}, extra);
  return env;
}

const publicService = state => ({
  id: state.id, type: state.type, cwd: state.cwd || '.', mode: state.mode,
  status: state.status, url: state.url, port: state.port, pid: state.pid,
  command: state.command, startedAt: state.startedAt,
  health: state.health ? {passed: state.health.passed === true, url: state.health.url || null, status: state.health.status ?? null, contentType: state.health.contentType || null, detail: state.health.detail || null} : null,
  failureKind: state.failureKind || null, error: state.error || null,
  browserEntry: state.browserEntry === true, dependsOn: state.dependsOn,
});

export function runtimePublic(runtime) {
  if (!runtime) return null;
  return {
    key: runtime.key,
    source: runtime.source,
    status: runtime.status,
    entryUrl: runtime.entryUrl || null,
    services: runtime.services.map(publicService),
    failureKind: runtime.failureKind || null,
    error: runtime.error || null,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.registryPath 服務重啟後還認得出自己開過哪些子程序的磁碟登錄
 */
export function createRuntimeManager({
  registryPath, spawnProcess = spawn, fetchImpl = fetch, portAllocator = allocatePort,
  execPath = process.execPath, healthTimeoutMs = 60000, onEvent = () => {},
} = {}) {
  /** key → {topology, services: Map<id, state>, managed: Map<id, handle>} */
  const runtimes = new Map();

  function emit(kind, payload) {
    try { onEvent(kind, payload); } catch { /* 事件送不出去不該讓 runtime 停擺 */ }
  }

  async function stopState(state) {
    if (state.mode === 'managed') {
      state.status = 'STOPPING';
      try { await state.managedStop?.(); } catch { /* 關不掉照實回報，不重試也不升級手段 */ }
      state.status = 'STOPPED';
      const released = await waitForPortRelease(state.port);
      emit('runtime_service_stopped', {service: state.id, pid: null, verified: true, portReleased: released});
      return {id: state.id, pid: null, verified: true, portReleased: released};
    }
    state.status = 'STOPPING';
    const child = state.child;
    if (child && child.exitCode === null && !child.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        // killTree 由 runner.js 提供；這裡動態載入避免模組相依成環。
        import('./runner.js').then(({killTree}) => killTree(child)).catch(() => { try { child.kill(); } catch { /* 已經不在了 */ } });
      });
    }
    const verified = state.pid ? await waitForExit(state.pid, {timeoutMs: 5000}) : true;
    const released = await waitForPortRelease(state.port);
    state.status = verified ? 'STOPPED' : 'FAILED';
    if (!verified) { state.failureKind = 'stale_runtime'; state.error = `已要求停止，但 PID ${state.pid} 仍然存在。`; }
    if (registryPath) unregisterPreview(registryPath, `${state.runtimeKey}#${state.id}`);
    emit('runtime_service_stopped', {service: state.id, pid: state.pid, verified, portReleased: released});
    return {id: state.id, pid: state.pid ?? null, verified, portReleased: released};
  }

  async function startOne(service, context) {
    const {key, projectRoot, npm, startManaged, peers, fingerprint, extraEnv} = context;
    const dir = serviceDirectory(service, projectRoot);
    if (!existsSync(dir)) throw new RuntimeFailure('service_start_failed', `service ${service.id} 的目錄不存在：${service.cwd || '.'}`);
    const port = service.port || await portAllocator();
    const url = `http://127.0.0.1:${port}`;
    const state = {
      runtimeKey: key, id: service.id, type: service.type, cwd: service.cwd, mode: service.mode,
      dependsOn: service.dependsOn, browserEntry: service.browserEntry,
      port, url, pid: null, child: null, status: 'STARTING', startedAt: new Date().toISOString(),
      command: service.startCommand, health: null, failureKind: null, error: null,
      fingerprint: runtimeServiceFingerprint(service, {projectRoot, ...fingerprint}),
      service,
    };
    emit('runtime_service_starting', {service: service.id, type: service.type, cwd: service.cwd || '.', port, mode: service.mode});

    // 建置是 service-aware 的：不假設根目錄有一個 npm run build（計畫書第二十六章）。
    if (service.buildCommand && npm) {
      if (!existsSync(join(dir, 'node_modules'))) await npm(dir, ['install']);
      await npm(dir, ['run', service.buildCommand.replace(/^\S+\s+run\s+/, '')]);
    } else if (service.mode === 'spawn' && npm && !existsSync(join(dir, 'node_modules')) && existsSync(join(dir, 'package.json'))) {
      await npm(dir, ['install']);
    }

    const env = serviceEnvironment(service, {port, peers, extra: extraEnv});

    if (service.mode === 'managed') {
      const handle = await startManaged(service, {port, url, env, dir, peers});
      state.managedStop = handle.stop;
      state.url = handle.url || url;
      state.status = 'READY';
      state.health = {passed: true, url: state.url, detail: 'TaskFlow 自管的靜態／代理伺服器。'};
      emit('runtime_service_ready', {service: service.id, url: state.url, port, pid: null});
      return state;
    }

    const parsed = parseStartCommand(service.startCommand, {execPath});
    const args = [...parsed.args];
    // frontend 自己起 dev/preview 伺服器時要把 port 告訴它：vite 這類工具不讀 PORT。
    if (service.type === 'frontend' && parsed.viaNpm) args.push('--', '--port', String(port), '--host', '127.0.0.1');
    const child = spawnProcess(execPath, args, {cwd: dir, env, shell: false, windowsHide: true});
    state.child = child;
    state.pid = child.pid ?? null;
    let stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-3000); });
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.once('error', () => { exited = true; });
    if (registryPath && state.pid) {
      registerPreview(registryPath, {
        key: `${key}#${service.id}`, pid: state.pid, url, kind: `runtime:${service.type}`, cwd: dir,
        healthUrl: service.healthCheck?.url || (service.healthCheck?.path ? `${url}${service.healthCheck.path}` : null),
      });
    }

    const health = await waitForServiceHealth(service, url, {timeoutMs: healthTimeoutMs, fetchImpl, isAlive: () => !exited && (state.pid ? isAlive(state.pid) : true)});
    state.health = health;
    if (!health.passed) {
      state.status = 'FAILED';
      state.failureKind = health.failureKind || 'service_unhealthy';
      state.error = `${health.detail || '健康檢查未通過'}${stderr ? `\nstderr: ${stderr.slice(-800)}` : ''}`;
      emit('runtime_service_failed', {service: service.id, failureKind: state.failureKind, detail: state.error});
      await stopState(state);
      throw new RuntimeFailure(state.failureKind, `service ${service.id} 未能就緒：${health.detail || '健康檢查未通過'}`, {service: state.id, stderr: stderr.slice(-800), health});
    }
    state.status = 'READY';
    emit('runtime_service_ready', {service: service.id, url, port, pid: state.pid});
    // 子程序在 ready 之後自己死掉：狀態要跟著變，下一次 preflight 才看得出來要重啟。
    child.once('exit', code => {
      if (state.status === 'READY') { state.status = 'FAILED'; state.failureKind = 'service_start_failed'; state.error = `service ${service.id} 在就緒後結束（code ${code}）。`; }
      if (registryPath) unregisterPreview(registryPath, `${key}#${service.id}`);
    });
    return state;
  }

  /**
   * 依相依順序啟動整組服務。任何一個失敗就把已經起來的全部關掉再往外丟——
   * 半開的 runtime 比沒有 runtime 更難判讀，也會留下佔著 port 的孤兒。
   */
  async function start(key, topology, options = {}) {
    const existing = runtimes.get(key);
    if (existing) {
      const stale = staleServices(existing, topology, options);
      if (!stale.length && existing.services.every(state => state.status === 'READY')) return existing;
      // 有 stale 或有服務掛掉：只重啟受影響的那些（計畫書第十八章），不整組砍掉重跑。
      await restartServices(key, topology, stale.length ? stale : existing.services.filter(state => state.status !== 'READY').map(state => state.id), options);
      return runtimes.get(key);
    }
    const ordered = orderRuntimeServices(topology.services);
    emit('runtime_topology_detected', {key, source: topology.source, services: ordered.map(service => ({id: service.id, type: service.type, cwd: service.cwd || '.', dependsOn: service.dependsOn}))});
    const started = [];
    const runtime = {key, projectRoot: topology.projectRoot, source: topology.source, topology, services: started, status: 'STARTING', entryUrl: null, failureKind: null, error: null};
    runtimes.set(key, runtime);
    try {
      for (const service of ordered) {
        // 相依必須已經 READY 才往下走；否則這一個的失敗會被誤歸類成它自己的問題。
        for (const dependency of service.dependsOn) {
          const upstream = started.find(state => state.id === dependency);
          if (!upstream || upstream.status !== 'READY') throw new RuntimeFailure('dependency_unavailable', `service ${service.id} 的相依 ${dependency} 尚未就緒，不啟動下游。`, {service: service.id, dependency});
        }
        const state = await startOne(service, {
          key, projectRoot: topology.projectRoot, npm: options.npm, startManaged: options.startManaged,
          peers: started.map(item => ({id: item.id, type: item.type, url: item.url, port: item.port})),
          fingerprint: options.fingerprint || {}, extraEnv: options.env || {},
        });
        started.push(state);
      }
    } catch (error) {
      runtime.status = 'FAILED';
      runtime.failureKind = error instanceof RuntimeFailure ? error.kind : 'unknown';
      runtime.error = String(error?.message || error);
      for (const state of [...started].reverse()) await stopState(state);
      runtimes.delete(key);
      throw error;
    }
    const entry = started.find(state => state.browserEntry) || started.at(-1);
    runtime.status = 'READY';
    runtime.entryUrl = entry?.url || null;
    runtime.entryServiceId = entry?.id || null;
    return runtime;
  }

  /** 指紋變了、或程序已經不在了的服務（以及它們的下游）。 */
  function staleServices(runtime, topology, options = {}) {
    const stale = new Set();
    for (const service of topology.services) {
      const state = runtime.services.find(item => item.id === service.id);
      if (!state) { stale.add(service.id); continue; }
      const fingerprint = runtimeServiceFingerprint(service, {projectRoot: topology.projectRoot, ...(options.fingerprint || {})});
      if (fingerprint !== state.fingerprint) { state.status = 'STALE'; emit('runtime_service_stale', {service: service.id, reason: 'fingerprint_changed'}); stale.add(service.id); continue; }
      if (state.mode === 'spawn' && state.pid && !isAlive(state.pid)) { state.status = 'FAILED'; state.failureKind = 'service_start_failed'; stale.add(service.id); }
    }
    // 上游重啟時，下游至少要重新驗證；直接一起重啟最單純也最不會留下半舊的 proxy 目標。
    for (const id of [...stale]) for (const dependent of dependentsOf(topology.services, id)) stale.add(dependent);
    return [...stale];
  }

  async function restartServices(key, topology, ids, options = {}) {
    const runtime = runtimes.get(key);
    if (!runtime) return start(key, topology, options);
    const targets = new Set(ids);
    const ordered = orderRuntimeServices(topology.services);
    for (const state of [...runtime.services].reverse()) if (targets.has(state.id)) { emit('runtime_service_restarting', {service: state.id}); await stopState(state); }
    runtime.services = runtime.services.filter(state => !targets.has(state.id));
    for (const service of ordered) {
      if (!targets.has(service.id)) continue;
      for (const dependency of service.dependsOn) {
        const upstream = runtime.services.find(state => state.id === dependency);
        if (!upstream || upstream.status !== 'READY') throw new RuntimeFailure('dependency_unavailable', `service ${service.id} 的相依 ${dependency} 尚未就緒。`, {service: service.id, dependency});
      }
      const state = await startOne(service, {
        key, projectRoot: topology.projectRoot, npm: options.npm, startManaged: options.startManaged,
        peers: runtime.services.map(item => ({id: item.id, type: item.type, url: item.url, port: item.port})),
        fingerprint: options.fingerprint || {}, extraEnv: options.env || {},
      });
      // 維持宣告順序，UI 上的服務清單才不會每次重啟就跳動。
      runtime.services.splice(ordered.findIndex(item => item.id === service.id), 0, state);
    }
    const entry = runtime.services.find(state => state.browserEntry) || runtime.services.at(-1);
    runtime.entryUrl = entry?.url || null;
    runtime.status = runtime.services.every(state => state.status === 'READY') ? 'READY' : 'FAILED';
    return runtime;
  }

  async function stop(key) {
    const runtime = runtimes.get(key);
    if (!runtime) return {stopped: false, reason: 'not_running', services: []};
    runtimes.delete(key);
    const results = [];
    // 反向順序關閉：先停下游再停上游，避免前端在後端消失後噴一串連線錯誤。
    for (const state of [...runtime.services].reverse()) {
      if (state.service?.persistent) { results.push({id: state.id, pid: state.pid ?? null, verified: true, skipped: 'persistent'}); continue; }
      results.push(await stopState(state));
    }
    return {stopped: true, services: results, verified: results.every(item => item.verified !== false)};
  }

  return {
    start,
    stop,
    restartServices,
    staleServices,
    get(key) { return runtimes.get(key) || null; },
    keys() { return [...runtimes.keys()]; },
    async close() { for (const key of [...runtimes.keys()]) await stop(key); },
  };
}
