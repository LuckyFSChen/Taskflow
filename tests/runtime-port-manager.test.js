import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  RESERVED_PORTS,
  createRuntimePortManager,
  isReservedPort,
  resolvePortRange,
} from '../server/runtime-port-manager.js';

const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'tf-portpool-')); t.after(() => rmSync(dir, {recursive: true, force: true})); return dir; };

// 小範圍好測；還是要涵蓋 45000~45099 才符合 resolvePortRange 的保留範圍檢查。
const SMALL_RANGE = {start: 45000, end: 45004};
const silent = () => {};

test('isReservedPort：4310／4311 永遠是保留 port', () => {
  assert.equal(isReservedPort(4310), true);
  assert.equal(isReservedPort(4311), true);
  assert.equal(isReservedPort(45000), false);
  assert.deepEqual([...RESERVED_PORTS], [4310, 4311]);
});

test('resolvePortRange：預設涵蓋 45000~45099', () => {
  assert.deepEqual(resolvePortRange({env: {}}), {start: 45000, end: 45099});
});

test('resolvePortRange：範圍不合法、不是正整數，直接擋下', () => {
  assert.throws(() => resolvePortRange({env: {TASKFLOW_RUNTIME_PORT_START: 'abc'}}), /必須是合法的正整數/);
  assert.throws(() => resolvePortRange({env: {TASKFLOW_RUNTIME_PORT_START: '45050', TASKFLOW_RUNTIME_PORT_END: '45010'}}), /不得小於/);
});

test('resolvePortRange：範圍不涵蓋 45000~45099 保留範圍，直接擋下', () => {
  assert.throws(() => resolvePortRange({env: {TASKFLOW_RUNTIME_PORT_START: '45010', TASKFLOW_RUNTIME_PORT_END: '45099'}}), /必須涵蓋/);
  assert.throws(() => resolvePortRange({env: {TASKFLOW_RUNTIME_PORT_START: '45000', TASKFLOW_RUNTIME_PORT_END: '45050'}}), /必須涵蓋/);
});

test('resolvePortRange：範圍涵蓋保留 port 4310/4311，直接擋下', () => {
  assert.throws(() => resolvePortRange({env: {TASKFLOW_RUNTIME_PORT_START: '4000', TASKFLOW_RUNTIME_PORT_END: '45099'}}), /保留 port 4310/);
});

// Test 1 — pool boundaries：只能配到 range 內的 port。
test('Test 1: acquire() 只會配發 pool 範圍內的 port', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 't1', serviceId: 'backend'});
  assert.ok(port >= SMALL_RANGE.start && port <= SMALL_RANGE.end);
});

// Test 2 — reserved system ports：永遠不能配到 4310/4311。
test('Test 2: 即使把保留 port 塞進候選範圍也不會被配發（isAvailable 直接擋下）', async () => {
  const manager = createRuntimePortManager({range: {start: 4310, end: 4311}, checkPortInUse: async () => false, log: silent});
  assert.equal(await manager.isAvailable(4310), false);
  assert.equal(await manager.isAvailable(4311), false);
  await assert.rejects(manager.acquire({taskId: 't1', serviceId: 'backend'}), /pool exhausted/);
});

// Test 3 — unique lease：兩個 runtime 不會取得同一個 port。
test('Test 3: 連續 acquire 不會配到同一個 port，跨 task 也全域唯一', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const a = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  const b = await manager.acquire({taskId: 'A', serviceId: 'frontend'});
  const c = await manager.acquire({taskId: 'B', serviceId: 'backend'});
  assert.equal(new Set([a, b, c]).size, 3);
});

// Test 4 — busy port：外部程式已經在用，acquire 要跳過、不得殺它。
test('Test 4: 外部程式佔用的 port 會被跳過，不會被配發也不會被 kill', async () => {
  const busy = new Set([SMALL_RANGE.start, SMALL_RANGE.start + 1]);
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async port => busy.has(port), log: silent});
  // acquire() 的掃描起點是隨機的（降低多個獨立 TaskFlow 行程互撞的機率，見 runtime-port-manager.js
  // 的註解），所以這裡不能斷言配到「哪一個」空的 port，只能斷言絕對不會是被佔用的那兩個。
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  assert.ok(!busy.has(port), `不得配到外部程式已佔用的 port，實際配到 ${port}`);
  assert.ok(port >= SMALL_RANGE.start && port <= SMALL_RANGE.end);
  assert.equal(await manager.isAvailable(SMALL_RANGE.start), false);
});

test('listLeases()／release()：release 之後那個 port 立刻可以再被租出去', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  assert.equal(manager.listLeases().length, 1);
  assert.equal(manager.release(port), true);
  assert.equal(manager.listLeases().length, 0);
  assert.equal(manager.release(port), false);
  assert.equal(await manager.isAvailable(port), true);
});

test('bindPid()：綁定 pid 後狀態轉 active，port 沒有 lease 時不能綁定', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  const lease = manager.bindPid(port, 12345);
  assert.equal(lease.pid, 12345);
  assert.equal(lease.status, 'active');
  assert.equal(manager.listLeases()[0].pid, 12345);
  assert.throws(() => manager.bindPid(port + 1, 1), /沒有對應的 lease/);
});

test('lease 會持久化到磁碟，重新建立 manager 後讀得回來', async t => {
  const path = join(tempDir(t), 'port-leases.json');
  const manager = createRuntimePortManager({leasePath: path, range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  manager.bindPid(port, 999);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].port, port);

  const reloaded = createRuntimePortManager({leasePath: path, range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  assert.deepEqual(reloaded.listLeases().map(l => l.port), [port]);
});

// Test 11 — pool exhaustion：全滿時明確失敗並列出 active leases，不 fallback。
test('Test 11: pool 全滿時 acquire() 明確失敗並列出 active leases，不 fallback', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const total = SMALL_RANGE.end - SMALL_RANGE.start + 1;
  for (let i = 0; i < total; i++) await manager.acquire({taskId: `T${i}`, serviceId: 'backend'});
  assert.equal(manager.listLeases().length, total);
  await assert.rejects(
    manager.acquire({taskId: 'overflow', serviceId: 'backend'}),
    error => {
      assert.match(error.message, /pool exhausted/);
      assert.match(error.message, new RegExp(`0 / ${total}`));
      assert.match(error.message, /task=T0/);
      return true;
    },
  );
  // 絕不 fallback 到保留 port 或 pool 外的固定 port。
  assert.ok(!manager.listLeases().some(l => isReservedPort(l.port)));
});

// Test 12 — orphan recovery：能證明是自己的 orphan 才清理。
test('Test 12: reconcile() 只清理能證明 ownership 的 orphan', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  manager.bindPid(port, 42);
  const stopped = [];
  const outcome = await manager.reconcile({
    alive: () => true,
    canProveOwnership: async lease => lease.pid === 42,
    stop: lease => { stopped.push(lease.pid); },
    wait: async () => true,
  });
  assert.deepEqual(stopped, [42]);
  assert.equal(outcome.reconciled.length, 1);
  assert.equal(manager.listLeases().length, 0);
});

test('reconcile()：PID 已經不在，直接視為 gone 並釋放 lease，不需要證明身分', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  manager.bindPid(port, 42);
  let proveCalled = false;
  const outcome = await manager.reconcile({alive: () => false, canProveOwnership: async () => { proveCalled = true; return true; }});
  assert.equal(outcome.gone.length, 1);
  assert.equal(proveCalled, false);
  assert.equal(manager.listLeases().length, 0);
});

// Test 13 — unknown process safety：無法證明身分的一律保留，不得清理。
test('Test 13: 無法證明身分的 lease 一律保留，reconcile 不會動手', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  manager.bindPid(port, 42);
  const stop = () => { throw new Error('不應該被呼叫'); };
  const outcome = await manager.reconcile({alive: () => true, canProveOwnership: async () => false, stop});
  assert.equal(outcome.unknown.length, 1);
  assert.equal(outcome.reconciled.length, 0);
  assert.equal(manager.listLeases().length, 1);
});

test('reconcile()：停止之後 PID 仍然存在，保留 lease 並附上原因，不得當成已清理', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  const port = await manager.acquire({taskId: 'A', serviceId: 'backend'});
  manager.bindPid(port, 42);
  const outcome = await manager.reconcile({
    alive: () => true,
    canProveOwnership: async () => true,
    stop: () => {},
    wait: async () => false,
  });
  assert.equal(outcome.reconciled.length, 0);
  assert.match(outcome.unknown[0].reason, /仍然存在/);
  assert.equal(manager.listLeases().length, 1);
});

test('尚未綁定 pid（pending）的 lease，reconcile 不會處理', async () => {
  const manager = createRuntimePortManager({range: SMALL_RANGE, checkPortInUse: async () => false, log: silent});
  await manager.acquire({taskId: 'A', serviceId: 'backend'});
  const outcome = await manager.reconcile({alive: () => false});
  assert.equal(outcome.gone.length, 0);
  assert.equal(manager.listLeases().length, 1);
});
