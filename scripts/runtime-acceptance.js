// Multi-Service Runtime 的實機驗收（計畫書第三十一章的 16 個步驟）。
//
//   node scripts/runtime-acceptance.js <projectPath> [--json <報告輸出路徑>] [--no-browser]
//
// 這個腳本不是測試替身：它會真的啟動專案的後端與前端、真的經由前端的網址打後端 API、
// 真的開一個瀏覽器把頁面載入，最後真的把程序停掉並確認連接埠釋放。
// 任何一步失敗都照實記錄，不會為了讓報告好看而略過。
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
const record = (name, passed, detail = '') => {
  const entry = {step: ++stepNo, name, passed, detail: String(detail).slice(0, 2000)};
  steps.push(entry);
  console.log(`${String(entry.step).padStart(2, ' ')}. ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`);
  return passed;
};

const KEY = 'runtime-acceptance';
const previews = createProjectPreview({registryPath: resolve('data/preview/acceptance-registry.json')});
let exitCode = 0;

try {
  // 1. Detect topology
  const topology = resolveRuntimeTopology(projectPath);
  record('Detect runtime topology', !!topology, topology ? JSON.stringify(topologyPublic(topology)) : '這個專案被判定為單一服務（沒有 multi-service topology）。');
  if (!topology) { exitCode = 1; throw new Error('沒有 topology 可驗收'); }

  // 2–7. 啟動（依相依順序）、backend health、frontend health、經由前端打後端
  const preflight = await runtimePreflight(KEY, projectPath, {previews, onEvent: (kind, payload) => console.log(`      · ${kind} ${JSON.stringify(payload).slice(0, 300)}`)});
  const runtime = preflight.info?.runtime || previews.status(KEY)?.runtime || null;
  const backend = runtime?.services.find(service => ['backend', 'worker'].includes(service.type)) || null;
  const frontend = runtime?.services.find(service => service.browserEntry) || null;

  record('Start backend（依相依順序，先於 frontend）', backend?.status === 'READY', backend ? `${backend.id} pid=${backend.pid} port=${backend.port} status=${backend.status}${backend.error ? ` error=${backend.error}` : ''}` : '沒有後端服務');
  record('Confirm backend health（直接打後端）', backend?.health?.passed === true, backend ? `${backend.health?.url || ''} → ${backend.health?.status ?? '無回應'} ${backend.health?.contentType || ''} ${backend.health?.detail || ''}` : '');
  record('Start frontend preview', frontend?.status === 'READY', frontend ? `${frontend.id} port=${frontend.port} url=${frontend.url} mode=${frontend.mode}` : '沒有前端服務');
  const rootCheck = preflight.checks.find(check => check.name === 'frontend_root');
  record('Confirm frontend root（HTTP 200 + HTML）', rootCheck?.passed === true, rootCheck ? `${rootCheck.actual} ${rootCheck.detail || ''}` : '未執行');

  const previewUrl = preflight.previewUrl || previews.status(KEY)?.url || null;
  for (const check of preflight.checks.filter(item => item.name.startsWith('frontend_proxy'))) {
    record(`Request ${check.path} via frontend preview`, check.passed, `${check.url} → ${check.actual} ${check.detail || ''}`);
  }
  record('Runtime preflight 總結', preflight.passed, preflightSummary(preflight));

  // 8–9. 需求裡點名的 /api/profile：狀態碼可以是 401（未登入），但型別必須是 JSON。
  if (previewUrl) {
    const profile = await validateApiResponse(`${previewUrl}/api/profile`, {expectedContentType: 'application/json', via: 'frontend'});
    record('Request /api/profile via frontend preview（型別必須是 JSON，狀態碼不限）', profile.passed,
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
      page.on('response', async response => {
        const url = response.url();
        if (!url.includes('/api/')) return;
        const type = (response.headers()['content-type'] || '').split(';')[0];
        // 這正是整改前的病徵：API 回 200，但內容是 SPA 的 index.html。
        if (type === 'text/html') htmlApiResponses.push(`${response.status()} ${type} ${url}`);
      });
      const response = await page.goto(previewUrl, {waitUntil: 'networkidle', timeout: 45000});
      record('Playwright 開啟 frontend preview', response?.ok() === true, `HTTP ${response?.status()}`);
      const title = await page.title();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
      record('Confirm 頁面實際渲染出內容', bodyText.trim().length > 0, `title="${title}" body 前 200 字：${bodyText.slice(0, 200).replace(/\s+/g, ' ')}`);
      record('Confirm 沒有 API 回應被 SPA fallback 攔截（200 text/html）', htmlApiResponses.length === 0, htmlApiResponses.join('\n') || '沒有任何 /api/* 回應是 HTML');
      record('Confirm 沒有資料載入失敗（console error／request failed）', consoleErrors.length === 0 && failedRequests.length === 0,
        [...consoleErrors.map(item => `console: ${item}`), ...failedRequests.map(item => `request: ${item}`)].join('\n') || '沒有 console error，也沒有失敗的請求');
    } finally { await browser.close(); }
  } else if (withBrowser) {
    record('Playwright 瀏覽器驗證', false, 'Runtime preflight 未通過，依規則不得啟動 Browser Validation。');
  }

  // 14–16. 關閉並確認：PID 消失、連接埠釋放。
  const stopped = await previews.stop(KEY);
  record('Shutdown frontend 與 backend', stopped.stopped === true && stopped.verified !== false, JSON.stringify(stopped.services || []));
  for (const service of [backend, frontend].filter(Boolean)) {
    const aliveNow = service.pid ? isAlive(service.pid) : false;
    const portBusy = await portInUse(service.port);
    record(`Verify ${service.id} 已結束且連接埠 ${service.port} 釋放`, !aliveNow && !portBusy, `pid alive=${aliveNow} port in use=${portBusy}`);
  }
} catch (error) {
  record('驗收過程發生例外', false, String(error?.stack || error?.message || error));
  exitCode = 1;
} finally {
  await previews.close().catch(() => {});
}

const failed = steps.filter(step => !step.passed);
const summary = {projectPath, passed: failed.length === 0, total: steps.length, failed: failed.length, steps, at: new Date().toISOString()};
console.log(`\n=== 驗收結果：${summary.passed ? '全部通過' : `${failed.length}／${steps.length} 項未通過`} ===`);
for (const step of failed) console.log(`  ✗ ${step.step}. ${step.name}：${step.detail.slice(0, 300)}`);
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify(summary, null, 2)); console.log(`報告已寫入 ${jsonPath}`); }
process.exit(summary.passed ? exitCode : 1);
