// 測試基準（Test Baseline）比對。
//
// 要解決的問題很具體：目前 TaskFlow 只會看到「344 tests / 341 pass / 3 fail」，
// 然後由 AI 用自然語言宣稱「那 3 個是既有問題」。這種判斷沒有任何可稽核的依據。
//
// 這裡改成可以驗證的做法：同一套測試在 main 跑一次（baseline）、在任務分支跑一次（current），
// 比對**失敗項目的身分**，只有沒有新增失敗才算沒有 regression。
//
// 三個刻意的選擇：
//   1. 只信結構化輸出。`node --test` 在 stdout 不是 TTY 時輸出 TAP 13，我們用 pipe 執行，
//      所以不必改 npm script 也不必傳 reporter 參數。第一行不是 TAP 就判 parse_failed，
//      不猜、不用正則硬撈數字。
//   2. 解析出的失敗數量必須與 TAP 自己的 `# fail` 相符，否則同樣判 parse_failed。
//      「讀不懂」永遠不可以被當成「沒有新失敗」——這與 inspectRepository() 對 git status
//      失敗的處理原則一致：讀不到就照實說，絕不假設一切正常。
//   3. 失敗項目的識別碼是「相對檔案路徑 + 測試名稱」，不是 TAP 的序號，也不含行號：
//      序號會因新增測試整排位移，行號會因改動位移，兩者都會把既有失敗誤判成新 regression。
//
// 這個模組刻意不 import 任何執行器：npm 怎麼跑由呼叫端注入（server/completion-test.js
// 傳入 server/npm-runner.js 的 runNpmCommand）。解析與判定因此可以單獨測試，
// 不必拉起整個 server 相依圖。

const TAP_HEADER = 'TAP version 13';

export const VERDICTS = {
  NO_REGRESSION: 'no_regression',
  REGRESSION: 'regression',
  BASELINE_UNAVAILABLE: 'baseline_unavailable',
  PARSE_FAILED: 'parse_failed',
};

export const PARSE_REASONS = {
  not_tap: '測試輸出不是 TAP 格式，無法結構化判讀。',
  truncated: '測試輸出超過上限而被截斷，無法完整判讀。',
  summary_mismatch: '解析出的測試數量與 TAP 摘要不符，無法確定失敗清單是否完整。',
  no_summary: '測試輸出缺少 TAP 摘要（# tests／# pass／# fail）。',
};

const normalizeSeparators = path => String(path || '').replace(/\\/g, '/');

/**
 * 把 TAP 的 location（絕對路徑:行:欄）轉成相對於專案根目錄的檔案路徑。
 * 行號與欄號一律丟掉：它們會隨程式碼改動位移，放進識別碼就會製造假的 regression。
 */
export function relativeTestFile(location, root) {
  const raw = normalizeSeparators(location).replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
  if (!raw) return '';
  const base = normalizeSeparators(root).replace(/\/+$/, '');
  if (!base) return raw;
  // Windows 路徑大小寫不敏感；比對前先轉小寫，但回傳仍用原本的大小寫。
  const lowered = raw.toLowerCase(), loweredBase = base.toLowerCase();
  if (lowered.startsWith(`${loweredBase}/`)) return raw.slice(base.length + 1);
  return raw;
}

/** 失敗項目的識別碼：跨 commit、跨工作目錄都要能認出「同一個測試」。 */
export function testKey(name, file) {
  return file ? `${file} > ${name}` : String(name || '');
}

/**
 * 解析 `npm test` 的完整輸出。
 *
 * 巢狀 subtest 很重要：`node --test` 的 `# tests`／`# fail` 會把巢狀項目一起算進去
 * （實測：4 個頂層測試 + 2 個 subtest = `# tests 8`），所以解析也必須逐層收集，
 * 否則交叉驗證會永遠對不起來、把每一次執行都判成 parse_failed。
 *
 * 巢狀項目的識別碼帶上父層名稱（`檔案 > 父測試 > 子測試`），父測試因子測試失敗而失敗時
 * 兩者都會出現在清單裡——這在兩次執行之間是一致的，所以不影響比對。
 *
 * @param {string} output 完整 stdout+stderr
 * @param {object} [options]
 * @param {string} [options.root] 專案根目錄，用來把絕對路徑轉成相對路徑
 * @param {boolean} [options.truncated] 輸出是否已被截斷
 */
export function parseTapOutput(output, { root = '', truncated = false } = {}) {
  const empty = { ok: false, total: 0, passed: 0, failed: [], skipped: 0, summary: null };
  if (truncated) return { ...empty, reason: 'truncated' };

  const lines = String(output || '').split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.trim() === TAP_HEADER);
  if (headerIndex < 0) return { ...empty, reason: 'not_tap' };

  const raw = [];
  const summary = {};
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    const summaryMatch = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/.exec(line);
    if (summaryMatch) { summary[summaryMatch[1]] = Number(summaryMatch[2]); continue; }

    const match = /^(\s*)(not ok|ok) (\d+) - (.*)$/.exec(line);
    if (!match) continue;
    const [, indent, status, , rest] = match;
    const level = Math.floor(indent.length / 4);
    // 指令（# SKIP／# TODO）不屬於測試名稱的一部分。
    const directive = /\s+#\s+(SKIP|TODO)\b/i.exec(rest);
    const name = (directive ? rest.slice(0, directive.index) : rest).trim();

    // 這一層項目的 YAML 區塊縮排固定是「項目縮排 + 2」；只讀這一層，不要撿到子層的 location。
    let file = '';
    const pad = ' '.repeat(indent.length + 2);
    if (lines[i + 1] === `${pad}---`) {
      for (let j = i + 2; j < lines.length; j++) {
        if (lines[j] === `${pad}...`) break;
        const location = new RegExp(`^${pad}location: '(.+)'\\s*$`).exec(lines[j]);
        if (location) { file = relativeTestFile(location[1], root); break; }
      }
    }
    raw.push({ level, name, file, passed: status === 'ok', skipped: !!directive && /SKIP/i.test(directive[1]) });
  }

  // 父子關係要反著解：TAP 會先輸出所有子測試，最後才輸出父測試那一行。
  // 從後往前掃，看到某一層的項目時，它的父項目一定已經先被看過了。
  // 檔案也在這時候繼承：子測試通過時沒有自己的 location，只能沿用父測試的檔案。
  const openByLevel = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const entry = raw[i];
    const parent = entry.level > 0 ? openByLevel[entry.level - 1] : null;
    entry.file = entry.file || parent?.file || '';
    entry.namePath = parent ? [...parent.namePath, entry.name] : [entry.name];
    entry.key = testKey(entry.namePath.join(' > '), entry.file);
    openByLevel[entry.level] = entry;
    openByLevel.length = entry.level + 1;
  }
  const entries = raw;

  if (!Number.isInteger(summary.tests) || !Number.isInteger(summary.fail)) {
    return { ...empty, reason: 'no_summary' };
  }
  const failed = entries.filter(entry => !entry.passed);
  // 交叉驗證：解析結果必須和 TAP 自己的統計一致，不一致就不能用。
  if (entries.length !== summary.tests || failed.length !== summary.fail) {
    return { ...empty, reason: 'summary_mismatch', summary };
  }
  return {
    ok: true,
    reason: null,
    total: summary.tests,
    passed: Number.isInteger(summary.pass) ? summary.pass : entries.length - failed.length,
    skipped: Number.isInteger(summary.skipped) ? summary.skipped : entries.filter(e => e.skipped).length,
    failed: failed.map(entry => entry.key),
    failedDetail: failed.map(entry => ({ name: entry.name, file: entry.file, key: entry.key })),
    summary,
  };
}

/**
 * 在一個工作目錄執行一次完整測試並解析結果。
 * 失敗、逾時、解析不了都照實回報；不會因為 exit code 非 0 就假設「測試有跑但有幾個失敗」。
 */
export async function runTestSuite({ cwd, logPath = null, timeoutMs, run, commit = null, label = '' }) {
  if (typeof run !== 'function') throw new Error('runTestSuite 需要注入 npm 執行器');
  const outcome = await run({ cwd, args: ['test'], logPath, ...(timeoutMs ? { timeoutMs } : {}) });
  const parsed = parseTapOutput(outcome.output, { root: cwd, truncated: outcome.truncated });
  return {
    label,
    commit,
    at: new Date().toISOString(),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    logPath: outcome.logPath || null,
    ...parsed,
    // 逾時的結果即使解析得出來也不能採用：被中斷的那一段測試從來沒有跑完。
    ...(outcome.timedOut ? { ok: false, reason: 'timed_out' } : {}),
  };
}

/**
 * 比對兩次執行。回傳 verdict 與逐項差異。
 * 只有 no_regression 代表「這條分支沒有製造出新的測試失敗」。
 *
 * 四個欄位對應需求裡的四種分類：
 *   - existingFailures：baseline 本來就有的失敗（不論這次有沒有修好）。
 *   - newFailures：只在 current 出現、baseline 沒有的失敗——唯一會判定 regression 的依據。
 *   - resolvedFailures：baseline 有、這次不再出現的失敗（即需求所稱 fixedFailures）。
 *   - unchangedFailures：baseline 與 current 都有的失敗，即既有失敗中「這次仍未修復」的子集。
 */
export function compareTestRuns(baseline, current) {
  const baseFailed = new Set(baseline?.ok ? baseline.failed : []);
  const currentFailed = new Set(current?.ok ? current.failed : []);
  const existingFailures = [...baseFailed];
  const newFailures = [...currentFailed].filter(key => !baseFailed.has(key));
  const resolvedFailures = [...baseFailed].filter(key => !currentFailed.has(key));
  const unchangedFailures = [...baseFailed].filter(key => currentFailed.has(key));

  const verdict = !current?.ok ? VERDICTS.PARSE_FAILED
    : !baseline?.ok ? VERDICTS.BASELINE_UNAVAILABLE
      : newFailures.length ? VERDICTS.REGRESSION
        : VERDICTS.NO_REGRESSION;

  return { verdict, existingFailures, newFailures, resolvedFailures, unchangedFailures };
}
