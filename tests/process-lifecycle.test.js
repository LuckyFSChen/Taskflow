import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  inspectEntry,
  isAlive,
  readRegistry,
  reconcilePreviewRegistry,
  registerPreview,
  stopPid,
  unregisterPreview,
  waitForExit,
  writeRegistry,
} from '../server/process-lifecycle.js';

const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'tf-lifecycle-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

// 一個真的會活著、直到被殺掉為止的子程序。
function longRunningChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已結束 */ } });
  return child;
}

test('isAlive 認得出真的活著的程序與已經結束的程序', async t => {
  const child = longRunningChild(t);
  assert.equal(isAlive(child.pid), true);

  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(isAlive(child.pid), false);
});

test('isAlive 對無效的 PID 一律回 false，不會丟例外', () => {
  for (const value of [null, undefined, 0, -1, 'abc', NaN, 1.5]) assert.equal(isAlive(value), false);
});

test('waitForExit 等到 PID 真的消失才回 true', async t => {
  const child = longRunningChild(t);
  setTimeout(() => child.kill('SIGKILL'), 50);
  assert.equal(await waitForExit(child.pid, { timeoutMs: 5000, pollMs: 20 }), true);
});

test('waitForExit 逾時回傳 false，絕不假裝已經停止', async t => {
  const child = longRunningChild(t);
  assert.equal(await waitForExit(child.pid, { timeoutMs: 150, pollMs: 20 }), false);
});

test('登錄檔：寫入、讀回、依 key 移除；壞掉的檔案當成空的而不是炸掉', t => {
  const path = join(tempDir(t), 'registry.json');
  assert.deepEqual(readRegistry(path), []);

  registerPreview(path, { key: 'p:1', pid: 111, url: 'http://127.0.0.1:1', kind: 'fullstack', cwd: '/x' });
  registerPreview(path, { key: 'p:2', pid: 222, url: 'http://127.0.0.1:2', kind: 'fullstack', cwd: '/y' });
  assert.deepEqual(readRegistry(path).map(e => e.key), ['p:1', 'p:2']);
  assert.ok(readRegistry(path)[0].startedAt);

  // 同一個 key 再註冊一次只會留最新的那筆
  registerPreview(path, { key: 'p:1', pid: 333, url: 'http://127.0.0.1:3' });
  assert.deepEqual(readRegistry(path).map(e => e.pid), [222, 333]);

  unregisterPreview(path, 'p:2');
  assert.deepEqual(readRegistry(path).map(e => e.key), ['p:1']);

  writeFileSync(path, 'not json at all');
  assert.deepEqual(readRegistry(path), []);
  assert.equal(writeRegistry(join(tempDir(t), 'nested/deep/registry.json'), []), true);
});

test('PID 還在、網址也回應得出健康檢查，才認定是自己留下的孤兒', async () => {
  const entry = { key: 'p:1', pid: 111, url: 'http://127.0.0.1:61347' };
  const orphan = await inspectEntry(entry, { alive: () => true, fetchImpl: async () => ({ status: 200 }) });
  assert.equal(orphan.state, 'orphan');
});

test('PID 還在但網址不回應：可能是 PID 被重複使用，回報 unknown 而不是孤兒', async () => {
  const entry = { key: 'p:1', pid: 111, url: 'http://127.0.0.1:61347' };
  const refused = await inspectEntry(entry, { alive: () => true, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(refused.state, 'unknown');
  assert.match(refused.reason, /無法確認這個 PID 的身分/);

  const wrongStatus = await inspectEntry(entry, { alive: () => true, fetchImpl: async () => ({ status: 404 }) });
  assert.equal(wrongStatus.state, 'unknown');
  assert.match(wrongStatus.reason, /HTTP 404/);

  const noUrl = await inspectEntry({ key: 'p:1', pid: 111 }, { alive: () => true });
  assert.equal(noUrl.state, 'unknown');
});

test('PID 已經不在就是 gone，不需要任何網路確認', async () => {
  let fetched = 0;
  const entry = await inspectEntry({ key: 'p:1', pid: 111, url: 'http://127.0.0.1:1' }, { alive: () => false, fetchImpl: async () => { fetched++; return { status: 200 }; } });
  assert.equal(entry.state, 'gone');
  assert.equal(fetched, 0);
});

test('開機對帳：只停掉認得出來的孤兒，認不出來的一律保留不動', async t => {
  const path = join(tempDir(t), 'registry.json');
  writeRegistry(path, [
    { key: 'dead', pid: 1, url: 'http://127.0.0.1:1' },     // 已結束
    { key: 'orphan', pid: 2, url: 'http://127.0.0.1:2' },   // 我們自己的殘留
    { key: 'stranger', pid: 3, url: 'http://127.0.0.1:3' }, // PID 被別人重複使用
  ]);

  const killed = [];
  const outcome = await reconcilePreviewRegistry(path, {
    alive: pid => pid !== 1,
    fetchImpl: async url => url.startsWith('http://127.0.0.1:2') ? { status: 200 } : (() => { throw new Error('ECONNREFUSED'); })(),
    stop: entry => { killed.push(entry.pid); },
    wait: async () => true,
  });

  assert.deepEqual(killed, [2]);
  assert.deepEqual(outcome.stopped.map(e => e.key), ['orphan']);
  assert.deepEqual(outcome.unknown.map(e => e.key), ['stranger']);
  assert.equal(outcome.removed, 1);
  // 停掉的與已結束的都清掉；認不出來的留著，下次開機再處理
  assert.deepEqual(readRegistry(path).map(e => e.key), ['stranger']);
});

test('要求停止之後 PID 仍然存在，不得當成已停止', async t => {
  const path = join(tempDir(t), 'registry.json');
  writeRegistry(path, [{ key: 'stubborn', pid: 9, url: 'http://127.0.0.1:9' }]);

  const outcome = await reconcilePreviewRegistry(path, {
    alive: () => true,
    fetchImpl: async () => ({ status: 200 }),
    stop: () => {},
    wait: async () => false,
  });

  assert.deepEqual(outcome.stopped, []);
  assert.equal(outcome.unknown.length, 1);
  assert.match(outcome.unknown[0].reason, /仍然存在/);
  assert.deepEqual(readRegistry(path).map(e => e.key), ['stubborn']);
});

test('對帳會真的殺掉一個真的子程序，並確認它真的消失了', async t => {
  const path = join(tempDir(t), 'registry.json');
  const child = longRunningChild(t);
  writeRegistry(path, [{ key: 'real', pid: child.pid, url: 'http://127.0.0.1:1' }]);

  const outcome = await reconcilePreviewRegistry(path, {
    fetchImpl: async () => ({ status: 200 }),          // 假裝健康檢查認得它
    stop: entry => process.kill(entry.pid, 'SIGKILL'), // 真的殺
  });

  assert.deepEqual(outcome.stopped.map(e => e.pid), [child.pid]);
  assert.equal(isAlive(child.pid), false);
  assert.deepEqual(readRegistry(path), []);
});

test('stopPid 用 PID 停掉一個真的程序；對已經結束的 PID 不做任何事', async t => {
  const child = longRunningChild(t);
  assert.equal(stopPid(child.pid), true);
  assert.equal(await waitForExit(child.pid, { timeoutMs: 5000, pollMs: 20 }), true);
  assert.equal(stopPid(child.pid), false);
  assert.equal(stopPid(undefined), false);
});

test('Windows 上走 taskkill /T，不對自己的行程送訊號', () => {
  const calls = [];
  const alive = 999999; // 不存在的 PID：確認 isAlive 擋在前面
  assert.equal(stopPid(alive, { platform: 'win32', exec: (...args) => calls.push(args) }), false);
  assert.equal(calls.length, 0);
});
