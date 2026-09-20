// 共用的 npm 執行器。
//
// 目前由 Completion 的測試比對（server/test-baseline.js）使用。Preview 的建置
// （server/project-preview.js 的 runNpm）維持原樣不動：它的語意是「建置失敗就丟 HttpError」，
// 與這裡「完整保留輸出交給呼叫端判讀」不同，而且改動它會牽動既有的 Preview 測試。
// 下次要動 Preview 那段時，npm-cli 的定位與秘密剝除應該收斂到這裡，不要再長出第三份。
//
// 三個原則：
//   1. 永遠不經過 shell（shell:false）：專案路徑或參數裡的字元不可能被當成指令解讀。
//   2. 秘密不外流：金鑰與 LINE token 一律從子程序環境中移除。
//   3. 指令是寫死的參數陣列，不接受呼叫端傳入整串命令字串。
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {killTree} from './runner.js';
import {withoutInfrastructurePorts} from './ports.js';

// 這些變數只屬於 TaskFlow 本體；專案的建置或測試沒有任何理由需要它們。
export const SENSITIVE_ENV_KEYS = [
  'INBOX_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY',
];

/**
 * 找出與目前 node 同一份安裝的 npm-cli.js。
 * 刻意不呼叫 `npm`／`npm.cmd`：那會經過 PATH 與 shell，Windows 上還可能命中別的版本。
 * @returns {string|null} 找不到時回傳 null，由呼叫端決定要丟什麼錯誤
 */
export function resolveNpmCli(execPath = process.execPath) {
  // Windows 的安裝把 npm 放在 node.exe 旁邊；POSIX 慣例（Linux／macOS／WSL、Docker 映像）
  // 則是 <prefix>/bin/node 搭配 <prefix>/lib/node_modules/npm。只認第一種的話，TaskFlow 在
  // 非 Windows 環境一律回報「找不到 npm」——那不是使用者的環境壞了，是這裡少找一個位置。
  const candidates = [
    join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dirname(execPath), '../libexec/lib/node_modules/npm/bin/npm-cli.js'),
  ];
  return candidates.find(existsSync) || null;
}

/**
 * 子程序環境：複製目前環境後移除秘密，並移除主服務的 port 身分。
 *
 * 後者同樣重要：主服務的 PORT=4310 若原封不動傳給任務專案的 backend，那個 backend 會
 * 試著綁 4310（實際發生過）；反過來，runtime 的 PORT 若回流到主服務，主服務就會跑到
 * 隨機 port。每一個子程序自己的 port 一律由呼叫端明確設定。
 */
export function childEnvironment(env = process.env, extra = {}) {
  const copy = { ...withoutInfrastructurePorts(env), ...extra };
  for (const key of SENSITIVE_ENV_KEYS) delete copy[key];
  return copy;
}

/**
 * 執行一次 npm 指令並完整保留輸出。
 *
 * 與 Preview 既有的建置執行器不同的地方，是這裡「不丟棄輸出」：測試結果要拿來解析，
 * 只留最後幾千個字元會讓 TAP 摘要與失敗清單對不起來，那正是這次要消滅的猜測。
 *
 * @param {object} options
 * @param {string} options.cwd 執行目錄
 * @param {string[]} options.args 傳給 npm 的參數（例如 ['test']）
 * @param {number} [options.timeoutMs] 逾時；逾時會 killTree 並回報 timedOut
 * @param {string|null} [options.logPath] 完整輸出要寫到哪個檔案
 * @param {number} [options.maxBytes] 記憶體中保留的輸出上限；超過就標記 truncated
 * @returns {Promise<{exitCode:number|null,timedOut:boolean,truncated:boolean,output:string,logPath:string|null,durationMs:number}>}
 */
export function runNpmCommand({
  cwd, args, timeoutMs = 15 * 60000, logPath = null,
  maxBytes = 32 * 1024 * 1024, spawnProcess = spawn, env = process.env, execPath = process.execPath,
}) {
  const cli = resolveNpmCli(execPath);
  if (!cli) return Promise.reject(new Error('找不到 npm，請安裝包含 npm 的 Node.js。'));

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawnProcess(execPath, [cli, ...args], {
      cwd, env: childEnvironment(env), shell: false, windowsHide: true,
    });
    let output = '', size = 0, truncated = false, timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', data => {
        size += data.length;
        if (size > maxBytes) { truncated = true; return; }
        output += data;
      });
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (logPath) {
        // 紀錄寫不進去不該讓整次執行失敗：輸出本身已經在記憶體裡，解析照常進行。
        try { mkdirSync(dirname(logPath), { recursive: true }); writeFileSync(logPath, output); }
        catch { /* 保留執行結果，紀錄檔可有可無 */ }
      }
      if (error) reject(error); else resolve(value);
    };
    child.on('error', error => finish(error));
    child.on('close', exitCode => finish(null, {
      exitCode, timedOut, truncated, output, logPath, durationMs: Date.now() - started,
    }));
  });
}
