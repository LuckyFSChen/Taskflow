# 驗證紀錄 — 2026-09-16

## 實際執行結果

| 項目 | 結果 | 邊界 |
| --- | --- | --- |
| Vue TypeScript 檢查及正式建置 | 通過 | 非人工瀏覽器操作／視覺驗收 |
| 本地 HTTP 網頁 | 200，服務於 127.0.0.1:4310 | 只驗證本機，未對外配置隧道 |
| 任務流程、權限與 HTTP API | 10 個測試通過 | 工作流單元測試使用可控 AI adapter |
| 雲端 webhook 與本機資料庫整合 | 1 個測試通過 | 使用真實 SQLite 與 Worker handler；未部署 D1 |
| Claude 製作的 Worker 測試 | 17 個測試通過 | LINE push 為測試替身，沒有實際發訊息 |
| Codex 真實讀取測試 | 通過，約 12 秒 | 讀取一次性檔案、正確結構化輸出、有 session ID |
| Claude Code 真實讀取測試 | 通過，約 17 秒 | 同上 |
| 真實雙引擎完整流程 | 通過，約 60 秒 | Claude 規劃、測試程式核准固定 fixture、Codex 產出、Claude 驗證 |
| npm production dependencies audit | 0 已知漏洞 | 以執行當下的 registry 資料為準 |

真實完整流程在台北時間 13:17:35 完成。Node 程式額外確認 DELIVERY.md 與 INPUT.txt 相符，原始資料夾未新增 DELIVERY.md；這不是僅依 AI 宣告判定。

完整流程 task ID：`27f5a959-d5ae-4ce0-bfb9-abb0a806fcb6`。

| 階段 | 引擎 | 真實 session ID |
| --- | --- | --- |
| 需求規劃 | Claude Code | 54f06695-cb2a-49ef-a2ba-b51055efed01 |
| 工程師 | Codex | 01a0a8a5-95c1-7d63-9d40-c96f7207a94b |
| 獨立驗證 | Claude Code | a2c5a469-bcea-4785-bfdc-c07d413492c1 |

原始驗證報告保存在本機 `data/validation/`；隔離測試不會在使用者正式任務清單塞入假任務。

## 主要情境
- 未登入、跨使用者任務存取、未授權專案、跨來源寫入拒絕。
- 計畫核准版本不符拒絕；補充需求使舊核准失效。
- 未核准不執行；優先級控制派工；暫停任務不派工。
- 引擎錯誤不無限重試；驗證最多兩輪修正。
- 上次中斷的 thread 在重啟時改為暫停待處理。
- LINE 一次性綁定、排除群組操作、事件重送不重複建立任務。
- 雲端驗簽後入庫，本機處理完成但未 ack 時重送，仍只建立一筆任務。

## 尚未驗證／需要設定
- 實際 LINE 帳號、訊息投遞、推播配額與真實 Cloudflare D1 / Worker 上線。
- 固定 HTTPS 網域、Cloudflare Tunnel、公網環境及外部成員手機連線。
- 多小時耐久度、Windows 睡眠／斷電後實機恢復及大型專案負載。
- 人工瀏覽器視覺與鍵盤操作；目前完成前端編譯及 HTTP 測試，沒有聲稱已做瀏覽器互動測試。
- WebMCP 支援瀏覽器的原生工具註冊測試。

## Claude 協作紀錄
使用本機 Claude Code 工作階段 `6952f325-78dd-4e05-bcb8-f1f1564bb610`，限於 cloud-inbox 目錄撰寫 Worker、schema、設定、測試與繁體中文部署說明。Claude 的檔案寫入已確認；其自行執行 shell 測試受此次委派工具範圍限制，因此由主代理實際執行與整合驗證。

主代理檢查後調整：HMAC 改用 Web Crypto verify、避免記錄原始例外、忽略 .dev.vars 秘密檔、修正 LINE Verify 請求說明，並新增真實 SQLite 跨層整合測試。
# 開發命令授權修正（2026-09-16）

- Claude 實作與驗證工作階段加入常用套件安裝、建置、測試的 allowedTools 規則；規劃仍唯讀，未啟用 bypass。
- npm test：38 個測試通過。
- 真實 Claude 工作階段 `92f4a473-1450-4ae9-b7bd-72d2ff9f5bbd` 在 HelloWorld 工作副本成功執行 npm install 與 npm run build，另由 Node 確認 node_modules 與 dist/index.html 存在。
- 證據：`data/validation/commands-1789537505128/report.json`。此項只證明安裝／建置，瀏覽器實際渲染仍由任務最終驗證處理。

## 專案資料夾與本機預覽（2026-09-16）

- 40 個測試通過，Vue 型別檢查及正式建置成功。
- 測試涵蓋登入、專案成員權限、工作副本擁有者檢查、跨專案拒絕、重複啟動共用網址、停止預覽與建置錯誤回報。
- 在實際平台設定頁點擊「開啟資料夾」，API 成功啟動 Explorer。
- 點擊 HelloWorld 工作副本的「啟動並開啟網頁」，實際完成 Vite 建置並自動開啟 http://127.0.0.1:52490/。瀏覽器可見 Hello World 與「歡迎使用 Vue！」，已檢查畫面。
- 此網址僅為本次執行的動態埠；重新啟動預覽時應以介面顯示的新網址為準。

## LINE 建立專案及平台搬移（2026-09-16）

- 43 個測試通過，Vue 型別檢查與正式建置成功。新增驗證包含中文資料夾、確認後建立、LINE 重播去重、過期與取消、權限、同名保留、設定變更及路徑穿越。
- 平台已搬至 F:\TaskFlow，帳號、LINE 連結與任務資料保留；資料庫備份在 data/pre-relocation.sqlite。原有任務工作副本路徑已更新並確認存在。
- 已將 TaskFlow（代號 taskflow）加入平台專案，設定 LINE 預設存放位置為 F:\TaskFlow\Projects。
- 瀏覽器已確認搬移後平台顯示兩個專案、預設路徑及既有 LINE 連結。平台自我開發快照排除 data、其他專案、Cloudflare 暫存與本地密鑰設定。

## 專案資料夾選取視窗（2026-09-16）

- 「可用專案」的本機資料夾改為唯讀路徑與「選擇資料夾」按鈕，使用原生 dialog 彈出資料夾瀏覽器。
- 支援從預設位置起始、磁碟切換、上一層、回到預設位置、搜尋、建立新資料夾並進入、選取後帶回新增專案表單。
- 45 個測試通過；型別檢查與正式建置成功。新增測試涵蓋管理者限定、預設位置、僅列資料夾、內部 data 保護、新建、同名與路徑穿越拒絕。
- 實際瀏覽器操作已確認預設 F:\TaskFlow\Projects、上層清單、返回預設、選取路徑帶回表單，並檢視 popup 排版。未建立多餘正式專案。

## 任務標題自動建立專案（2026-09-16）

- 管理者從網頁或 LINE 發布任務時，預設依任務標題建立並使用新專案；可明確改選既有專案。一般成員沿用既有專案授權。
- 資料夾位於預設存放位置；名稱轉換 Windows 不合法字元、縮短超長名稱，同名加編號，不覆蓋原資料夾。原始任務標題保留。
- 任務欄位先驗證，確認發布才建立資料夾；專案與任務在同一交易保存，建立失敗會回復資料庫並清理空資料夾。
- 完整測試 48 個通過，後續交易回復調整另通過 4 個相關測試；正式建置通過。瀏覽器確認發布視窗預選「依任務標題建立新專案（預設）」。

## LINE GPT 對話及文字操作（2026-09-16）

- 全套 54 項測試通過。最後的選項階段聊天分流調整後，LINE 相關 14 項測試再次通過。
- 實際透過登入中的 Codex／GPT 完成文字生成；另一份獨立 SQLite 測試走 processLine → chat worker → GPT → outbox，結果 completed，產生 1 則回覆：「請回覆『建立任務』，即可開始文字流程。」未向真實 LINE 使用者發送測試訊息。
- 覆蓋：訊息重播去重、最近對話上下文、不同帳號隔離、解除綁定後不發送、GPT 失敗回覆、佇列限制、重啟恢復、文字發布、版本變更拒絕核准、核准上下文過期及重複核准保護。
- LINE 手機端實際收發仍需使用者傳送訊息驗證；本次未冒用使用者向 webhook 發送事件。
- 已等待執行中的規劃完成後重啟服務，並恢復原有 runnerEnabled=true。重啟後本機及 Cloudflare 公開首頁皆回應 200，LINE 收件同步無錯誤，LINE_GPT_MODEL=gpt-6-astra。

## 任務狀態直接修改（2026-09-16）

- 任務佇列與詳情新增狀態下拉選單，支援手動完成、暫停、取消及恢復處理；操作記錄包含使用者與原狀態。
- 手動結束會停止目前 AI 子程序，以 controlVersion 阻擋晚到的成功或錯誤覆寫狀態。重新啟動服務也保留已結束狀態。
- 手動完成不產生驗證成果版本，不可當成 AI 通過驗證來核准交付；恢復處理仍依計畫、問題及審核狀態決定下一步。
- 完整 58 個測試通過，正式建置成功；真實瀏覽器已確認佇列中的狀態選單與選項。未更動使用者既有任務的實際狀態。

## LINE 任務狀態控制（2026-09-16）

完整測試 63 個通過。新增測試覆蓋 LINE 查看任務後的按鈕與文字操作、停止 AI 的 runner 接線、重送去重、過期／狀態已變更拒絕、擁有者檢查與手動完成標示。未連接 runner 時禁止假裝停止仍在執行的工作。本次未對使用者正式任務發送測試變更。

## 開啟資料夾修正（2026-09-16）

Explorer 改用可見視窗啟動（windowsHide=false），並要求新視窗，避免沿用舊版隱藏視窗；保留 shell=false 與獨立路徑參數。開啟資料夾不再被 AI 正在執行的預覽限制擋住。3 個相關測試通過，包含特殊字元路徑、啟動失敗及執行中可開啟但不可建置预覽。實際已呼叫 Explorer 開啟 F:\TaskFlow 並收到程序啟動成功；未取得原生視窗畫面驗證。服務已重新啟動。

## 規劃結果缺少欄位（2026-09-16）

圖片補充需求任務 v8 在 Claude StructuredOutput 階段缺少 acceptance/questions/steps，5 次內部修復後仍失敗，沒有產生可採用的計畫。已在 CLI prompt 加入實際完整 JSON Schema 與必要欄位檢查，失敗訊息附上易讀的重試指引並保留 sessionId；不補造缺失的驗收條件或步驟。完整 91 個測試通過。既有執行服務有其他進行中工作，本次以 scripts/retry-failed-plan.js 唯讀重試指定失敗任務，未中断其他任務。

重試結果：Claude 工作階段 073f3681-50db-4524-aa4b-2f562945c3c3 完成，完整計畫通過 schema 驗證，包含 8 個步驟與 1 個待確認問題；任務由格式失敗轉為 waiting_input。原版本與需求未變更，尚未核准或開始實作。
使用者原需求已明列「任一失敗則都不保留」，因此將同一交易回滾列為驗收條件，移除重複問題並記錄 clarification_applied，最終狀態 awaiting_approval（v8），未核准實作。

## 2026-09-16 重複提問修正
- 回答保存為配對的問題與答案，歷史版本可由角色紀錄還原；所有 AI 階段攜帶問答背景。
- 補充需求仍重新規劃並要求核准，但保留既有工作副本。
- 有既有回答的規劃／修正方案若仍提問，增加一次唯讀核對；必要新問題仍停下等待，不自動推定同意。
- 環境限制列入報告，工具拒絕必須提供具體阻礙，不反覆索取相同同意。
- npm test：98/98 通過，含問答配對、舊資料還原、工作副本保留、核對次數與核准邊界。
- 空閒時重新啟動服務，本機 health 與公開恢復檢查成功。沒有變更 runnerEnabled 開關。

## Browser Validation（Claude Code + Playwright MCP）（2026-09-18）

詳細架構、安全限制與已知限制見 `docs/BROWSER-VALIDATION.md`；本節只記錄「實際執行結果」。

### 環境確認
- `claude --version`：2.1.276，本機可執行。
- `@playwright/mcp@0.0.40`（devDependency）已安裝於 `node_modules/@playwright/mcp`；其 `package.json`
  的 `exports` 欄位不公開 `./cli.js`，`resolvePlaywrightMcpEntry()` 改用套件根目錄推導路徑後可正確解析。
- 直接對 Playwright MCP 送出 MCP `initialize` JSON-RPC 請求（不經過 `claude mcp add`，未寫入任何全域
  或專案設定檔），收到 `{"serverInfo":{"name":"Playwright","version":"0.0.40"}}`，確認可連線。
- `checkClaudeBrowserCapability()` 回傳 `{"available":true,"provider":"playwright-mcp","cli":"claude","error":null}`。

### TaskFlow spawn 出來的 Claude 也看得到同一個 MCP（本次最重要的驗證項目）
既有 `cliAdapter` 呼叫 Claude 時使用 `--strict-mcp-config --setting-sources ''`，完全不依賴使用者
本機的 `claude mcp add`／`~/.claude.json`／專案 `.mcp.json`；Browser 驗證延續同一機制，每次呼叫都用
`--mcp-config` 內嵌「只有一個 playwright server」的設定。因此「手動開的 claude 看得到 MCP，TaskFlow
spawn 的看不到」這個落差問題不存在——兩者本來就是兩條獨立路徑，TaskFlow 這邊永遠自帶設定。已用
`server/browser-validation-smoke.js`（見下）證實：TaskFlow 的 `runner.js` 真正 spawn 出的 `claude`
子行程，確實能呼叫 `mcp__playwright__browser_*` 工具。

### 真實整合測試：`node scripts/browser-validation-smoke.js`
直接呼叫 `createRunner()`／`cliAdapter()`（未 mock），驅動一個「按鈕點擊後顯示彈窗」的靜態 HTML
fixture，經由 TaskFlow 既有 `project-preview.js` 提供本機預覽網址，交給真實 `claude -p` 子行程搭配
Playwright MCP 驗證：

| 情境 | Preview URL | 結果 | 真實工具呼叫 |
| --- | --- | --- | --- |
| 按鈕正常運作（pass fixture） | http://127.0.0.1:41515 | `browserValidation.status="passed"`，task 狀態 `completed` | `mcp__playwright__browser_navigate`、`browser_click`、`browser_console_messages`、`browser_network_requests`，共 4 次 |
| 按鈕 onclick 直接 throw（fail fixture，對應「故意加入 runtime browser error」） | http://127.0.0.1:43257 | `browserValidation.status="failed"`，`consoleErrors` 記錄兩筆真實錯誤訊息，task 狀態轉入 `repair_planning`（round=1） | 同上 4 種工具 |

兩種情境的 `browserValidation.toolUsed` 均為 `true`、`toolCallCount=4`，證實不是 AI 自稱測試過，
而是 TaskFlow 從 `stream-json` 的 `tool_use` 事件實際數出來的呼叫次數（`reconcileBrowserValidation`）。
pass 情境的 summary／evidence 具體引用了 accessibility snapshot 顯示的「Dialog visible」文字節點；
fail 情境具體引用了 `Error: browser-validation-test` 的實際 console 訊息與 `#dialog` 的
`style.display` 仍為 `none`。

### 反造假 deterministic guard（自動測試，`tests/browser-validation.test.js`）
用假 adapter 模擬「AI 在 `summary`／`browserValidation` 都宣稱 `passed:true`，但 stream-json 沒有任何
`mcp__playwright__*` 的 tool_use 事件」，最終 `result.passed` 仍被強制改為 `false`，task 進入
`waiting_input` 並走既有的「驗證工具存取失敗」跳過流程，不會被判定通過。另外用假
`checkBrowserCapability` 模擬 Playwright MCP 不可用，同樣得到 `status="blocked"`、
`passed=false`，不會是 silent pass。9 個新測試全數通過（需求判定、反造假、blocked 流程、
repair 核准後重新驗證並通過）。

### 修復重驗（fail → fix → pass）
`tests/browser-validation.test.js` 的第三個整合測試（假 adapter，涵蓋完整 Repair Approval 流程）
證實：第一次審核回報 `browserValidation.status="failed"` → 自動進入 `repair_planning` →
`awaiting_repair_approval` → 使用者 `approveRepair` 核准 → 執行修正 → 重新走 `review` 階段 →
第二次 `browserValidation.status="passed"`，task 最終轉為 `completed`。修正輪次與人工核准關卡
沿用既有機制，沒有讓 AI 自己無限重試。

### 前端 UI
`/api/state` 新增 `integrations.browser`（`{configured, provider, available, error}`）；設定頁
「服務連線」面板顯示「Browser 驗證（Playwright MCP）」列（本機測得 `Ready`，綠色徽章）。任務詳情
的「角色紀錄」在 `browserValidation.required` 為真時，於驗證證據下方顯示 Browser 驗證區塊
（狀態徽章、Preview URL、工具呼叫次數、checks 清單、console／network 錯誤、notes）；已用真實瀏覽器
（Playwright，非 MCP，獨立於受測系統）開啟登入後的畫面截圖確認渲染正確，且未產生非預期的
console error（唯一出現的是登入前 `/api/state` 回傳 401，屬預期行為）。

### 回歸測試
- `npm test`：147/147 通過（含新增的 9 個 Browser Validation 測試；既有 138 個測試全數維持通過，
  `resultSchema` 新增的 `browserValidation` 欄位有預設值，不影響舊測試資料或舊任務讀取）。
- `npm run build`：`vue-tsc --noEmit && vite build` 成功。

### 已知限制
僅 Chromium headless；不含視覺回歸比對；Codex 引擎的步驟不接 Browser MCP；需求判定為關鍵字
啟發式，可能有少量假陽性／假陰性。詳見 `docs/BROWSER-VALIDATION.md` 的 Known limitations。

## Browser Validation：deterministic guard 加嚴（只看「呼叫過任何工具」不夠嚴格）（2026-09-18）

原本 `reconcileBrowserValidation()` 只用 `toolCallCount > 0` 判斷「有沒有測」，代表只要
Claude 呼叫過任一個 `mcp__playwright__browser_*`（例如只呼叫 `browser_console_messages`，
從未 `navigate`），就可能被算成已執行。修正為：

1. `toolCallCount === 0` → `blocked`（不變）。
2. 有工具呼叫、但真實 `categories.navigate` 是 0（沒有任何 `browser_navigate` 類工具呼叫）
   → 一樣 `executed=false, passed=false, status="blocked"`，並明確回報
   「未偵測到 Browser navigate 工具呼叫，不能證明已實際開啟 Preview URL」。
3. 新增 `deriveBrowserValidationRequirement()` 的 `requiresInteraction` 判定（按鈕／點擊／
   表單／選單等互動關鍵字）；`requiresInteraction=true` 但真實 `categories.interact` 是 0
   （沒有任何 click／type／fill／select 等互動工具呼叫）→
   `executed=true, passed=false, status="failed"`，回報
   「此任務需要實際 UI 互動，但未偵測到 Browser interact 工具呼叫」。
4. AI 自己回報的 `executed`／`passed` 不再是權威來源：`executed` 完全由 TaskFlow 依
   navigate／interact 的真實證據推導；只有通過上述三關才會採用 AI 回報的 `passed`
   決定最終 `status`。
5. `browserValidation` 新增 `categories`（TaskFlow 自己統計的
   `{navigate, interact, console, network, inspect, other}` 次數），保留到最終結果，
   不是驗完就丟；讓人工與 `scripts/browser-validation-smoke.js` 都能直接核對「真的
   navigate 過」「真的 interact 過」，不必只信任 `toolUsed`。

### 自動測試
`tests/browser-validation.test.js` 新增：只有 console／只有 screenshot（無 navigate）→
`blocked`；navigate 但非互動任務 → 依 AI 實際結果判定 pass/fail；navigate 但互動任務缺
interact → `failed`；navigate+interact → 可通過；navigate+interact 但 AI 自稱
`passed=false` → 仍是 `failed`（AI 的 pass/fail 判斷仍受尊重，但 `executed` 絕不是 AI
說了算）；`deriveBrowserValidationRequirement` 的 `requiresInteraction` 判定。加嚴後
**17** 個 Browser Validation 測試全數通過；`npm test` 總計 **155/155** 通過；
`npm run build` 成功。

### 真實整合測試（加嚴後重新驗證）
重新執行 `node scripts/browser-validation-smoke.js`（已加強為同時檢查
`toolCallCount>=2`、`categories.navigate>=1`、`categories.interact>=1`，不再只看
`toolUsed`）：

| 情境 | categories | 結果 |
| --- | --- | --- |
| pass-scenario（按鈕正常顯示彈窗） | `{"navigate":1,"interact":1,"console":1,"network":1}` | 三項證據檢查全數 ✓，`status="passed"` |
| fail-scenario（onclick 直接 throw） | `{"navigate":1,"interact":1,"other":1,"console":1}` | 三項證據檢查全數 ✓，`status="failed"`，task 進入 `repair_planning` |

兩種情境都確認 Claude 真的呼叫了 `browser_navigate` 與 `browser_click`（而不只是呼叫過
某個瀏覽器工具），證實加嚴後的 guard 在真實 Claude Code + Playwright MCP 呼叫下運作正常。
