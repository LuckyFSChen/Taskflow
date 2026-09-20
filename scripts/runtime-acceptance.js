// Multi-Service Runtime 的實機驗收（計畫書第三十一章的 16 個步驟）。
//
//   node scripts/runtime-acceptance.js <projectPath> [--json <報告輸出路徑>] [--no-browser]
//
// 這個腳本不是測試替身：它會真的啟動專案的後端與前端、真的經由前端的網址打後端 API、
// 真的開一個瀏覽器把頁面載入，最後真的把程序停掉並確認連接埠釋放。
//
// 三個不可妥協的原則：
//   1. 驗的是**實際端點**，不是 proxy namespace 本身。`/api` 是 namespace，
//      不代表後端有實作 `GET /api`；拿它去打只會得到一個合理的 404 再被誤判。
//   2. 驗不到的項目標成 SKIP 並說明原因，不是 FAIL，也不是靜靜放行。
//   3. 回報與關閉都用**最後一次實際建立起來的那一組 runtime**。回復建立了新的 runtime
//      之後還在讀舊的變數，就會出現「事件說 backend ready、步驟說沒有後端服務」這種矛盾。
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveRuntimeTopology, topologyPublic} from '../server/runtime-topology.js';
import {createProjectPreview} from '../server/project-preview.js';
import {validateApiResponse} from '../server/runtime-validation.js';
import {portInUse} from '../server/runtime-manager.js';
import {isAlive} from '../server/process-lifecycle.js';
import {runtimePreflight, preflightSummary} from '../server/runtime-recovery.js';

const args = process.argv.slice(2);
const projectPath = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null;
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const withBrowser = !args.includes('--no-browser');
if (!projectPath) { console.error('用法：node scripts/runtime-acceptance.js <projectPath> [--json <path>] [--no-browser]'); process.exit(1); }

const steps = [];
let stepNo = 0;
const record = (name, status, detail = '') => {
  // skipped 的 passed 是 null，不是 false：「沒有驗」與「驗了沒過」是兩回事，
  // 報告的消費端不該把前者讀成後者。status 才是權威欄位。
  const entry = {step: ++stepNo, name, status, passed: status === 'skip' ? null : status === 'pass', detail: String(detail).slice(0, 2000)};
  steps.push(entry);
  const mark = {pass: 'PASS', fail: 'FAIL', skip: 'SKIP'}[status];
  console.log(`${String(entry.step).padStart(2, ' ')}. ${mark}  ${name}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`);
  return entry;
};
const pass = (name, detail) => record(name, 'pass', detail);
const fail = (name, detail) => record(name, 'fail', detail);
const skip = (name, detail) => record(name, 'skip', detail);
const verdict = (name, ok, detail) => record(name, ok ? 'pass' : 'fail', detail);

const KEY = 'runtime-acceptance';
const previews = createProjectPreview({registryPath: resolve('data/preview/acceptance-registry.json')});
let exitCode = 0;

try {
  // 1. Detect topology
  const topology = resolveRuntimeTopology(projectPath);
  verdict('Detect runtime topology', !!topology, topology ? JSON.stringify(topologyPublic(topology)) : '這個專案被判定為單一服務（沒有 multi-service topology）。');
  if (!topology) { exitCode = 1; throw new Error('沒有 topology 可驗收'); }

  // 2–7. 啟動（依相依順序）、backend health、frontend health、經由前端打後端
  const preflight = await runtimePreflight(KEY, projectPath, {previews, onEvent: (kind, payload) => console.log(`      · ${kind} ${JSON.stringify(payload).slice(0, 300)}`)});
  // authoritative runtime state：preflight 帶回來的那一份就是最後一次實際建立的 runtime，
  // 不論它最後有沒有通過。絕不回頭讀已經被停掉的舊物件。
  const runtime = preflight.runtime || null;
  const backend = runtime?.services.find(service => ['backend', 'worker'].includes(service.type)) || null;
  const frontend = runtime?.services.find(service => service.browserEntry) || null;

  verdict('Start backend（依相依順序，先於 frontend）', backend?.status === 'READY',
    backend ? `${backend.id} pid=${backend.pid} port=${backend.port} status=${backend.status}${backend.error ? ` error=${backend.error}` : ''}` : '這一組 runtime 沒有建立出後端服務');
  verdict('Confirm backend health（直接打後端）', backend?.health?.passed === true,
    backend ? `${backend.health?.url || ''} → ${backend.health?.status ?? '無回應'} ${backend.health?.contentType || ''} ${backend.health?.detail || ''}` : '');
  verdict('Start frontend preview', frontend?.status === 'READY',
    frontend ? `${frontend.id} port=${frontend.port} url=${frontend.url} mode=${frontend.mode}` : '這一組 runtime 沒有建立出前端服務');

  const rootCheck = preflight.checks.find(check => check.name === 'frontend_root');
  verdict('Confirm frontend root（HTTP 200 + HTML）', rootCheck?.passed === true, rootCheck ? `${rootCheck.actual} ${rootCheck.detail || ''}` : '未執行');

  // 跨服務轉發：每一項都照它自己的契約判定。api 類要 JSON，static 類只要沒落進 SPA fallback，
  // 沒有可驗證端點的 namespace 標成 SKIP 並說明原因。
  for (const check of preflight.checks.filter(item => item.name.startsWith('frontend_proxy'))) {
    const label = `${check.skipped ? '未驗證' : '經由 frontend preview 驗證'} ${check.path || check.name}${check.source ? `（來源：${check.source}）` : ''}`;
    if (check.skipped) skip(label, check.detail);
    else verdict(label, check.passed, `${check.actual} ${check.detail || ''}`.trim());
  }
  verdict('Runtime preflight 總結', preflight.passed, preflightSummary(preflight));

  // 8–9. 再挑一個真實 API 端點。狀態碼由端點自己的契約決定（200/401/403/404 都可能合理），
  // 唯一不可接受的是「被 SPA fallback 假冒」。
  const previewUrl = preflight.previewUrl;
  if (previewUrl) {
    const profile = await validateApiResponse(`${previewUrl}/api/profile`, {expectedContentType: 'application/json', via: 'frontend'});
    const spa = profile.failureKind === 'proxy_routing_failure';
    // 端點不存在（404 JSON）不是轉發失敗；被 SPA fallback 吃掉才是。
    const acceptable = profile.passed || (!spa && [404].includes(profile.status));
    verdict('Request /api/profile via frontend preview（不得被 SPA fallback 假冒）', acceptable,
      `${profile.status ?? '無回應'} ${profile.contentType || ''} ${profile.detail || ''} body=${(profile.bodyPreview || '').slice(0, 120)}`);
  }

  // 10–13. 真的開一個瀏覽器把頁面載入，收集 console error 與失敗的 API 請求。
  if (withBrowser && previewUrl && preflight.passed) {
    const {chromium} = await import('playwright');
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage();
      const consoleErrors = [], failedRequests = [], htmlApiResponses = [];
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
      page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
      page.on('response', response => {
        const url = response.url();
        if (!url.includes('/api/')) return;
        const type = (response.headers()['content-type'] || '').split(';')[0];
        // 這正是整改前的病徵：API 回 200，但內容是 SPA 的 index.html。
        if (type === 'text/html') htmlApiResponses.push(`${response.status()} ${type} ${url}`);
      });
      const response = await page.goto(previewUrl, {waitUntil: 'networkidle', timeout: 45000});
      verdict('Playwright 開啟 frontend preview', response?.ok() === true, `HTTP ${response?.status()}`);
      const title = await page.title();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
      verdict('Confirm 頁面實際渲染出內容', bodyText.trim().length > 0, `title="${title}" body 前 200 字：${bodyText.slice(0, 200).replace(/\s+/g, ' ')}`);
      verdict('Confirm 沒有 API 回應被 SPA fallback 攔截（200 text/html）', htmlApiResponses.length === 0, htmlApiResponses.join('\n') || '沒有任何 /api/* 回應是 HTML');
      verdict('Confirm 沒有資料載入失敗（console error／request failed）', consoleErrors.length === 0 && failedRequests.length === 0,
        [...consoleErrors.map(item => `console: ${item}`), ...failedRequests.map(item => `request: ${item}`)].join('\n') || '沒有 console error，也沒有失敗的請求');
    } finally { await browser.close(); }
  } else if (withBrowser && !preflight.passed) {
    skip('Playwright 瀏覽器驗證', 'Runtime preflight 未通過，依規則不得啟動 Browser Validation。');
  }

  // 14–16. 關閉並確認：PID 消失、連接埠釋放。
  // preflight 失敗時已經由它停掉了，那一次的結果就是這裡的結果——不能因為「不是我停的」
  // 就回報一個空陣列。
  const stopped = preflight.shutdown || await previews.stop(KEY);
  const services = stopped?.services || [];
  verdict('Shutdown frontend 與 backend', stopped?.stopped === true && stopped.verified !== false && services.length > 0,
    `${preflight.shutdown ? '（由 runtime preflight 在回復流程中停止）' : ''}${JSON.stringify(services)}`);
  for (const service of [backend, frontend].filter(Boolean)) {
    const aliveNow = service.pid ? isAlive(service.pid) : false;
    const portBusy = await portInUse(service.port);
    verdict(`Verify ${service.id} 已結束且連接埠 ${service.port} 釋放`, !aliveNow && !portBusy, `pid alive=${aliveNow} port in use=${portBusy}`);
  }
} catch (error) {
  fail('驗收過程發生例外', String(error?.stack || error?.message || error));
  exitCode = 1;
} finally {
  await previews.close().catch(() => {});
}

const failed = steps.filter(step => step.status === 'fail');
const skipped = steps.filter(step => step.status === 'skip');
const summary = {projectPath, passed: failed.length === 0, total: steps.length, failed: failed.length, skipped: skipped.length, steps, at: new Date().toISOString()};
console.log(`\n=== 驗收結果：${summary.passed ? `全部通過${skipped.length ? `（另有 ${skipped.length} 項未驗證）` : ''}` : `${failed.length}／${steps.length} 項未通過`} ===`);
for (const step of failed) console.log(`  ✗ ${step.step}. ${step.name}：${step.detail.slice(0, 300)}`);
for (const step of skipped) console.log(`  – ${step.step}. ${step.name}：${step.detail.slice(0, 200)}`);
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify(summary, null, 2)); console.log(`報告已寫入 ${jsonPath}`); }
process.exit(summary.passed ? exitCode : 1);
