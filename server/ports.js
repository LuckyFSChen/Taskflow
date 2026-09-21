// TaskFlow Port Ownership：哪一個 port 屬於誰，只有這裡說了算。
//
// 分成兩層，兩層之間不得互相污染：
//
//   Infrastructure Port —— TaskFlow 本體固定使用，永遠不由誰「配發」：
//     4310  主服務           server/index.js
//     4311  Service Guardian server/service-guardian.js
//
//   Runtime Port —— Task worktree／Preview／Browser Validation／任務前後端等隔離環境使用。
//     由作業系統配發的高位動態 port，而且**永遠不會**是 4310 或 4311。
//
// 事故背景（這個模組存在的原因）：
// 主服務原本讀泛用的 process.env.PORT。但那個變數同時是 runtime 子程序用來宣告
// 「我自己的 port」的變數——server/runtime-manager.js 的 serviceEnvironment() 與
// server/project-preview.js 的 startFullstack() 都會設定它。只要主服務是從某個 runtime
// 環境（或在那個環境裡工作的 AI CLI、或那個環境開出來的終端機）啟動的，它就會繼承到
// 一個隨機高位 port，於是 server.log 寫著 60215，而 Restart-TaskFlow.ps1 對 4310 的
// 健康檢查永遠等不到人。
//
// 所以主服務不再讀 PORT：只認 TASKFLOW_PORT，沒設定就是 4310。
// 泛用的 PORT 從此純屬 runtime 子程序的身分，主服務看見它只會當成污染來記錄。
export const TASKFLOW_MAIN_PORT = 4310;
export const TASKFLOW_GUARDIAN_PORT = 4311;

/**
 * 任何 runtime port 配發者都必須跳過的 port。
 *
 * 這是唯一一份定義：server/runtime-port-manager.js（Runtime Port Pool／Lease）直接匯入並
 * 轉出同一份，才不會出現「兩個模組各自記得哪些 port 是保留的」這種必然走樣的狀態。
 */
export const RESERVED_PORTS = Object.freeze([TASKFLOW_MAIN_PORT, TASKFLOW_GUARDIAN_PORT]);

export const MAIN_PORT_ENV = 'TASKFLOW_PORT';
export const GUARDIAN_PORT_ENV = 'TASKFLOW_GUARDIAN_PORT';
export const MAIN_HOST_ENV = 'TASKFLOW_HOST';

/**
 * 這些變數描述的是「某一個 runtime 自己的位置」。
 * 它們不可以決定主服務聽哪個 port，主服務也不該把自己的那一份往下傳給子程序。
 */
export const RUNTIME_PORT_ENV_KEYS = ['PORT', 'HOST', 'PREVIEW_PORT', 'PREVIEW_URL', 'BACKEND_PORT', 'BACKEND_URL', 'FRONTEND_PORT', 'FRONTEND_URL'];

export function isReservedPort(port) {
  return RESERVED_PORTS.includes(Number(port));
}

/**
 * 設定值 → port。看不懂的值一律丟錯，不猜、不靜默退回預設值：
 * 「TASKFLOW_PORT=abc 於是服務隨便挑了一個 port」正是這次事故的形狀。
 * @returns {number|null} 沒有設定時回傳 null，由呼叫端決定預設值
 */
export function parsePortSetting(value, {name = 'port'} = {}) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必須是 1–65535 的整數，目前是：${raw}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`${name} 必須是 1–65535 的整數，目前是：${raw}`);
  return port;
}

/** 主服務要聽的 port。只認 TASKFLOW_PORT；泛用的 PORT 一律忽略。 */
export function resolveMainPort(env = process.env) {
  const override = parsePortSetting(env[MAIN_PORT_ENV], {name: MAIN_PORT_ENV});
  if (override === null) return TASKFLOW_MAIN_PORT;
  const guardian = parsePortSetting(env[GUARDIAN_PORT_ENV], {name: GUARDIAN_PORT_ENV}) ?? TASKFLOW_GUARDIAN_PORT;
  if (override === guardian) throw new Error(`${MAIN_PORT_ENV} 不能與 Service Guardian 的 ${guardian} 相同。`);
  return override;
}

/** Service Guardian 要聽的 port。同樣只認自己的變數。 */
export function resolveGuardianPort(env = process.env) {
  const override = parsePortSetting(env[GUARDIAN_PORT_ENV], {name: GUARDIAN_PORT_ENV});
  if (override === null) return TASKFLOW_GUARDIAN_PORT;
  const main = parsePortSetting(env[MAIN_PORT_ENV], {name: MAIN_PORT_ENV}) ?? TASKFLOW_MAIN_PORT;
  if (override === main) throw new Error(`${GUARDIAN_PORT_ENV} 不能與主服務的 ${main} 相同。`);
  return override;
}

/** 主服務要綁的介面。預設只聽本機。 */
export function resolveMainHost(env = process.env) {
  return env[MAIN_HOST_ENV] || env.HOST || '127.0.0.1';
}

export function mainServerOrigin(env = process.env) {
  return `http://${resolveMainHost(env)}:${resolveMainPort(env)}`;
}

/**
 * 這個環境裡有哪些「別人的 port」被帶進來了。
 * 主服務啟動時照實記錄一行；它不再影響行為，但它是下一次有人問
 * 「為什麼會跑到 60215」時唯一能直接回答的證據。
 */
export function inheritedRuntimePorts(env = process.env) {
  return RUNTIME_PORT_ENV_KEYS
    .filter(key => key.endsWith('PORT') && env[key] !== undefined && String(env[key]).trim() !== '')
    .map(key => `${key}=${String(env[key]).trim()}`);
}

/** 子程序環境：把「我是不是主服務」這件事拿掉，子程序自己的 port 由呼叫端明確設定。 */
export function withoutInfrastructurePorts(env = process.env) {
  const copy = {...env};
  for (const key of [MAIN_PORT_ENV, GUARDIAN_PORT_ENV, MAIN_HOST_ENV, 'PORT', 'HOST']) delete copy[key];
  return copy;
}

/**
 * 由 TaskFlow 本體啟動、而且**必須是主服務身分**的子程序（例如 service recovery 會再
 * 啟動一次 server/index.js）使用的環境：先清掉任何繼承來的 runtime port，再釘上正式的值。
 */
export function infrastructureEnvironment(env = process.env) {
  const copy = withoutInfrastructurePorts(env);
  copy[MAIN_PORT_ENV] = String(resolveMainPort(env));
  copy[GUARDIAN_PORT_ENV] = String(resolveGuardianPort(env));
  copy[MAIN_HOST_ENV] = resolveMainHost(env);
  return copy;
}
