# TaskFlow：本地 AI 任務平台

## 已確認需求
- Windows 為主執行環境；Vue 3、TypeScript、Vite 前端，LINE 與網頁均可發任務。
- 少量受邀成員；成員審核自己的任務，管理者分配專案與工具權限。
- 支援程式開發與研究文件；Claude Code 預設規劃／研究，Codex 預設程式實作，另一引擎驗證，可於規劃前調整。
- 沿用本機 CLI 登入；不自動轉 API 計費。不要求固定 IP。
- 根節點拆解需求、驗收與角色，核准指定版本後才派工。各 thread 保存獨立上下文及輸出。
- 任務台顯示狀態、活動、依賴與成果；排序控制下一次派工，不搶斷執行中的工作。
- 驗證失敗回到修正；需要人決策則提問等待；修正上限後暫停。完成比例以完成子任務計算，不能表示任意 AI 思考百分比。
- AI 可產出與驗證；對外發布需獨立審核，不因需求審核而自動授權。

## 部署與邊界
本機 Node.js 24 服務 + SQLite WAL + Vue 工作台，僅監聽 127.0.0.1。雲端收件匣為獨立 Cloudflare Worker + D1，保存已驗簽的 LINE 事件；本機經 HTTPS 拉取、入庫後確認。Cloudflare Tunnel 可提供固定 HTTPS 網域至本機網頁。關機時雲端仍收件，完整網頁與 AI 執行暫停。雲端部署、網域與 LINE channel 設定需要使用者提供帳號，交付程式不代表已部署。

## 第一版實作決策
- 同時一個 AI process；不同任務依優先級與人工順序輪流派工，未來可增加隔離 runner。角色對話彼此獨立，不能以對話數假裝並行。
- Express REST API，前端輪詢每 3 秒讀取可見資料與事件，避免隧道斷線遺失狀態。
- 資料表：users、sessions、projects、memberships、tasks、threads、events、inbox、outbox、settings。
- 任務狀態：planning、awaiting_approval、queued、running、waiting_input、paused、completed、failed、cancelled。thread 狀態：queued、running、completed、failed。
- 執行環境的核准／sandbox／allowlist／權限政策阻擋（例如 CLI 回報 requires approval、sandbox denied、not in allowed list）不是一般程式失敗：偵測後任務維持 `waiting_input`，但 API 回傳的 decorated task 另外帶出 `displayStatus:'waiting_user_action'`（UI／Reviewer 應以此欄位判斷，不得視為 failed，也不得自動重試同一指令）。`task.userActionRequired` 保留 reason、commands、workingDirectory、message（原始 stderr／工具證據）、instructions 等欄位供人工操作與後續稽核；使用者回報「已完成」後只重新進入獨立驗證，不直接視為通過。
- 規劃結果必須通過 JSON schema；包含目標、驗收、待確認問題、子任務（角色／引擎／依賴）。子任務序列執行，驗證是獨立 thread。
- 核准綁定 planVersion；修改需求會使舊核准失效。執行中不可直接改需求或引擎，需先停止。
- 暫停停止新派工，當前工作可結束；中止終止 process tree 並將任務轉為需檢查狀態。重新啟動將 interrupted 工作標為等待處理，不盲目重放未知外部副作用。
- 最多 2 輪自動修正；單次引擎最多 30 分鐘；限制輸出大小。額度、登入或權限錯誤回報失敗，不無限重試。
- 計畫階段僅讀取；程式任務在 Git 工作目錄執行：專案非 repository 時自動建立版本庫與安全的初始 commit，任務在 `data/worktrees/<taskId>` 的 git worktree 內於 `taskflow/<id>-<slug>` 分支上工作（既有任務沿用舊的快照工作區，快照排除 .git、node_modules、.env、憑證等）。不修改原專案、不自動合併或發布。專案有未提交修改、位於上層 repository 內、或工作目錄不在該任務分支上時，任務停在 waiting_input 等待人工確認；`git reset --hard`、`clean`、`push`、`stash`、`restore`、`branch -D` 一律不由自動化流程執行。每個有檔案修改的階段結束後在任務分支上 commit（無修改不 commit，機密與執行期檔案排除，引擎失敗的階段也保存已寫出的檔案）；commit 只保存開發成果，不代表 passed=true，也不代表可以合併。驗證通過後自動流程停止，由使用者選擇核准合併（`git merge --no-ff`，前置檢查：確實通過獨立驗證、成果版本相符、正式分支乾淨且已停在 base branch；TaskFlow 不替使用者切換分支）、要求修改（沿用同一分支）或拒絕（預設保留分支）。合併衝突一律先預檢，正式分支不會被留在解到一半的狀態，TaskFlow 不自行決定 ours／theirs。合併後可 `git revert` 撤銷，成果核准同時失效。舊工作副本可由使用者主動轉入 Git，原資料夾一律保留。工作區隔離不是 OS 安全沙箱；第一版限定可信任成員與可信任專案，外部客戶執行需容器／VM。
- 密碼 scrypt 雜湊、隨機 HttpOnly session cookie、Origin 檢查、所有 API 驗證使用者及任務／專案歸屬；只有管理者可新增成員與本機路徑。
- 不自動啟用 AI 執行。管理者配置專案、確認本機 CLI 登入並開啟 runner；未設定時任務排隊且 UI 明示原因。
- LINE 僅支援私人對話；用一次性短效連結碼綁定既有成員。指令：/task 專案代號 標題換行需求、/status、/approve 任務ID 版本、/answer 任務ID 回覆。訊息、審核與通知均需對應成員，不接受群組操作。
- LINE webhook event ID 去重；雲端確認機制允許重送，本機 inbox 同交易保存處理紀錄與任務。通知 outbox 獨立重試，通知失敗不重跑 AI。
- 發布介面只記錄對特定成果版本的核准與待人工交付，不提供任意 shell 部署入口；正式自動發布需另外配置目標適配器。

## UI / UX
深藍灰工作台、青綠重點色、側欄導覽、清楚空白狀態；提供總覽、任務佇列、所有 threads、設定。任務抽屜呈現需求／計畫／角色／活動／成果。新增任務表單支援專案、類型、優先級及引擎。拖曳及上／下按鈕均可排序，手機使用按鈕。狀態與進度必須源自資料庫，無預填假任務或假用量。

## 驗收
1. 建立任務→規劃→審核指定版本→執行→驗證→成果，狀態及紀錄重啟後保存。
2. 舊版本核准、跨成員存取、非法狀態操作、未授權專案、未登入 API 被拒絕。
3. 優先級與排序影響下一次領取，暫停及取消不再派工。
4. 問題回答使需求更新並重新規劃；驗證失敗最多修正兩輪。
5. 突然關機或 process 中止後需人工確認恢復，不顯示為成功。
6. 相同 LINE 事件重送只產生一筆任務；簽章不合法不得入庫；通知故障獨立重試。
7. 前端型別檢查與正式建置、API 整合測試通過；真實 AI／LINE 驗證分開記錄，不能以測試 adapter 通過代替。

## 外部設定需求
### LINE 快捷操作更新（2026-09-16）
已新增預設 rich menu、Quick Reply、持久化 30 分鐘的逐步發布流程。發布、查詢、版本審核與需求補充皆可點選進入，使用者只輸入標題及實際需求。舊指令保留相容。按鈕使用 postback，伺服器每次重新檢查身分、專案權限、流程狀態及計畫版本；完整操作及部署證據見 `LINE-QUICKSTART.md`。

LINE Messaging API channel secret/token；Cloudflare 帳號與 D1 資源；固定網址（網域或可提供固定網址的隧道服務）；本機兩個 CLI 登入。所有秘密存環境變數或本機忽略檔，不填進聊天或版本庫。
