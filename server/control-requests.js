// 由網頁核准的系統層操作（目前只有一種：重新啟動正式 TaskFlow）。
//
// 為什麼不是主 server 自己重啟自己：重啟會殺掉正在執行這段程式的行程，
// 沒有人能把結果寫回去，也沒有人能在失敗時把舊服務救回來。所以這裡只負責
// 「把請求寫進資料庫」，真正動手的是既有的獨立守護程式（server/service-guardian.js，
// 佔用 4311、每 5 秒一個 tick），它跑的也是既有那支經過身分驗證的
// scripts/Recover-TaskFlow.ps1——不新寫第二套重啟邏輯。
//
// 通道用的是主 server 與守護程式本來就共用的那個 SQLite（WAL、busy_timeout=5000），
// 不另外發明 JSON 檔案協定：檔案鎖、半截寫入、孤兒請求這些問題 SQLite 已經解掉了。
//
// 三個不可妥協的原則：
//   1. 請求裡沒有任何指令字串。action 是固定的列舉，由守護程式對應到寫死的行為。
//   2. 重試次數存在資料庫（attempts 欄位）。放在記憶體的計數器在重啟後一定歸零，
//      等於沒有上限，會變成無限重啟迴圈。
//   3. 「其他 AI 工作正在執行」不算失敗，是延後：不消耗重試次數，但有總時限，
//      不會無聲無息地等到天荒地老。
import {id} from './db.js';

export const RESTART_ACTION = 'restart_taskflow';
export const MAX_RESTART_ATTEMPTS = 2;
// 守護程式每 5 秒寫一次 guardianLastSuccess；超過這個時間沒寫，就當它沒在跑。
export const GUARDIAN_STALE_MS = 60000;
// 一直被延後（例如有別的任務在跑 AI）也不能無限等下去。
export const RESTART_DEADLINE_MS = 30 * 60000;
// 守護程式自己掛掉時，claim 了卻永遠不會完成的請求。
export const RESTART_STUCK_MS = 15 * 60000;

const POSTPONED = /Active AI work found/i;

export function initControlRequests(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS control_requests(
    id TEXT PRIMARY KEY,
    task_id TEXT,
    action TEXT NOT NULL,
    expected_commit TEXT,
    requested_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    started INTEGER,
    finished INTEGER,
    note TEXT,
    result TEXT,
    error TEXT);
    CREATE INDEX IF NOT EXISTS idx_control_requests_pending ON control_requests(status,created);
    CREATE INDEX IF NOT EXISTS idx_control_requests_task ON control_requests(task_id,created);`);
  return db;
}

const parse = row => row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null;
// 每個結束路徑都重新讀一次：回傳更新前的舊資料列，呼叫端記錄下來的狀態與原因就會是錯的。
const reload = (store, requestId) => parse(store.db.prepare('SELECT * FROM control_requests WHERE id=?').get(requestId));

/**
 * 這個專案是不是 TaskFlow 自己。只有自己被修改時，重新啟動正式服務才有意義；
 * 其他專案的任務不該看到這個按鈕。路徑比對與 git-workspace.js 的 samePath 同一套規則。
 */
export function isSelfProject(projectPath, taskflowRoot) {
  const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const [x, y] = [normalize(projectPath), normalize(taskflowRoot)];
  if (!x || !y) return false;
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 守護程式現在是不是活著。它每個 tick 都會寫 guardianLastSuccess。 */
export function guardianAlive(store, { clock = Date.now, staleMs = GUARDIAN_STALE_MS } = {}) {
  const last = store.setting('guardianLastSuccess');
  const at = last ? Date.parse(last) : NaN;
  return Number.isFinite(at) && clock() - at < staleMs;
}

/**
 * 這個任務現在可不可以要求重新啟動；不行的話回傳原因（由 API 層轉成 HTTP 409）。
 * 刻意不在這裡丟 HttpError：這個模組要能不依賴整個 server 相依圖被測試。
 */
export function restartBlockReason(store, task, { taskflowRoot, projectPath, clock = Date.now } = {}) {
  if (!isSelfProject(projectPath, taskflowRoot)) {
    return { code: 'not_self_project', message: '這個任務不是 TaskFlow 自己的專案；重新啟動正式 TaskFlow 對它沒有意義。' };
  }
  if (!task?.gitMerge) {
    return { code: 'not_merged', message: '尚未合併到正式分支；重新啟動不會讓這次的修改生效，請先完成合併。' };
  }
  if (!guardianAlive(store, { clock })) {
    return { code: 'guardian_offline', message: '找不到正在執行的 TaskFlow 守護程式（Service Guardian），無法從網頁重新啟動。請先在電腦上啟動它（Start-Service-Guardian.ps1）。' };
  }
  const latest = latestRestart(store, task.id);
  if (latest && ['pending', 'running'].includes(latest.status)) {
    return { code: 'already_requested', message: '已經有一個重新啟動請求在進行中。' };
  }
  return null;
}

/** 建立一筆重啟請求。不接受任何指令字串，只有固定的 action。 */
export function requestRestart(store, { taskId = null, userId = null, expectedCommit = null, clock = Date.now } = {}) {
  initControlRequests(store.db);
  const requestId = id();
  store.db.prepare('INSERT INTO control_requests(id,task_id,action,expected_commit,requested_by,status,created) VALUES (?,?,?,?,?,?,?)')
    .run(requestId, taskId, RESTART_ACTION, expectedCommit, userId, 'pending', clock());
  return reload(store, requestId);
}

export function latestRestart(store, taskId) {
  initControlRequests(store.db);
  return parse(store.db.prepare('SELECT * FROM control_requests WHERE task_id=? AND action=? ORDER BY created DESC LIMIT 1').get(taskId, RESTART_ACTION));
}

/**
 * 守護程式掛掉時留下的孤兒：claim 了卻永遠不會完成。讀取端每次都跑一次，
 * 才不會讓畫面永遠停在「重新啟動中」。
 */
export function recoverStuckRestarts(store, { clock = Date.now, stuckMs = RESTART_STUCK_MS } = {}) {
  initControlRequests(store.db);
  const cutoff = clock() - stuckMs;
  return store.db.prepare("UPDATE control_requests SET status='failed',finished=?,error=? WHERE status='running' AND started<?")
    .run(clock(), '重新啟動沒有在預期時間內回報結果；守護程式可能已經停止。服務目前的狀態請直接查看網頁是否可用。', cutoff).changes;
}

/**
 * 守護程式每個 tick 呼叫一次：取一筆待處理的請求並執行。
 * restart() 由呼叫端注入（實際上是 server/service-recovery.js 的 runServiceRecovery）。
 */
export async function handleControlRequests(store, { restart, clock = Date.now, onError = () => {} } = {}) {
  initControlRequests(store.db);
  const row = parse(store.db.prepare("SELECT * FROM control_requests WHERE status='pending' ORDER BY created LIMIT 1").get());
  if (!row) return null;

  if (clock() - row.created > RESTART_DEADLINE_MS) {
    store.db.prepare("UPDATE control_requests SET status='failed',finished=?,error=? WHERE id=?")
      .run(clock(), '等待太久仍無法重新啟動（可能一直有 AI 工作在執行），已停止等待。', row.id);
    return reload(store, row.id);
  }
  if (row.attempts >= MAX_RESTART_ATTEMPTS) {
    store.db.prepare("UPDATE control_requests SET status='failed',finished=?,error=? WHERE id=?")
      .run(clock(), `重新啟動已重試 ${row.attempts} 次仍未成功，已停止重試以避免無限重啟。`, row.id);
    return reload(store, row.id);
  }

  store.db.prepare("UPDATE control_requests SET status='running',started=?,attempts=attempts+1,note=NULL WHERE id=?").run(clock(), row.id);
  try {
    const result = await restart({ expectedCommit: row.expected_commit });
    store.db.prepare("UPDATE control_requests SET status='success',finished=?,result=?,error=NULL WHERE id=?")
      .run(clock(), JSON.stringify(result || {}), row.id);
  } catch (error) {
    const message = String(error?.stderr || error?.message || error || '').slice(0, 1000);
    if (POSTPONED.test(message)) {
      // 有 AI 工作正在執行不是失敗：退回待處理、把剛才加上去的重試次數還回來，下一個 tick 再試。
      store.db.prepare("UPDATE control_requests SET status='pending',started=NULL,attempts=attempts-1,note=? WHERE id=?")
        .run('目前仍有 AI 工作在執行，重新啟動已延後，稍後會自動再試。', row.id);
    } else {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_RESTART_ATTEMPTS;
      store.db.prepare(`UPDATE control_requests SET status=?,finished=?,error=?,started=NULL WHERE id=?`)
        .run(exhausted ? 'failed' : 'pending', exhausted ? clock() : null, message, row.id);
      onError(error);
    }
  }
  return reload(store, row.id);
}

/** 送到瀏覽器的形狀：沒有磁碟路徑、沒有內部欄位名稱。 */
export function restartView(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    active: ['pending', 'running'].includes(row.status),
    attempts: row.attempts,
    maxAttempts: MAX_RESTART_ATTEMPTS,
    expectedCommit: row.expected_commit || null,
    requestedAt: row.created ? new Date(row.created).toISOString() : null,
    finishedAt: row.finished ? new Date(row.finished).toISOString() : null,
    note: row.note || null,
    url: row.result?.url || null,
    error: row.error || null,
  };
}
