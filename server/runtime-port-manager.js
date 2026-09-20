// TaskFlow Runtime Port Pool / Lease。
//
// 問題的根源不是「worktree 不要碰 4310」，而是 TaskFlow 從來沒有一個「這個 port 現在是誰的」
// 的中央帳本：allocatePort()（runtime-manager.js）用 listen(0) 交給作業系統隨機挑，
// taskflow.runtime.json 明確宣告的 service.port 又會直接被拿來用——4310 就是這樣被誤配走的。
//
// 這個模組把「port 從哪裡來」收斂成一件事：TaskFlow Runtime Port Pool（預設 45000~45099）。
// 任何由 TaskFlow 管理的 worktree service，實際 listen port 只能來自這裡；4310／4311 永遠只
// 分別屬於 TaskFlow Core 與 Service Guardian，這個模組不會、也不能把這兩個 port 配給任何人。
//
// 三個不可妥協的原則：
//   1. Port 只是資源，不是 kill 的依據。這個模組完全不知道怎麼殺程序——canProveOwnership／stop
//      一律由呼叫端注入，reconcile() 對「無法證明是自己 orphan」的 lease 一律保留、不動手。
//   2. Pool 滿了就是滿了。acquire() 找不到可用 port 時明確失敗並列出目前的 active leases，
//      絕不 fallback 到 4310／4311／3000／5173 或另一個隨機 OS port。
//   3. 「可用」是驗證過的結論：候選 port 必須同時「未被 lease」「OS 未在 Listen」
//      「不在 Windows excludedportrange 內」，缺一不可；45000~45099 只是候選池，不是保證。
import {connect as netConnect} from 'node:net';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {isAlive, waitForExit} from './process-lifecycle.js';

/** 這兩個 port 永遠分別屬於 TaskFlow Core（4310）與 Service Guardian（4311），任何情況下都不可配發。 */
export const RESERVED_PORTS = Object.freeze([4310, 4311]);

export function isReservedPort(port) {
  return RESERVED_PORTS.includes(Number(port));
}

const DEFAULT_POOL_START = 45000;
const DEFAULT_POOL_END = 45099;

/**
 * 解析 Runtime Port Pool 的邊界。可透過 TASKFLOW_RUNTIME_PORT_START/END 設定，
 * 但範圍讀取失敗、不合法、或不涵蓋 45000~45099 保留範圍時，視為設定錯誤直接擋下啟動——
 * 不要讓一個打錯的環境變數悄悄把 pool 縮小或挪去別的地方。
 */
export function resolvePortRange({env = process.env} = {}) {
  const rawStart = env.TASKFLOW_RUNTIME_PORT_START;
  const rawEnd = env.TASKFLOW_RUNTIME_PORT_END;
  const start = rawStart === undefined ? DEFAULT_POOL_START : Number.parseInt(rawStart, 10);
  const end = rawEnd === undefined ? DEFAULT_POOL_END : Number.parseInt(rawEnd, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) {
    throw new Error(`TASKFLOW_RUNTIME_PORT_START/END 必須是合法的正整數，目前是 ${rawStart ?? '(未設定)'}~${rawEnd ?? '(未設定)'}`);
  }
  if (end < start) throw new Error(`TASKFLOW_RUNTIME_PORT_END (${end}) 不得小於 TASKFLOW_RUNTIME_PORT_START (${start})`);
  if (start > DEFAULT_POOL_START || end < DEFAULT_POOL_END) {
    throw new Error(`TASKFLOW_RUNTIME_PORT_START~END (${start}~${end}) 必須涵蓋 TaskFlow Runtime Port Pool 的保留範圍 ${DEFAULT_POOL_START}~${DEFAULT_POOL_END}。`);
  }
  for (const reserved of RESERVED_PORTS) {
    if (reserved >= start && reserved <= end) throw new Error(`TASKFLOW_RUNTIME_PORT_START~END 不得涵蓋保留 port ${reserved}（${reserved === 4310 ? 'TaskFlow Core' : 'Service Guardian'}）。`);
  }
  return {start, end};
}

/** 這個 port 現在有沒有人在聽。與 runtime-manager.js 的 portInUse() 邏輯一致，各自獨立以避免模組互相依賴成環。 */
export function portInUse(port, {timeoutMs = 500} = {}) {
  return new Promise(resolve => {
    const socket = netConnect({port, host: '127.0.0.1'});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function readLeaseFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(entry => entry && Number.isInteger(entry.port)) : [];
  } catch { return []; }
}

function writeLeaseFile(path, leases) {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(leases, null, 1));
    return true;
  } catch { return false; }
}

function formatLease(lease) {
  return `${lease.port}(task=${lease.taskId},service=${lease.serviceId}${lease.pid ? `,pid=${lease.pid}` : ''})`;
}

/**
 * @param {object} options
 * @param {string} [options.leasePath] lease 的磁碟登錄，供服務重啟後 reconcile() 讀取；不給就只在記憶體內運作（測試用）。
 * @param {{start:number,end:number}} [options.range] pool 邊界，預設讀環境變數／45000~45099。
 * @param {(port:number)=>Promise<boolean>} [options.checkPortInUse] 可注入以避免測試真的綁定系統 port。
 * @param {Array<{start:number,end:number}>} [options.excludedRanges] Windows netsh excludedportrange，acquire() 掃描時跳過。
 */
export function createRuntimePortManager({
  leasePath = null,
  range = resolvePortRange(),
  checkPortInUse = portInUse,
  excludedRanges = [],
  now = () => new Date().toISOString(),
  onEvent = () => {},
  log = (...args) => console.log(...args),
} = {}) {
  /** port(number) → lease。active lease 全域唯一，Map 的 key 天生保證同一個 port 只有一筆。 */
  const leases = new Map();
  for (const lease of leasePath ? readLeaseFile(leasePath) : []) leases.set(lease.port, lease);

  function emit(kind, payload) {
    try { onEvent(kind, payload); } catch { /* 事件送不出去不該讓 port manager 停擺 */ }
  }

  function persist() {
    if (leasePath) writeLeaseFile(leasePath, [...leases.values()]);
  }

  function isReserved(port) {
    return isReservedPort(port);
  }

  function inExcludedRange(port) {
    return excludedRanges.some(({start, end}) => port >= start && port <= end);
  }

  /** 這個 port 現在是不是真的可以配發：沒被 lease、不是保留 port、不在 Windows excluded range、OS 目前沒人在聽。 */
  async function isAvailable(port) {
    if (isReservedPort(port)) return false;
    if (leases.has(port)) return false;
    if (inExcludedRange(port)) return false;
    return !(await checkPortInUse(port));
  }

  function listLeases() {
    return [...leases.values()].map(lease => ({...lease}));
  }

  /**
   * 配發一個 port。依序掃描 pool，第一個可用的就用；找不到就明確失敗並列出目前的 active leases，
   * 絕不 fallback 到保留 port 或隨機 OS port（計畫書第十七章）。
   */
  async function acquire({taskId, serviceId}) {
    if (!taskId || !serviceId) throw new Error('acquire() 需要 taskId 與 serviceId，才能記錄這個 port 是誰租的。');
    for (let port = range.start; port <= range.end; port++) {
      if (!(await isAvailable(port))) continue;
      const lease = {port, taskId, serviceId, pid: null, createdAt: now(), status: 'pending'};
      leases.set(port, lease);
      persist();
      log(`[runtime-port] leased ${port} task=${taskId} service=${serviceId}`);
      emit('runtime_port_leased', {port, taskId, serviceId});
      return port;
    }
    const total = range.end - range.start + 1;
    const active = listLeases();
    const detail = active.length ? active.map(formatLease).join(', ') : '(none)';
    throw new Error(`TaskFlow runtime port pool exhausted. Available runtime ports: 0 / ${total}. Active leases: ${detail}`);
  }

  /** spawn 完成後把實際的 PID 綁回 lease，狀態轉 active。cleanup／reconcile 都靠這個 PID 辨認身分。 */
  function bindPid(port, pid) {
    const lease = leases.get(port);
    if (!lease) throw new Error(`port ${port} 沒有對應的 lease，無法綁定 pid=${pid}。`);
    lease.pid = pid;
    lease.status = 'active';
    persist();
    log(`[runtime-port] bound pid=${pid} port=${port} task=${lease.taskId} service=${lease.serviceId}`);
    emit('runtime_port_bound', {port, pid, taskId: lease.taskId, serviceId: lease.serviceId});
    return {...lease};
  }

  /** 釋放一個 lease。呼叫端必須先確認 process 已終止、port 已不再 Listen，這個函式本身不做任何驗證。 */
  function release(port) {
    const lease = leases.get(port);
    if (!lease) return false;
    leases.delete(port);
    persist();
    log(`[runtime-port] released ${port}`);
    emit('runtime_port_released', {port, taskId: lease.taskId, serviceId: lease.serviceId});
    return true;
  }

  /**
   * 對帳：只處理已經綁定 PID 的 lease（尚未綁定的視為啟動中，交給呼叫端自行判斷是否逾時）。
   * PID 已經不在 → 直接視為 gone，清掉 lease。
   * PID 還在但 canProveOwnership() 判定不出這是 TaskFlow 自己建立的 → 一律保留、回報 unknown，絕不動手。
   * PID 還在且能證明身分 → 呼叫注入的 stop()，等待真的結束後才清掉 lease；停不掉就保留並回報。
   *
   * 這個模組本身不知道「怎麼證明身分」也不知道「怎麼殺」：canProveOwnership／stop 都由呼叫端注入
   * （例如比對 process-lifecycle.js 的 registry + healthUrl），維持「port 只是資源，process ownership
   * 才是 kill 依據」這個原則。
   */
  async function reconcile({alive = isAlive, canProveOwnership = async () => false, stop = null, wait = waitForExit} = {}) {
    const gone = [], reconciled = [], unknown = [];
    for (const lease of [...leases.values()]) {
      if (!lease.pid) continue;
      if (!alive(lease.pid)) {
        leases.delete(lease.port);
        gone.push(lease);
        log(`[runtime-port] reconcile: pid=${lease.pid} port=${lease.port} 已不存在，釋放 lease。`);
        continue;
      }
      const proven = await canProveOwnership(lease);
      if (!proven) {
        unknown.push(lease);
        log(`[runtime-port] reconcile: pid=${lease.pid} port=${lease.port} 無法證明是 TaskFlow 自己建立的，保留不動。`);
        continue;
      }
      if (!stop) { unknown.push(lease); continue; }
      try { await stop(lease); } catch { /* 停不掉照實回報，不重試也不升級手段 */ }
      const exited = await wait(lease.pid, {alive});
      if (exited) {
        leases.delete(lease.port);
        reconciled.push(lease);
        log(`[runtime-port] reconcile: 已終止孤兒 pid=${lease.pid}，釋放 port ${lease.port}。`);
      } else {
        unknown.push({...lease, reason: `已要求停止，但 PID ${lease.pid} 仍然存在。`});
      }
    }
    persist();
    return {gone, reconciled, unknown};
  }

  return {acquire, bindPid, release, isReserved, isAvailable, listLeases, reconcile};
}
