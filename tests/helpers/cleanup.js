// 測試資源的生命週期與清理。
//
// 解決的問題很具體：同一個測試裡註冊兩個 t.after——先註冊刪目錄、後註冊關資料庫——
// node:test 是**依註冊順序**執行 after hook，所以刪目錄會發生在 SQLite 連線還開著的時候。
// POSIX 允許刪除仍被開啟的檔案，所以在 Linux 上看不出問題；Windows 不允許，於是
// rmSync 直接 EPERM。那不是「Windows 比較嚴格」，是測試真的還沒把 handle 關掉。
//
// 三個不可妥協的原則：
//   1. 一個測試只註冊一個 after hook：先關資源（LIFO），再刪目錄。順序由這裡保證，
//      不由呼叫端的註冊順序決定。
//   2. 清理失敗必須讓測試失敗。不 catch-and-ignore、不 force:true、不永久跳過。
//   3. 重試只針對「已經關閉、但作業系統還沒釋放 handle」這種短暫競態，而且有上限；
//      次數用完仍失敗就照實拋出原始錯誤。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 這些錯誤碼在 Windows 上代表「檔案系統還沒放手」：防毒／索引服務短暫開啟、
// 子程序剛結束但 handle 尚未回收、或目錄裡還有剛被關閉的 -wal／-shm。
// 只有這幾種才重試；EISDIR、ENOTDIR 這類代表程式寫錯，一律立刻拋出。
const RELEASE_RACE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * 刪除目錄，對「handle 釋放競態」做有上限的重試。
 * 目標狀態是「這個路徑不存在」，所以 ENOENT 視為成功；其餘錯誤在重試次數用完後原樣拋出。
 */
export async function removeDirectory(path, { attempts = 5, delayMs = 100, rm = rmSync } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { rm(path, { recursive: true }); return attempt; }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      if (!RELEASE_RACE_CODES.has(error?.code) || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * 一個測試一份清理清單。
 *
 * @example
 * const cleanup = testCleanup(t);
 * const dir = cleanup.tempDir('tf-example-');
 * const store = cleanup.dispose(createStore(join(dir, 'db.sqlite')), 'store');
 * // 測試結束時：先 store.close()，再刪 dir。
 */
export function testCleanup(t) {
  const disposers = [], directories = [];

  t.after(async () => {
    const failures = [];
    // 先關資源：後開的先關（LIFO），因為後開的通常依賴先開的。
    for (const { label, dispose } of [...disposers].reverse()) {
      try { await dispose(); }
      catch (error) { failures.push(new Error(`關閉 ${label} 失敗：${String(error?.message || error)}`, { cause: error })); }
    }
    // 資源都關掉之後才刪目錄。這個順序就是這個 helper 存在的理由。
    for (const directory of [...directories].reverse()) {
      try { await removeDirectory(directory); }
      catch (error) { failures.push(new Error(`刪除 ${directory} 失敗（${error?.code || 'unknown'}）：${String(error?.message || error)}`, { cause: error })); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, '測試清理未完成');
  });

  return {
    /** 登記一個要關閉的資源：function、或具備 close()／stop() 的物件。回傳原物件方便串接。 */
    dispose(resource, label = 'resource') {
      const close = typeof resource === 'function' ? resource
        : typeof resource?.close === 'function' ? () => resource.close()
        : typeof resource?.stop === 'function' ? () => resource.stop()
        : null;
      if (!close) throw new TypeError(`dispose() 需要 function，或具備 close()／stop() 的物件：${label}`);
      disposers.push({ label, dispose: close });
      return resource;
    },
    /** 登記一個要在資源關閉之後刪除的目錄（可以是還不存在的路徑）。 */
    directory(path) { directories.push(path); return path; },
    /** 建立暫存目錄並登記刪除。 */
    tempDir(prefix) { return this.directory(mkdtempSync(join(tmpdir(), prefix))); },
  };
}
