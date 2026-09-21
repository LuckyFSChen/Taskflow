// Project Runtime Topology：一個專案「要跑起來需要哪些程序」的正規模型。
//
// 在這之前 TaskFlow 只知道 projectRoot，而 Preview 的全部知識就是 resolveWebRoot() 回傳的
// **單一**目錄。前後端分離的專案因此永遠只會啟動 frontend：backend 沒有 vite 依賴，
// detectWebProjectHere() 判定它「不是網頁專案」而整個略過，於是 /api/* 命中 SPA fallback
// 回 200 text/html，Browser Validation 拿到假陽性再變成假陰性。
//
// 三個不可妥協的原則：
//   1. Project ≠ Process。一個專案可以對應多個 RuntimeService，各自有 cwd、port、PID。
//   2. 自動偵測只是 fallback。專案能明確宣告 runtime 時，宣告永遠優先於猜測。
//   3. 偵測不到就照實說「偵測不到」，絕不挑一個看起來最像的目錄硬跑——挑錯比沒有更糟。
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isReservedPort, RESERVED_PORTS} from './ports.js';
import {join, relative, isAbsolute, sep} from 'node:path';
import {isReservedPort, resolvePortRange} from './runtime-port-manager.js';

export const RUNTIME_SERVICE_TYPES = ['frontend', 'backend', 'worker', 'database', 'other'];

/** topology 的來源，依優先順序。UI 與報告要說得出「這份 topology 是怎麼來的」。 */
export const TOPOLOGY_SOURCES = ['explicit_config', 'project_metadata', 'auto_detection', 'single_service_fallback'];

// 掃描第一層子目錄時一律略過的目錄名。這些不可能是 runtime service，掃了只會拖慢並製造誤判。
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp', 'temp', 'vendor', 'public', 'assets', 'docs', 'doc', 'test', 'tests', '__tests__', 'scripts', 'migrations', 'data', '.git', 'target', 'bin', 'obj']);

// 前端框架訊號。有其中之一（或對應的設定檔）就視為 frontend。
const FRONTEND_DEPS = ['vite', 'next', 'nuxt', 'react-scripts', '@angular/core', 'svelte', '@sveltejs/kit', 'parcel', 'webpack-dev-server'];
const FRONTEND_CONFIG = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'nuxt.config.ts', 'nuxt.config.js', 'svelte.config.js', 'angular.json'];
// 後端框架訊號。注意 prisma／drizzle 也算：它們代表「這個目錄自己連資料庫」，不會是純前端。
const BACKEND_DEPS = ['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'restify', '@nestjs/core', 'prisma', '@prisma/client', 'drizzle-orm', 'mongoose', 'sequelize', 'typeorm', 'apollo-server', '@apollo/server', 'hono'];
const BACKEND_CONFIG = ['artisan', 'composer.json', 'prisma/schema.prisma', 'nest-cli.json'];
// worker 只從目錄名 + 後端訊號推斷；猜不準時寧可留在 backend/other。
const WORKER_NAMES = new Set(['worker', 'workers', 'queue', 'queues', 'jobs', 'consumer']);

// 慣用的前後端目錄配對。偵測不依賴這張表（真正的判斷是看依賴與設定檔），
// 它只用來在「同一層有多個候選」時決定誰是 browserEntry。
const FRONTEND_NAMES = ['frontend', 'front-end', 'web', 'client', 'ui', 'app', 'site', 'www'];

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
};

const isDir = path => {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
};

/** 把 cwd 一律正規化成「相對於 projectRoot、用 / 分隔」的形式，Windows 與設定檔才對得起來。 */
export function normalizeCwd(cwd, projectRoot) {
  if (!cwd || cwd === '.' || cwd === './') return '';
  const absolute = isAbsolute(cwd) ? cwd : join(projectRoot, cwd);
  const rel = relative(projectRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`runtime service 的 cwd 必須位於專案目錄內：${cwd}`);
  return rel.split(sep).join('/');
}

export function serviceDirectory(service, projectRoot) {
  return service.cwd ? join(projectRoot, service.cwd.split('/').join(sep)) : projectRoot;
}

// --- 偵測 --------------------------------------------------------------------

/**
 * 這個目錄是什麼樣的 runtime service。回傳 null 代表「這不是一個服務」，
 * 不是「這是一個不重要的服務」——呼叫端據此決定要不要把它排進 topology。
 */
export function classifyServiceDirectory(path, {name = ''} = {}) {
  const pkg = readJson(join(path, 'package.json'));
  const hasComposer = existsSync(join(path, 'composer.json')) || existsSync(join(path, 'artisan'));
  if (!pkg && !hasComposer) return null;
  const deps = {...pkg?.dependencies, ...pkg?.devDependencies};
  const scripts = pkg?.scripts || {};
  const frontendSignal = FRONTEND_DEPS.some(dep => deps[dep]) || FRONTEND_CONFIG.some(file => existsSync(join(path, file)));
  const backendSignal = BACKEND_DEPS.some(dep => deps[dep]) || BACKEND_CONFIG.some(file => existsSync(join(path, file)));
  // 兩種訊號同時出現（例如 vite + express 的 fullstack 專案）時算 frontend：
  // 它自己就是 browser 的入口，後端只是同一個程序的一部分。
  if (frontendSignal) return {type: 'frontend', pkg, deps, scripts};
  if (backendSignal) return {type: WORKER_NAMES.has(name.toLowerCase()) ? 'worker' : 'backend', pkg, deps, scripts};
  // 有 package.json 但看不出框架：可能是部署層或工具目錄，不當成服務。
  return null;
}

/** 依序挑第一個存在的 npm script；沒有就回 null，絕不編一個不存在的指令出來。 */
function pickScript(scripts, candidates) {
  return candidates.find(name => typeof scripts?.[name] === 'string' && scripts[name].trim()) || null;
}

/** 每個 service 各自判斷套件管理器，不把整個專案強制當成同一個（計畫書第二十七章）。 */
export function detectPackageManager(path) {
  if (existsSync(join(path, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(path, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(path, 'composer.json'))) return 'composer';
  return 'npm';
}

// health 路徑用掃原始碼決定，不寫死。掃不到就退回 fallback 模式（見 runtime-validation.js）：
// 「後端有回應任何 HTTP」仍然比「PID 存在」強得多，而且足以把 SPA fallback 區分開來。
const HEALTH_ROUTE = /['"`](\/(?:api\/)?(?:health|healthz|ping|status)(?:check)?)['"`]/i;
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.php', '.go', '.py']);

export function detectHealthPath(path, {maxFiles = 200} = {}) {
  const roots = ['src', 'app', 'lib', 'routes', 'server', ''].map(part => (part ? join(path, part) : path)).filter(isDir);
  let seen = 0;
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); }
    catch { return null; }
    for (const entry of entries) {
      if (seen >= maxFiles) return null;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) { const found = walk(child); if (found) return found; continue; }
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !SOURCE_EXT.has(entry.name.slice(dot))) continue;
      seen++;
      try {
        const match = HEALTH_ROUTE.exec(readFileSync(child, 'utf8'));
        if (match) return match[1];
      } catch { /* 讀不到就跳過，偵測不該因為一個檔案壞掉而整個失敗 */ }
    }
    return null;
  };
  for (const root of roots) { const found = walk(root); if (found) return found; }
  return null;
}

// frontend 需要被代理到後端的路徑。先讀專案自己的 vite/next 設定（那是專案作者已經宣告過的
// 意圖），讀不到才退回 /api。**絕不**沿用設定裡的 target：那通常是寫死的 localhost:3001，
// 正是計畫書第八章禁止的東西；TaskFlow 只取「哪些路徑要轉發」，target 一律用實際配到的 port。
//
// 每一條轉發路徑都帶 kind。這是為了把「namespace」與「可驗證的端點」分開：
//   api    —— 這個 namespace 底下有 JSON API。可以用**已知的端點**（不是 namespace 本身）
//             驗證它真的轉發到後端。
//   static —— 檔案／媒體 namespace。它合法地可能回 301、404、image/*、application/pdf，
//             要求它回 application/json 是錯的。這一類只需要證明「沒有落進 SPA fallback」。
// 沒有 kind 的話，/uploads 這種路徑會被當成 API 驗，於是一個 301 redirect 就被誤判成
// proxy_routing_failure，接著整組 runtime 被沒必要地重啟——那是 noise，不是問題。
const STATIC_NAMESPACE = /^\/(uploads?|static|media|files?|assets?|storage|images?|img|public|download(s)?)\b/i;
export function proxyPathKind(path) {
  return STATIC_NAMESPACE.test(path) ? 'static' : 'api';
}
export function normalizeProxyPath(entry) {
  const raw = typeof entry === 'string' ? {path: entry} : {...entry};
  const path = String(raw.path || '').trim();
  if (!path.startsWith('/')) throw new Error(`proxyPaths 的項目必須是以 / 開頭的路徑：${JSON.stringify(entry)}`);
  const kind = raw.kind === 'static' || raw.kind === 'api' ? raw.kind : proxyPathKind(path);
  return {path, kind};
}

const PROXY_KEY = /['"`](\/[\w\-./]*)['"`]\s*:\s*[{'"`]/g;
export function detectProxyPaths(path) {
  const found = new Set();
  for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vue.config.js', 'next.config.js']) {
    const full = join(path, file);
    if (!existsSync(full)) continue;
    let source;
    try { source = readFileSync(full, 'utf8'); } catch { continue; }
    const block = /proxy\s*:\s*\{/.exec(source);
    if (!block) continue;
    // 只掃 proxy 區塊之後的內容，避免把 resolve.alias 之類的鍵一起吃進來。
    const tail = source.slice(block.index);
    PROXY_KEY.lastIndex = 0;
    let match;
    while ((match = PROXY_KEY.exec(tail))) found.add(match[1]);
  }
  if (!found.size) found.add('/api');
  return [...found].map(normalizeProxyPath);
}

/**
 * 自動偵測。只往下找一層（外加 apps/*），而且只在「同時看得到前端與後端」時才回報
 * multi-service；只有前端時交給呼叫端走既有的單一服務路徑，行為與整改前一致。
 */
export function detectTopology(projectRoot, {maxDepthDirs = 40} = {}) {
  const candidates = [];
  const scan = (base, prefix) => {
    let entries;
    try { entries = readdirSync(base, {withFileTypes: true}); }
    catch { return; }
    for (const entry of entries) {
      if (candidates.length >= maxDepthDirs) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = join(base, entry.name);
      const classified = classifyServiceDirectory(child, {name: entry.name});
      if (classified) candidates.push({...classified, dir: child, name: entry.name, cwd: prefix ? `${prefix}/${entry.name}` : entry.name});
    }
  };
  scan(projectRoot, '');
  const appsDir = join(projectRoot, 'apps');
  if (isDir(appsDir)) scan(appsDir, 'apps');
  const packagesDir = join(projectRoot, 'packages');
  if (isDir(packagesDir)) scan(packagesDir, 'packages');

  const frontends = candidates.filter(item => item.type === 'frontend');
  const servers = candidates.filter(item => ['backend', 'worker'].includes(item.type));
  if (!frontends.length || !servers.length) return null;

  // 多個前端候選時，只有在其中恰好一個命中慣用名稱時才敢決定誰是 browser 入口；
  // 決定不了就回 null，由呼叫端要求使用者明確宣告——挑錯一個去驗收比不驗收更糟。
  let entry = frontends[0];
  if (frontends.length > 1) {
    const preferred = frontends.filter(item => FRONTEND_NAMES.includes(item.name.toLowerCase()));
    if (preferred.length !== 1) return null;
    entry = preferred[0];
  }

  const services = [];
  for (const server of servers) {
    const healthPath = detectHealthPath(server.dir);
    services.push(normalizeService({
      id: server.name,
      type: server.type,
      cwd: server.cwd,
      startCommand: pickScript(server.scripts, ['dev', 'start', 'serve']) ? `npm run ${pickScript(server.scripts, ['dev', 'start', 'serve'])}` : null,
      // 後端刻意不自動建置：dev script 幾乎都是從原始碼直接跑（tsx watch、nodemon、artisan serve），
      // 先跑一次 tsc 只是白花時間，而且 build 失敗會擋住一個其實跑得起來的服務。
      // 真的需要先建置的專案在 taskflow.runtime.json 裡寫 buildCommand，那一定會被執行。
      buildCommand: null,
      packageManager: detectPackageManager(server.dir),
      healthCheck: healthPath
        ? {path: healthPath, expectedStatus: 200, expectedContentType: 'application/json'}
        // 掃不到 health route：不假裝有一個。改用「伺服器回應得出 HTTP」這個較弱但誠實的判準，
        // 並在報告裡標明 inferred，讓使用者知道這一項不是專案自己宣告的。
        : {path: '/', expectedStatus: null, expectedContentType: null, anyHttpResponse: true, inferred: true},
      browserEntry: false,
    }, projectRoot));
  }
  services.push(normalizeService({
    id: entry.name,
    type: 'frontend',
    cwd: entry.cwd,
    // frontend 預設由 TaskFlow 自己的靜態伺服器 + proxy 提供（managed）：那是唯一能保證
    // /api/* 真的被轉發到本次配到的 backend port 的做法。專案若要自己起 preview，
    // 在 explicit config 寫 startCommand 即可。
    startCommand: null,
    buildCommand: pickScript(entry.scripts, ['build']) ? 'npm run build' : null,
    packageManager: detectPackageManager(entry.dir),
    proxyPaths: detectProxyPaths(entry.dir),
    dependsOn: services.map(service => service.id),
    browserEntry: true,
  }, projectRoot));

  return {projectRoot, source: 'auto_detection', services};
}

// --- 正規化與明確設定 ---------------------------------------------------------

export function normalizeProbe(entry) {
  const raw = typeof entry === 'string' ? {path: entry} : {...entry};
  const path = String(raw.path || '').trim();
  if (!path.startsWith('/')) throw new Error(`validationProbes 的項目必須是以 / 開頭的路徑：${JSON.stringify(entry)}`);
  const kind = raw.kind === 'static' ? 'static' : 'api';
  return {
    path,
    kind,
    expectedStatus: Number.isInteger(raw.expectedStatus) ? raw.expectedStatus : null,
    // static 類不預設 Content-Type：它合法地可能是 image/*、application/pdf、或一個 301。
    expectedContentType: raw.expectedContentType || (kind === 'api' ? 'application/json' : null),
    expectedJsonShape: raw.expectedJsonShape || null,
  };
}

/**
 * service.port 一旦宣告固定值，就是計畫書要根治的那個洞：taskflow.runtime.json 寫死的 port
 * 會被 runtime-manager.js 直接拿去 listen（見 startOne() 的 `service.port || await portAllocator()`），
 * 4310 就是這樣被誤配走的。實際 listen port 一律由 TaskFlow Runtime Port Pool 配發，
 * 宣告值只允許落在 pool 範圍內（即便如此也不會被實際使用，僅作為文件用途）；
 * 落在範圍外或等於保留 port 一律視為設定錯誤直接擋下，絕不靜默忽略後改配。
 */
function assertServicePortInPool(id, port) {
  if (port === null) return;
  const {start, end} = resolvePortRange();
  if (isReservedPort(port)) {
    throw new Error(`runtime service ${id} 宣告的 port ${port} 是保留 port（${port === 4310 ? 'TaskFlow Core' : 'Service Guardian'}），不得由 worktree service 使用。實際 listen port 一律由 TaskFlow Runtime Port Pool（${start}~${end}）配發，請移除 taskflow.runtime.json 裡的 port 宣告。`);
  }
  if (port < start || port > end) {
    throw new Error(`runtime service ${id} 宣告的 port ${port} 超出 TaskFlow Runtime Port Pool 範圍 ${start}~${end}。實際 listen port 一律由 Pool 全權配發，不接受落在範圍外的固定值，請移除 taskflow.runtime.json 裡的 port 宣告。`);
  }
}

export function normalizeService(raw, projectRoot) {
  if (!raw || typeof raw !== 'object') throw new Error('runtime service 必須是物件');
  const id = String(raw.id || '').trim();
  if (!id) throw new Error('runtime service 缺少 id');
  if (!/^[\w.-]+$/.test(id)) throw new Error(`runtime service id 只能使用英數與 . _ -：${id}`);
  const type = raw.type || 'other';
  if (!RUNTIME_SERVICE_TYPES.includes(type)) throw new Error(`未知的 runtime service type：${type}`);
  const startCommand = raw.startCommand ? String(raw.startCommand).trim() : null;
  const health = raw.healthCheck ? {...raw.healthCheck} : null;
  if (health && !health.path && !health.url) health.path = '/';
  const port = Number.isInteger(raw.port) ? raw.port : null;
  assertServicePortInPool(id, port);
  return {
    id,
    type,
    cwd: normalizeCwd(raw.cwd, projectRoot),
    startCommand,
    buildCommand: raw.buildCommand ? String(raw.buildCommand).trim() : null,
    installCommand: raw.installCommand ? String(raw.installCommand).trim() : null,
    packageManager: raw.packageManager || 'npm',
    port,
    healthCheck: health,
    dependsOn: Array.isArray(raw.dependsOn) ? [...new Set(raw.dependsOn.map(String))] : [],
    browserEntry: raw.browserEntry === true,
    proxyPaths: Array.isArray(raw.proxyPaths) ? raw.proxyPaths.map(normalizeProxyPath) : null,
    // 可以驗證的實際端點，與上面的 namespace 分開宣告。沒有宣告時由後端的 healthCheck 衍生
    // （見 runtime-validation.js 的 deriveConnectivityProbes）——**絕不**拿 namespace 本身當端點：
    // proxyPaths 裡的 /api 只代表「/api/* 轉發給後端」，不代表後端必須實作 GET /api。
    validationProbes: Array.isArray(raw.validationProbes) ? raw.validationProbes.map(normalizeProbe) : null,
    environment: raw.environment && typeof raw.environment === 'object' ? {...raw.environment} : {},
    persistent: raw.persistent === true,
    // managed：TaskFlow 自己用 express 伺服建置輸出並轉發 proxy，沒有子程序。
    // spawn：實際 spawn 一個子程序。由有沒有 startCommand 決定，不另外讓使用者設定。
    mode: startCommand ? 'spawn' : 'managed',
  };
}

export function normalizeTopology(raw, projectRoot) {
  const services = (raw?.services || []).map(service => normalizeService(service, projectRoot));
  if (!services.length) throw new Error('runtime 設定裡沒有任何 service');
  const ids = new Set();
  for (const service of services) {
    if (ids.has(service.id)) throw new Error(`重複的 runtime service id：${service.id}`);
    ids.add(service.id);
  }
  for (const service of services) {
    for (const dependency of service.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`service ${service.id} 依賴不存在的 service：${dependency}`);
    }
  }
  const entries = services.filter(service => service.browserEntry);
  if (entries.length > 1) throw new Error('只能有一個 service 標記 browserEntry');
  // 沒有人標 browserEntry 時，唯一的 frontend 自動成為入口；有多個就不猜。
  if (!entries.length) {
    const frontends = services.filter(service => service.type === 'frontend');
    if (frontends.length === 1) frontends[0].browserEntry = true;
  }
  orderRuntimeServices(services); // 這裡就把環狀相依攔下來，不要等到啟動時才炸
  return {projectRoot, source: raw?.source || 'explicit_config', services};
}

// 明確宣告的位置，依序檢查。taskflow.runtime.json 是首選；也接受寫在 package.json 裡，
// 讓專案不必為了一段設定多開一個檔案。
export const RUNTIME_CONFIG_FILES = ['taskflow.runtime.json', '.taskflow/runtime.json'];

export function readExplicitRuntimeConfig(projectRoot) {
  for (const file of RUNTIME_CONFIG_FILES) {
    const full = join(projectRoot, file);
    if (!existsSync(full)) continue;
    const parsed = readJson(full);
    if (!parsed) throw new Error(`${file} 不是合法的 JSON，無法解析 runtime 設定。`);
    const runtime = parsed.runtime || parsed;
    return {raw: runtime, file};
  }
  const pkg = readJson(join(projectRoot, 'package.json'));
  const runtime = pkg?.taskflow?.runtime || pkg?.runtime;
  if (runtime) return {raw: runtime, file: 'package.json'};
  return null;
}

/**
 * 解析 topology。優先順序（計畫書第七章）：
 *   明確 runtime 設定 → 專案 metadata → 自動偵測 → 單一服務 fallback
 * 回傳 null 代表「這不是 multi-service 專案」，呼叫端走既有單一服務流程。
 */
export function resolveRuntimeTopology(projectRoot, {metadata = null, detect = detectTopology} = {}) {
  const explicit = readExplicitRuntimeConfig(projectRoot);
  if (explicit) return {...normalizeTopology({...explicit.raw, source: 'explicit_config'}, projectRoot), configFile: explicit.file};
  if (metadata?.services?.length) return normalizeTopology({...metadata, source: 'project_metadata'}, projectRoot);
  const detected = detect(projectRoot);
  return detected ? normalizeTopology(detected, projectRoot) : null;
}

// --- 相依圖 ------------------------------------------------------------------

/**
 * 依 dependsOn 做拓撲排序。環狀相依直接丟例外：那是設定錯誤，不是可以邊跑邊修的狀況。
 * 同一層（互相沒有依賴）的服務維持宣告順序，讓啟動順序是可預測、可重現的。
 */
export function orderRuntimeServices(services) {
  const byId = new Map(services.map(service => [service.id, service]));
  const state = new Map(); // undefined=未訪問 / 1=訪問中 / 2=完成
  const order = [];
  const visit = (service, path) => {
    const mark = state.get(service.id);
    if (mark === 2) return;
    if (mark === 1) throw new Error(`runtime service 相依成環：${[...path, service.id].join(' → ')}`);
    state.set(service.id, 1);
    for (const dependency of service.dependsOn) {
      const next = byId.get(dependency);
      if (!next) throw new Error(`service ${service.id} 依賴不存在的 service：${dependency}`);
      visit(next, [...path, service.id]);
    }
    state.set(service.id, 2);
    order.push(service);
  };
  for (const service of services) visit(service, []);
  return order;
}

/** 這個 service 的直接與間接下游（restart 時要一起重新驗證的對象）。 */
export function dependentsOf(services, id) {
  const result = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const service of services) {
      if (result.has(service.id)) continue;
      if (service.dependsOn.some(dependency => dependency === id || result.has(dependency))) { result.add(service.id); changed = true; }
    }
  }
  return [...result];
}

export function browserEntryService(topology) {
  return topology?.services.find(service => service.browserEntry) || null;
}

// --- Runtime Fingerprint ------------------------------------------------------

// 影響 runtime 行為的檔案。改到這些就代表現有的程序是 stale，必須重啟；
// 改到別的原始碼由 HEAD／working tree 那一段涵蓋。
const FINGERPRINT_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.json', 'composer.lock', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'tsconfig.json', '.env', 'prisma/schema.prisma'];

function hashFile(path) {
  try { return createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 12); }
  catch { return null; }
}

/**
 * 一個 service 的 runtime 指紋。涵蓋計畫書第十七章列出的全部輸入：
 * HEAD、該 service 目錄下的未提交變更、cwd、start command、package.json、runtime 設定、
 * vite.config.*、以及 TaskFlow 注入的環境變數。
 *
 * git 相關資訊由呼叫端注入（runtime-manager 用 git-workspace 取得），這個模組不自己跑 git：
 * 純函式才測得動，也才不會在沒有 git 的環境裡整組壞掉。
 */
export function runtimeServiceFingerprint(service, {projectRoot, headCommit = null, workingTreeDigest = null, environment = {}} = {}) {
  const dir = serviceDirectory(service, projectRoot);
  const files = {};
  for (const file of FINGERPRINT_FILES) {
    const hash = hashFile(join(dir, file));
    if (hash) files[file] = hash;
  }
  for (const file of RUNTIME_CONFIG_FILES) {
    const hash = hashFile(join(projectRoot, file));
    if (hash) files[`@root/${file}`] = hash;
  }
  const payload = JSON.stringify({
    id: service.id,
    cwd: service.cwd,
    type: service.type,
    mode: service.mode,
    startCommand: service.startCommand,
    buildCommand: service.buildCommand,
    proxyPaths: service.proxyPaths,
    healthCheck: service.healthCheck,
    dependsOn: service.dependsOn,
    environment: {...service.environment, ...environment},
    headCommit,
    workingTreeDigest,
    files,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

/** 給 UI／報告用的簡短描述，不含環境變數值。 */
export function topologyPublic(topology) {
  if (!topology) return null;
  return {
    source: topology.source,
    configFile: topology.configFile || null,
    services: topology.services.map(service => ({
      id: service.id,
      type: service.type,
      cwd: service.cwd || '.',
      mode: service.mode,
      startCommand: service.startCommand,
      healthCheck: service.healthCheck ? {path: service.healthCheck.path || service.healthCheck.url, inferred: service.healthCheck.inferred === true} : null,
      dependsOn: service.dependsOn,
      browserEntry: service.browserEntry,
      proxyPaths: service.proxyPaths,
      validationProbes: service.validationProbes,
    })),
  };
}
