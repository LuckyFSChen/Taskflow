# TaskFlow

Windows 本地 AI 任務工作台。Vue 3 + TypeScript + Vite + Pinia + Vue Router，Node.js 24 + Express + SQLite。

## 開啟工作台
目前的本地網址：http://127.0.0.1:4310

主服務固定使用 `4310`、Service Guardian 固定使用 `4311`；任務 worktree、Preview 與 Browser Validation 使用動態高位連接埠，兩者完全隔離（見 `server/ports.js`）。要改主服務的連接埠請設定 `.env` 的 `TASKFLOW_PORT`——泛用的 `PORT` 屬於任務 runtime，主服務不會讀它。

首次登入資訊在 `data/first-login.txt`，只保存在你的電腦，未硬編碼於程式。登入後請在設定變更密碼並刪除首次登入檔。沒有預設共用密碼。

後續可在 PowerShell 執行 `./Start-TaskFlow.ps1`。若已安裝依賴及建置，也可 `npm start`。需 Node.js 24 以上。

首次安裝或移到別台電腦：
```powershell
npm ci
npm run setup
npm run build
npm start
```

開發介面：`npm run dev`，網頁 http://127.0.0.1:5173；正式版 `npm start` 同時服務網頁與 API。

## 使用順序
1. 設定 → 新增專案：輸入本機資料夾的絕對路徑與代號。預設勾選「不存在時建立資料夾」，可建立多層新路徑；既有資料夾內容會保留。選擇專門的工作專案，不要選整個磁碟或個人目錄。
2. 新增成員並勾選可用專案。成員只能看自己的任務；管理者可看所有任務。
3. 在本機分別完成 `codex login` 與 `claude` 的登入。CLI 路徑可設定於 `.env` 的 CODEX_BIN / CLAUDE_BIN。若要讓前端任務使用實際 Browser 驗證，另外執行 `npm run setup:browser`（詳見 `docs/BROWSER-VALIDATION.md`）；未設定也能使用平台，只是網頁 UI 任務的獨立驗證會回報「Browser MCP 不可用」並導向人工跳過流程，不影響非網頁任務。
4. 設定 → 啟用 AI 自動領取任務。這會使用你登入的帳號及額度，不會自動切到 API 計費。
5. 發布任務，選擇類型、專案、優先級與引擎。AI 先唯讀規劃；確認計畫與驗收後核准。
6. 在任務詳情的「概覽」處理待辦、看「執行進度」確認做到哪裡；需要回答時補充需求，新版計畫必須重新審核。
7. 完成後從「成果」分頁下載工作副本檔案。Git 模式的任務可在審核後核准合併回專案分支（見 `docs/GIT-WORKFLOW.md`）；部署與對外發送仍由人執行。

## 首次設定精靈

第一次使用的管理者登入後會看到四個步驟的設定精靈，不必先讀 README 才知道下一步：

1. **系統檢查**：直接讀 `/api/system/health`（與平台設定的「系統狀態」同一份資料、
   同一套顯示邏輯），列出 Node、Codex、Claude 與 Browser MCP。這裡沒有第二套
   health checker，也不會安裝、登入或修改任何設定。
2. **專案位置**：沿用既有的 `DirectoryPicker` 與 `/api/admin/project-root`，設定
   `defaultProjectRoot`，沒有另一套檔案選擇器。
3. **AI 模式**：預設「自動選擇（推薦）」。選項與說明來自 `src/task-defaults.js`，
   與建立任務表單、LINE 建立流程是同一組安排。
4. **建立第一個任務**：直接打開既有的建立任務 Modal，不是第二套建立流程。

**什麼時候顯示**：不用「第一次登入」推測，而是由 `server/onboarding.js` 依既有狀態
判斷——已經有 `defaultProjectRoot` 且有專案的既有安裝不會被要求重跑；只有在使用者
完成精靈或選擇「稍後設定」時，才會寫入唯一的新設定 `onboardingCompleted`（布林值，
沒有新資料表、沒有新欄位、也不記錄步驟進度）。精靈只對管理者顯示，因為每一步都
需要管理者權限。

**允許略過**：任何一步都可以「稍後設定」，不會停用任何功能。系統檢查即使有錯誤也
不擋人；環境問題仍由首頁既有的提醒持續顯示，直到問題解決。想再看一次可從
平台設定 →「首次設定精靈」重新開啟，重新開啟不會改動任何既有設定。

## Task Detail 的資訊分層

任務詳情分成四個分頁，把「一般使用者需要的資訊」與「Agent／Developer 技術資訊」
分開；Debug 能力沒有被移除，只是換了位置。分類與狀態推導集中在
`src/task-detail-view.js`，Template 只負責畫出來（測試見
`tests/task-detail-view.test.js`）。

- **概覽**：最上方先列出「需要你處理」的每一件事，再依序放實際的操作區塊
  （manual action、套件環境、成果報告不完整、驗證跳過、操作核准、修正方案核准、
  待確認問題），接著才是任務狀態、原始需求、計畫摘要與驗收條件。
  與「待我處理」列表不同的是：同時成立的待辦會全部列出，不只顯示第一個分類。
- **執行進度**：把 Plan Step 與 Thread Status 組成一份看得懂的步驟清單
  （整理需求 → 核准計畫 → 各執行步驟 → 修正輪次 → Browser 驗證 → 最終驗證），
  每一項標成已完成／進行中／等待你處理／未通過／未驗證／尚未開始。
  狀態只依現有的真實 state 推導，**不顯示任何完成百分比**；無法判斷的一律「尚未開始」。
  沒有任務要求 Browser 驗證時，不會憑空長出那一列。
- **成果**：成果檔案、可確認的驗證證據、Browser 驗證紀錄與發布核准。
- **技術資訊**：Threads、Session ID、Engine、Plan version、Raw Result、
  Browser MCP 詳細資料、Execution Log 與 Events。預設低調呈現，不搶主要視覺。

在「概覽」以外的分頁，若還有待處理事項，頂部會顯示一條可點回概覽的提示；
操作只在概覽提供一份，不重複做第二套按鈕。

`node scripts/preview-task-detail.js` 會在 <http://127.0.0.1:14314> 啟動一份
拋棄式 fixture（暫存 SQLite，帳號 admin／密碼 task-detail-ui-fixture），
內含十種狀態各一個任務，供瀏覽器驗證使用。它不啟動 runner、不呼叫任何引擎、
不送 LINE 通知，一小時後自動關閉並刪除暫存資料。需先 `npm run build`。

## 排程與恢復
- 資料寫入 `data/taskflow.sqlite`。每 2.5 秒檢查任務，每 3 秒更新畫面。
- 先比較優先級，再比較人工排序；同優先級可拖曳或上／下排序。第一版同時一個 AI process，角色有獨立 context 與紀錄，不是同時多工。
- 關閉執行服務／暫停任務：不再派工，當前工作仍可結束。中止則終止 process tree，留下副本供檢查。
- 驗證不通過每輪修正先提出方案並等待使用者核准；登入、額度、格式或權限錯誤會停止並呈現，不無限重試。
- 中途關機後，下次啟動會將中斷工作暫停，需檢查後恢復。不要把未完成檔案當成通過驗收的交付。
- 新任務的工作目錄由 Git 提供：專案不是 repository 時自動 `git init` 並建立安全的初始 commit，接著在 `data/worktrees/<taskId>` 建立 git worktree，從目前分支開出 `taskflow/<id>-<slug>` 分支執行。專案資料夾不會被 Agent 改到，也不會被切換分支；專案有未提交修改、或工作目錄被切到 main 等受保護分支時，任務直接停下等你確認，TaskFlow 不會自動 reset、clean、stash 或 push。每個真的改到檔案的階段結束後會在任務分支上自動 commit（沒有修改就不 commit，機密與執行期檔案不進版）；commit 只保存成果，不代表驗收通過，也不代表可以合併。任務驗證通過後自動流程就停止，由你在審核介面選擇「核准並 Merge」（`--no-ff`，合併前檢查正式分支乾淨且停在 base branch，衝突一律先預檢、不動正式分支）、「要求修改」（沿用同一分支）或「拒絕」（預設保留分支）；合併後可用 `git revert` 撤銷。細節見 `docs/GIT-WORKFLOW.md`。關閉設定 `gitWorkspaceEnabled` 可退回舊版資料夾快照。
- 舊版資料夾快照（既有任務仍沿用）忽略常見秘密檔、.git 與依賴目錄；限制 15,000 檔／250 MB。這不保證辨識所有秘密，請事先整理可信任專案。
- 權限使用 CLI 原生機制，不設定 bypass。Claude 實作／修正／驗證階段預先授權 npm/pnpm/yarn install、npm ci、test，以及 run build/test/lint/typecheck/check/dev/preview，無須逐次確認。規劃階段仍唯讀；未列入的命令會回報需處理。部署、publish、push 不在自動授權清單。規則僅套用 TaskFlow 啟動的工作階段，不修改全域 CLI 設定。套件安裝與專案腳本以目前 Windows 使用者權限執行，僅用於可信任專案；指令清單不是作業系統隔離。

## LINE、動態 IP 與關機收件
`cloud-inbox/README.md` 說明 Worker + D1 收件匣。目前已部署並連上本機；LINE 的兩個秘密值與 webhook 尚待設定，詳見 `docs/CLOUDFLARE-DEPLOYMENT.md`。

本機 `.env` 設定 INBOX_URL 與 INBOX_TOKEN 後，每 10 秒拉取事件，持久化處理後才確認。即使同事件重送也不重複建任務。通知以獨立 outbox 及重試鍵發送，通知故障不重跑 AI。

固定 HTTPS 隧道只需對外提供網頁，LINE webhook 指向雲端收件匣。Windows 主動領取任務，不需固定 IP 或開路由器埠。關機時 LINE 雲端收件可繼續，但完整本機網頁無法使用。

對外開放網頁前設定 PUBLIC_ORIGIN 為固定 HTTPS 網址、COOKIE_SECURE=true，隧道只轉送本機 4310，勿開放 data 資料夾。保持強密碼、使用可信任成員。完成設定後重啟服務。

LINE 目前僅私人對話。網頁設定取得短效 `/link ...` 指令，送給你的 Bot 完成綁定。
綁定後直接點手機聊天底部「任務快捷選單」：發布任務、任務進度、待我審核、工作台。新操作流程不需手打指令或專案代號，詳見 `docs/LINE-QUICKSTART.md`。以下文字指令僅保留相容使用。
```
/task demo 任務標題
詳細需求，至少五個字。

/status
/approve 完整任務ID 計畫版本
/answer 完整任務ID 補充內容
```

## 檔案
- `docs/SPEC.md`：需求、架構與驗收合約。
- `docs/VALIDATION.md`：实际驗證結果與尚未驗證的部分。
- `docs/GIT-WORKFLOW.md`：Git 工作流改造（Phase 1）的行為、守門規則與設定。
- `server/`：資料庫、HTTP API、引擎適配器、排程與 LINE 同步。
- `src/`：Vue 工作台。
- `cloud-inbox/`：由 Claude Code 協作製作的 LINE 雲端收件服務。
- `data/`：本機帳號、資料庫、工作副本（`workspaces/`）、任務分支工作目錄（`worktrees/`）及執行紀錄；不納入版本控制，請定期離線備份。

## 驗證指令
```powershell
npm test
npm run build
node --test cloud-inbox/worker.test.js
# 以下會真正使用已登入 AI 帳號的額度：
node scripts/smoke-ai.js codex
node scripts/smoke-ai.js claude
node scripts/browser-validation-smoke.js
```

UI 版面驗證（不使用任何 AI 額度，不啟動 runner）：
```powershell
npm run build
node scripts/preview-task-detail.js   # http://127.0.0.1:14314
```

## 前端驗證的四個層級（不要混為一談）

TaskFlow 對前端的驗證分四種，彼此不能互相替代：

1. **Build Validation**：`vue-tsc --noEmit && vite build` 成功，只代表型別檢查與打包
   沒有錯誤，不代表頁面在瀏覽器裡能正確運作。
2. **HTTP Validation**：`server/project-preview.js` 啟動本機預覽並回應 200，只代表
   靜態檔案伺服得出來，不代表 Vue／React 有 mount、按鈕可點、互動正確。
3. **Browser Functional Validation**（新）：`requiresBrowserValidation=true` 的任務，
   由 Claude Code 透過 Playwright MCP 實際在 Chromium 開啟 Preview URL、操作 DOM、
   檢查 console／network，見 `docs/BROWSER-VALIDATION.md`。這是目前唯一能證明
   「按鈕真的可點、彈窗真的會開」的方式。
4. **Manual Visual Validation**：像素級、跨裝置的人工視覺驗收，目前仍需要人工用
   瀏覽器實際查看；`browser_take_screenshot` 只作為 Browser Functional Validation
   失敗時的輔助證據，不是像素比對。

「HTTP 200」與「Build 成功」都不能寫成「Browser tested」；只有真的執行了 Browser
MCP 工具（有 `mcp__playwright__browser_*` 的 tool_use 紀錄）才能算。

## 第一版的明確限制
- 雲端收件匣已部署；LINE channel 的密鑰與 webhook 尚待設定，需完成後才能使用真實 LINE。Vue 工作台尚未配置公網隧道。
- 僅限可信任團隊。資料副本、專案授權與 CLI 權限不等於強隔離；執行不可信程式前必須導入專用 Windows 帳號、容器或 VM，不能對外開放任意客戶執行。
- 研究支援文字需求與參考 URL，成果透過檔案交付；尚無附件上傳、Office 預覽或瀏覽器代理。
- thread 以平台保存的角色與上下文為準，顯示可取得的 CLI session ID；不保證出現在 Codex 桌面 App 的側欄。
- 任務驗證有獨立 AI 角色與證據紀錄，但 AI 回報不是正確性的絕對保證。重要成果仍需人工複核。
- 無任意自動部署、git merge/push 或對外傳送功能。網站的「核准交付」是紀錄，不宣稱已發布。
- WebMCP 僅在支援的瀏覽器註冊開啟表單操作；不支援時不影響一般使用，尚未做支援環境的功能驗證。

## 專案資料夾與本機網頁預覽

平台設定 → 可用專案，可選擇「原始專案」或任務工作副本，再按「開啟資料夾」或「啟動並開啟網頁」。預設選取可預覽的 AI 工作副本，避免原始資料夾仍為空白時看不到成果。

Vue／Vite 專案會在選定資料夾缺少 node_modules 時執行 npm install，再執行 npm run build，並提供 dist/index.html 的本機預覽；純 HTML 專案直接預覽。其他框架與自訂輸出資料夾目前不支援。安裝／建置失敗會顯示錯誤，不會顯示假成功。

預覽僅監聽 127.0.0.1，使用自動分配的可用埠，不對外部署。同一份成果重複點擊會重用網址；按「停止預覽」可關閉，之後再次啟動會重新建置。TaskFlow 關閉後預覽也會結束。下載套件與執行專案腳本僅適用可信任專案。

## Cloudflare 外部網站（2026-09-16）

執行 `Start-Public-TaskFlow.ps1` 會建立 Quick Tunnel，更新 `.env` 的 PUBLIC_ORIGIN、啟用 Secure Cookie，並重啟 TaskFlow。若 AI 正在執行，會停止此操作，請完成任務後再試。已在運作的 Tunnel 會重用。

目前網址記錄在 `data/public-url.txt`。`Stop-Public-TaskFlow.ps1` 只停止對外轉發，本機網站保留。電腦必須保持開機、不休眠；重新建立 Tunnel 時網址會改變，目前未設定開機自動啟動。若需固定網址，改用自有網域與 Named Tunnel。

外部使用原有 TaskFlow 帳號登入。此轉發開放 TaskFlow 平台；專案的獨立 localhost 預覽網址仍僅供伺服器本機使用。

驗證：公開 HTTPS 首頁及 JS/CSS 回應 200；未登入的 /api/state 回應 401；外部登入請求通過來源檢查，錯誤密碼回應 401；來源設定測試 2/2 通過。現存首次登入檔內的憑證未通過登入（可能已修改），未變更帳號密碼，也未宣稱實際帳密登入驗證成功。

## LINE 一般對話與文字操作

已連結的 LINE 使用者可直接聊天。未命中指令且非標題／需求／回答輸入的文字，會交給目前設定的 Chat Provider 回覆：可在「平台設定 → AI 模型 → Chat 模型」切換 Codex 或 Claude，並各自指定模型。設定存在 TaskFlow 資料庫，儲存後下一則訊息就生效，不需要重新啟動服務；執行中的對話會用原本的設定跑完。兩者都使用本機 CLI 既有的登入額度，不需要另設 API 金鑰，本機必須開機並完成該 CLI 的登入。

沒有在後台設定時，依序沿用 `.env` 的 `CHAT_PROVIDER`、`CHAT_MODEL_CODEX`／`CHAT_MODEL_CLAUDE`，以及舊的 `LINE_GPT_MODEL`（僅 Codex，legacy fallback）；都沒有就是 Codex 加上該 CLI 的預設模型。後台會顯示兩個 CLI 是否可用；選定的 Provider 不可用時，LINE 會收到指名該 Provider 的錯誤訊息，系統不會自行改用另一個 AI。Chat 設定與任務執行引擎（Planner／Backend／Frontend／Validator）的安排互不影響。

可全程以文字發布：`建立任務` → 選專案（一般成員回覆名稱或代號；管理者預設新建，也可回覆 `改用既有專案`）→ `程式開發` 或 `研究與文件` → 標題 → 需求 → `確認發布`。核准流程：`待我審核` → 回覆編號（如 `1`）→ 閱讀計畫 → `核准執行`。支援 `核准`、`同意執行`、`確認執行`，僅適用最近查看且未過期的同一計畫版本。`修改需求` 可進入補充流程。`主選單` 或 `取消` 離開流程。

一般聊天與任務操作分流：Chat 不直接修改平台或核准任務；文字操作由平台依權限、狀態及計畫版本驗證。正在填寫標題、需求或補充時，文字視為表單內容。需要聊天可先回覆 `取消`。其餘選項階段的非指令文字可聊天，流程仍保留。

聊天訊息及回覆保存在本機 SQLite 的 line_chats；模型只收到該使用者最近 24 小時內最多 6 輪已完成的聊天，不讀取專案或其他帳號資料。兩個 Provider 都在唯讀、無工具、無 MCP 的純文字沙箱執行：Codex 用 `--sandbox read-only` 並停用 shell／browser 等工具，Claude 用 plan 權限模式、空的 MCP 設定、不讀取個人設定，並以 `--disallowedTools` 移除 Bash／Read／Write／Edit／WebSearch 等全部內建工具。每人最多 3 則等待／執行中訊息，每分鐘最多 10 則，單則最多 4,000 字，90 秒逾時。訊息去重、回覆出庫與完成狀態具備交易保護；重新啟動會恢復未完成訊息，但中斷時的模型呼叫可能重做。既有 LINE 雲端收件與推送設定沿用。

## 移除專案與磁碟檔案

管理者可在「平台設定 → 可用專案 → 移除專案」查看刪除範圍，再輸入專案代號確認。此操作永久刪除原始資料夾、全部版本的 AI 工作副本、執行紀錄、任務／活動紀錄及成員授權，不經資源回收筒。現有資料夾中手動加入的檔案也包含在內。

執行中任務、正在建置或尚未停止的預覽、共用同一資料夾或刪除範圍內包含其他專案的資料夾、平台與系統路徑、路徑中的 Junction／符號連結均會阻擋移除。請先暫停任務並等待結束；「停止所有預覽」會停止此專案全部版本的預覽。

刪除先暫存資料夾並交易式清理資料庫；交易失敗會還原資料夾。若磁碟清理因檔案占用失敗，畫面會列出尚待清理的暫存路徑，操作紀錄保留於 `data/deletions`。若電腦在移除途中突然關機，應依該紀錄人工確認與復原，不應直接刪除不明路徑。

移除子專案時，即使上層資料夾也登錄為專案，仍可只刪除選定子資料夾。上層、同層其他專案與其登錄紀錄會保留；平台根目錄及預設專案存放位置仍不可刪除。

## 同一帳號綁定多個 LINE

「平台設定 → LINE 連結管理」可新增多個 LINE 帳號，逐一命名、查看綁定／最近使用時間、切換任務通知及解除連結。每個 LINE 只能屬於一個 TaskFlow 帳號；各 LINE 共用該帳號的角色與任務權限，但任務填寫、審核上下文和一般聊天歷史彼此隔離。

新增連結不會覆蓋既有綁定。每次連結碼有效 10 分鐘、限用一次；重新產生會撤銷前一組未使用的碼，也可手動取消。任務通知預設發送至所有開啟通知的已綁定 LINE；關閉通知影響後續新增的任務通知，不影響直接操作回覆。

解除只影響該 LINE，會取消其尚未發送訊息、進行中的聊天結果及操作流程；其他 LINE 與既有任務保留。已經送到 LINE 的訊息無法收回。解除後重新綁定會建立新的連結身分，舊聊天結果不會送到新連結。

舊版單一綁定及其進行中的操作流程會在服務啟動時遷移。管理功能僅管理目前登入帳號自己的 LINE 連結。

## Claude 額度限制自動重試

Claude 回報 session／usage／weekly limit，且訊息包含可辨識的 `resets 3:50pm (Asia/Taipei)` 時，任務會切換為「等待額度恢復」。系統依回報的時區換算，於重置時間加 30 秒後重新派工，避免重置邊界尚未生效。時間僅包含時分時，以錯誤發生當下往後最近的該時間計算；格式或時區不明則保留錯誤，不猜測時間。

等待時間持久化在資料庫，服務重啟後仍保留；需要電腦開機、TaskFlow 服務運作且自動領取任務已啟用。若服務在指定時間未運作，重新啟動後會執行已到期的重試。等待不占執行名額，其他使用相同 Claude 引擎的工作會一起等待，Codex 工作仍可繼續。

重試沿用原本工作副本、核准版本與修正輪次，只重新執行受阻的當前步驟（該步驟若已產生部分檔案，會保留）。規劃重試成功後仍需正常審核，不會自動核准。手動暫停、取消或完成會取消該任務的自動重試。畫面與 LINE 任務详情會顯示預計重試時間。


## 驗證失敗後先審核修正方案

獨立驗證未通過（含缺乏驗證證據或仍有待確認事項）時，先進入「分析修正方案」。規劃引擎只能唯讀分析，根據驗證報告提出問題、原因、解法、修正步驟與重新驗證標準，接著進入「待審核修正方案」。

任務擁有者或管理者可在網頁核准此版修正方案，或先補充／修改方案，重新產生後再次審核。LINE 的「待我審核」也會列出修正方案，可先查看後回覆「核准修正方案」；內容過長時引導至網頁審核。未解答的方案問題會阻擋核准。核准綁定方案識別碼、計畫版本與修正輪次，舊按鈕、重複核准、手動恢復任務都不能跳過此關卡。

只有核准後才會由執行引擎修正，然後再次獨立驗證。再次失敗會產生新的修正方案，重新等待審核；不再自動連續修正兩輪。額度等待與服務重啟不會替使用者核准方案。


### LINE 服務恢復

已綁定的管理者可私訊 Bot「重啟服務」（或 `/restart`）。獨立的
`server/service-guardian.js` 從既有雲端收件匣收取指令，恢復失效的 TaskFlow
或 Cloudflare 通道，確認本機與公開網址可連線後，回覆最新網址。
正常服務不會因重複指令被強制重啟；有 AI 正在工作的存活程序不會被強制中斷。
已綁定成員可傳「最新網址」（或 `/url`）查詢，查詢不啟動服務。

執行 `Start-Service-Guardian.ps1` 可啟動守護程式；桌面啟動器及公開啟動器
也會啟動它。守護程式獨立於主服務，使用本機 4311 埠防止重複執行。
電腦必須開機、保持喚醒、有網路，守護程式與雲端收件匣均需可用。
關機或休眠無法由 LINE 開機；超過 15 分鐘的服務指令會要求重新傳送。

普通 LINE 訊息會先保存到本機 `cloud_relay`，再確認雲端收件；主服務恢復後
繼續處理。服務指令會去重、執行時再次檢查管理者與綁定、通知重送使用固定
LINE retry key。解除綁定後不再傳送舊連結的網址。錯誤紀錄位於
`data/service-guardian-error.log`；恢復失敗不會回傳未確認的網址。

此電腦已註冊排程 `TaskFlow-ServiceGuardian`：登入 Windows 時啟動，每分鐘檢查守護程式是否存活。電腦仍須保持登入及喚醒。

重新安裝上述排程可執行 `Install-Service-Guardian.ps1`。新通道若尚未在本機 DNS 解析，恢復程式會以公開 DNS 回答確認同一 HTTPS 網址，保留憑證驗證，不修改系統 DNS。


### 回傳格式與套件環境保護

每份 AI 結果先經完整欄位與型別驗證。格式錯誤最多進行兩次本機、確定性的
純格式修復（JSON/單層包裝解析、既有字串轉單元素陣列、true/false 字串轉布林），
不重新呼叫執行引擎、不新增缺失的內容、不改驗收條件。
原始結果與兩次修復紀錄存於該工作階段的 data/runs 目錄。
仍不完整時進入 Deterministic Result Recovery：只讀已存在的原始回傳，
summary 必須來自原始輸出、evidence 只取「指令＋結果」形式的敘述、
passed 未知一律 false，沒有 adapter 可用，結構上不可能重跑任何角色。

還原不成功時任務顯示「成果報告不完整」，說明 TaskFlow 已保留原始 AI 回傳、
已完成進度、工作副本與執行紀錄，並列出目前仍缺少的內容（例如「工作摘要」、
「可確認的驗證證據」）；Zod 原始訊息只出現在「技術資訊」裡。
使用者可以「查看原始回傳」，或「補充需求並重新規劃」（明確說明那是新計畫，
不是單純格式修復）。尚未自動還原過的問題會另外提供「重新整理成果報告」，
對應 `POST /api/tasks/:id/output/recover`：該路徑只執行 deterministic recovery，
不呼叫任何引擎；成功後清除問題並依原本流程繼續下一個安全階段，
還原結果 passed=false 不會直接標記完成，仍走既有的驗證／修正流程。
一般錯誤或額度限制不會被當成格式問題重試。

程式任務若使用套件或具有 package.json，執行每一步前由同一執行引擎檢查
npm 工具、既有 registry 可達性與安裝政策，並檢查工作副本寫入權限。
環境檢查不安裝套件、不更改 registry 或權限。不通過就停止本次工作，
顯示證據與處理方案；使用者按「環境已處理，核准重新檢查」後才重查，通過才繼續。
方案或步驟改變會重新檢查。更換套件或自製替代實作需改計畫並重新審核。
平台不保證外部模型／網路永不失敗，也不把前置檢查當成最終安裝成功的證明。
