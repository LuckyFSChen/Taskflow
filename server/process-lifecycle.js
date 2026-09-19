// Preview 子程序的生命週期驗證。
//
// 目前的問題很具體：running 這張表只存在主 server 的記憶體裡（server/project-preview.js），
// 服務一重新啟動就整個消失，之前開的 Preview 子程序變成沒有人管的孤兒，
// 繼續佔著連接埠與暫存 DB。而 killTree() 是射後不理，停止之後也沒有人確認 PID 真的消失。
//
// 兩個不可妥協的原則：
//   1. 「停止了」必須是**驗證過**的結論，不是「送出了終止指令」。PID 還在就不算停止，
//      Browser Validation 也不得判定通過。
//   2. 絕不因為「PID 還活著」就動手殺它。PID 會被作業系統重複使用，殺錯就是殺掉
//      使用者自己的程式。只有同時滿足「PID 還在」與「那個網址仍然回應得出 Preview 的
//      健康檢查」才認定是我們自己留下的孤兒；認不出來的一律保留並照實回報。
import {execFile} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

/**
 * 這個 PID 現在是否存在。送出訊號 0 不會影響目標程序，只做存在性檢查。
 * EPERM 代表「存在但我們沒有權限」——那仍然是存在，絕不能當成已結束。
 */
export function isAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/** 等待某個 PID 真的從系統上消失。逾時就回傳 false，不假裝它已經停了。 */
export async function waitForExit(pid, { timeoutMs = 10000, pollMs = 100, alive = isAlive, clock = Date.now } = {}) {
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return !alive(pid);
}

/**
 * 用 PID 停止一個程序。runner.js 的 killTree() 需要 ChildProcess 物件，但服務重新啟動之後
 * 我們手上只剩下 PID（那些程序已經不是這個行程的小孩了），所以需要這一個。
 * Windows 用 taskkill /T 連同子孫一起停；其他平台送 SIGTERM。
 */
export function stopPid(pid, { exec = execFile, platform = process.platform } = {}) {
  if (!isAlive(pid)) return false;
  if (platform === 'win32') exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(pid, 'SIGTERM'); } catch { return false; } }
  return true;
}

// --- Preview 登錄檔 ----------------------------------------------------------
// 記憶體那張表的持久化版本，只為了「服務重啟後還認得出自己開過哪些 Preview」。

export function readRegistry(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(entry => entry && Number.isInteger(entry.pid)) : [];
  } catch { return []; }
}

export function writeRegistry(path, entries) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entries, null, 1));
    return true;
  } catch { return false; }
}

export function registerPreview(path, entry) {
  const entries = readRegistry(path).filter(item => item.key !== entry.key && item.pid !== entry.pid);
  entries.push({ ...entry, startedAt: entry.startedAt || new Date().toISOString() });
  writeRegistry(path, entries);
  return entries;
}

export function unregisterPreview(path, key) {
  const entries = readRegistry(path).filter(item => item.key !== key);
  writeRegistry(path, entries);
  return entries;
}

/**
 * 判斷一筆登錄是不是「我們自己留下的、還活著的 Preview」。
 *
 * 只有 PID 還在**而且**那個網址仍回應得出 Preview 的健康檢查，才算認得出來。
 * PID 還在但網址不回應 → 極可能是 PID 被重複使用，回報 unknown，絕不殺。
 */
export async function inspectEntry(entry, { alive = isAlive, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  if (!alive(entry.pid)) return { ...entry, state: 'gone' };
  if (!entry.url) return { ...entry, state: 'unknown', reason: '沒有記錄網址，無法確認這個 PID 是不是 TaskFlow 開的 Preview。' };
  try {
    const response = await fetchImpl(`${entry.url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 200) return { ...entry, state: 'orphan' };
    return { ...entry, state: 'unknown', reason: `${entry.url}/api/health 回傳 HTTP ${response.status}，無法確認身分。` };
  } catch (error) {
    return { ...entry, state: 'unknown', reason: `${entry.url} 沒有回應（${String(error?.message || error).slice(0, 120)}），無法確認這個 PID 的身分。` };
  }
}

/**
 * 服務啟動時對帳：已結束的登錄直接清掉；認得出來的孤兒才停止；認不出來的保留並回報。
 * stop() 由呼叫端注入（實際上是 runner.js 的 killTree），這個模組不自己決定怎麼殺。
 */
export async function reconcilePreviewRegistry(path, { stop, alive = isAlive, fetchImpl = fetch, wait = waitForExit } = {}) {
  const inspected = [];
  for (const entry of readRegistry(path)) inspected.push(await inspectEntry(entry, { alive, fetchImpl }));

  const stopped = [], unknown = [], gone = inspected.filter(entry => entry.state === 'gone');
  for (const entry of inspected.filter(item => item.state === 'orphan')) {
    try { await stop?.(entry); } catch { /* 停不掉就照實回報，不重試也不升級手段 */ }
    const exited = await wait(entry.pid, { alive });
    (exited ? stopped : unknown).push(exited ? entry : { ...entry, reason: `已要求停止，但 PID ${entry.pid} 仍然存在。` });
  }
  unknown.push(...inspected.filter(entry => entry.state === 'unknown'));

  // 只有確定已結束的才從登錄檔移除；還在的留著，下次啟動才有機會再處理。
  writeRegistry(path, unknown.map(({ state, reason, ...entry }) => entry));
  return { stopped, unknown, removed: gone.length };
}
