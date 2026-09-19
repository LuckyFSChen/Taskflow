// 真實 Preview 端到端驗收（部署驗收認證架構修正的實測證據）。
//
// 跑的是正式路徑：server/project-preview.js 真的 npm run build、真的 spawn 子程序、
// server/deployment-validation.js 真的打 /api/health、/api/login、/api/state。
// 中間會停下來等 data/acceptance-e2e/browser-done.txt，讓人（或 Claude）用真的瀏覽器
// 開這個 Preview 並登入，確認 Browser Validation 走的是同一組驗收身份。
//
// 用法：node scripts/acceptance-e2e.mjs
// 產出：data/acceptance-e2e/report.json、data/acceptance-e2e/live.json
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProjectPreview } from '../server/project-preview.js';
import { validateDeployment } from '../server/deployment-validation.js';
import { waitForExit } from '../server/process-lifecycle.js';

const outDir = resolve('data/acceptance-e2e');
mkdirSync(outDir, { recursive: true });
const donePath = resolve(outDir, 'browser-done.txt');
if (existsSync(donePath)) rmSync(donePath);

const BROWSER_WAIT_MS = Number(process.env.ACCEPTANCE_BROWSER_WAIT_MS || 300000);
const key = 'acceptance-e2e';
const previews = createProjectPreview();
const log = [];
const say = message => { const line = `${new Date().toISOString()} ${message}`; log.push(line); console.log(line); };

let info = null, report = null, stopOutcome = null, browser = { waited: false, confirmed: false };
try {
  say('Preview starting…（真的執行 npm run build 與 spawn 子程序）');
  info = await previews.start(key, resolve('.'));
  say(`Preview started url=${info.url} pid=${info.pid} kind=${info.kind}`);

  // 給瀏覽器用的一次性帳密只寫進這個檔案，驗收結束就刪掉；不進 git、不進任務結果。
  writeFileSync(resolve(outDir, 'live.json'), JSON.stringify({
    url: info.url, username: info.acceptance.username, password: info.acceptance.password,
    note: '一次性驗收帳密，Preview 停止即失效。此檔案會在驗收結束時刪除。',
  }, null, 2));

  report = await validateDeployment({ url: info.url, acceptance: info.acceptance });
  for (const check of report.checks) say(`${check.name.padEnd(6)} ${check.actual} passed=${check.passed} ${check.detail}`.trim());
  say(`API 驗收 state=${report.state} passed=${report.passed}`);

  say(`等待瀏覽器驗證：請開啟 ${info.url} 並以 live.json 的帳密登入，完成後建立 ${donePath}`);
  const deadline = Date.now() + BROWSER_WAIT_MS;
  while (Date.now() < deadline && !existsSync(donePath)) await new Promise(r => setTimeout(r, 1000));
  browser = { waited: true, confirmed: existsSync(donePath) };
  say(`Browser validation confirmed=${browser.confirmed}`);
} finally {
  // 不論成功或失敗，Preview 一律停止，並且要確認 PID 真的消失。
  stopOutcome = await previews.stop(key).catch(error => ({ stopped: false, error: String(error?.message || error) }));
  const exited = info?.pid ? await waitForExit(info.pid, { timeoutMs: 15000 }) : true;
  say(`Preview stop stopped=${stopOutcome?.stopped} verified=${stopOutcome?.verified} pidGone=${exited}`);
  rmSync(resolve(outDir, 'live.json'), { force: true });
  rmSync(donePath, { force: true });

  const overall = !!report?.passed && !!stopOutcome?.stopped && !!stopOutcome?.verified && browser.confirmed;
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify({
    at: new Date().toISOString(),
    overall,
    preview: { url: info?.url || null, pid: info?.pid ?? null, started: !!info, stopped: stopOutcome?.stopped === true, verified: stopOutcome?.verified === true },
    // acceptance 的祕密已經在 stop() 裡抹掉，這裡只留得下結論與代碼。
    acceptance: info?.acceptance ? { id: info.acceptance.id, mode: info.acceptance.mode, source: info.acceptance.source, injection: info.acceptance.injection, cleaned: info.acceptance.cleaned === true, passwordInMemory: info.acceptance.password !== null } : null,
    health: report?.health || null,
    authentication: report?.authentication || null,
    apiState: report?.apiState || null,
    state: report?.state || null,
    checks: report?.checks || [],
    browser,
    log,
  }, null, 2));
  say(`OVERALL=${overall ? 'PASSED' : 'NOT PASSED'} → data/acceptance-e2e/report.json`);
  await previews.close().catch(() => {});
}
