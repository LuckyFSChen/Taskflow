# Phase 8（首次啟動 Wizard）Regression Report

日期：2026-09-18
實作環境：Claude 雲端容器（Node 22）＋ F:\TaskFlow 檔案橋接
**本機（Windows、Node 24）上的 `npm test`、`npm run build` 與真實 Browser Validation 尚未執行**，原因見「受環境限制」。

---

## 1. 這個階段改了什麼

### 新增
| 檔案 | 內容 |
| --- | --- |
| `server/onboarding.js` | 設定狀態的唯一判斷處：`onboardingStatus` / `completeOnboarding`。純讀取，不修復也不安裝。 |
| `src/onboarding-view.js` | 精靈的顯示邏輯（步驟、可否繼續、第一步要顯示哪些檢查）。沿用既有 health 與 task-defaults。 |
| `src/OnboardingWizard.vue` | 四步驟對話框。第二步用既有 `DirectoryPicker`，第四步打開既有建立任務 Modal。 |
| `tests/onboarding.test.js` | 設定狀態與 API 權限測試。 |
| `tests/onboarding-view.test.js` | 顯示邏輯測試，並把「沿用既有模組」釘死。 |
| `docs/PHASE8-REGRESSION.md` | 本檔。 |

### 修改
| 檔案 | 內容 |
| --- | --- |
| `server/app.js` | `/api/state` 加 `onboarding`；新增 `POST /api/onboarding/complete`（管理者限定，body 必須是空物件）。 |
| `server/system-health.js` | 新增 `runtimeCheck`（Node 版本），放進既有報告的第一項。沒有第二套 checker。 |
| `src/system-health-view.js` | 新增 `Runtime` 分組與 `Node` 標籤。 |
| `src/store.ts` | 新增 `onboarding` 狀態與 `completeOnboarding()`。 |
| `src/App.vue` | 掛載精靈、把第四步接到既有建立任務表單、平台設定新增「首次設定精靈」重新開啟按鈕。 |
| `tests/system-health.test.js` | 補 runtime 檢查測試；固定 `nodeVersion` 讓報告不隨測試機 Node 版本改變。 |
| `tests/system-health-view.test.js` | 更新分組順序斷言。 |
| `README.md` | 新增「首次設定精靈」章節。 |

### 需求對照
| 需求 | 實作 |
| --- | --- |
| 四步驟 | `ONBOARDING_STEPS`：系統檢查 → 專案位置 → AI 模式 → 建立第一個任務 |
| Step 1 reuse `/api/system/health` | `systemCheckItems()` 直接吃 `healthGroups()` 的結果；測試會比對兩者完全相同 |
| 不要第二套 health checker | Node 檢查加進**既有** `server/system-health.js`，平台設定的系統狀態也會一起顯示 |
| Step 2 reuse DirectoryPicker / defaultProjectRoot | 直接用 `DirectoryPicker.vue` 與 `POST /api/admin/project-root` |
| Step 3 預設「自動選擇（推薦）」 | 選項與說明來自 `src/task-defaults.js`（與建立任務表單、LINE 流程同一組） |
| Step 4 導向既有 Modal | 精靈 emit `create-task` → App.vue 設定 `showNew=true`，沒有第二套建立流程 |
| 不靠「第一次登入」推測 | 由 `defaultProjectRoot` + `projects` + 明確旗標判斷 |
| 只新增很小的 `onboardingCompleted` | 一個布林 setting；無新資料表、無新欄位、不記錄步驟進度 |
| 允許「稍後設定」 | 任何一步都可略過；system health 有 error 也不擋人 |
| Error 時 Dashboard 繼續提醒 | 沿用既有 `healthAlert()` 首頁提醒，精靈不會把它關掉 |

### 一個刻意的設計決定
`onboardingCompleted` 只在使用者**按下**「完成」或「稍後設定」時才寫入。
已經有 `defaultProjectRoot` 且有專案的既有安裝，會被推導為「設定過了」而不顯示精靈，
但**不會**因此偷偷寫入旗標（測試有釘住這點）。

---

## 2. Regression 狀態

### ✅ 已驗證通過

**自動化測試**
| 項目 | 結果 |
| --- | --- |
| `npm test`（本機 Windows / Node 24，使用者執行） | **305 通過 / 0 失敗** |
| `npm run build`（`vue-tsc --noEmit && vite build`） | **通過**（重建後的 bundle 已含精靈並實際載入，畫面無 JS 錯誤） |
| 雲端容器先行驗證 | `onboarding-view` 10/10、`onboarding`（非 API 部分）6/6、`system-health` 13/13、`system-health-view` 19/19 |

**伺服器（重啟後實測）**
| 項目 | 結果 |
| --- | --- |
| `/api/system/health` | checks 為 `runtime, runner, codex, claude, browser, projects, line`；`runtime` = 「Node 24.15.0 可使用」；整體 `ok` |
| `/api/state` 帶出 `onboarding` | `{completed:true, configured:true, dismissed:false, show:false}` — 既有安裝不會被要求重跑精靈，**且沒有偷寫旗標** |
| `POST /api/onboarding/complete` | 管理者呼叫成功，`dismissed` 由 false → true |

**首次設定精靈（Browser Validation，實機操作）**
| # | 檢查 | 結果 |
| --- | --- | --- |
| 1 | 平台設定 →「首次設定精靈」卡片與開啟按鈕 | ✓ 顯示「這個工作空間已完成首次設定。」 |
| 2 | 第一步四項檢查 | ✓ Node 24.15.0 / Codex 0.155.0-alpha.9 / Claude 2.1.276 / Playwright MCP，文字與平台設定「系統狀態」逐字相同 |
| 3 | 第二步顯示既有存放位置 | ✓ `F:\TaskFlow\Projects`，標示「已設定」 |
| 4 | DirectoryPicker 疊在精靈上（巢狀 modal） | ✓ 兩層皆為 modal、焦點在選擇器內、磁碟與資料夾清單正常；**取消後 `defaultProjectRoot` 未變動** |
| 5 | 第三步預設模式 | ✓ 「自動選擇（推薦）」為選取狀態，說明為「規劃 Claude Code · 執行 Codex · 驗證 Claude Code」 |
| 6 | 第四步 →「建立第一個任務」 | ✓ 精靈關閉、**既有**建立任務 Modal 開啟、專案為「依任務標題建立新專案」、AI 模式沿用第三步 |
| 7 | 完成後重新整理 | ✓ 精靈不再自動跳出；平台設定可重新開啟 |
| 8 | 「稍後設定」 | ✓ 關閉並記錄決定 |
| 9 | Esc（`@cancel`） | ✓ 以原生 `cancel` 事件驗證：preventDefault → 記錄 → 關閉（實體按鍵見「未驗證」） |
| 10 | 步驟狀態列 | ✓ 已完成／目前／未完成標示正確 |

**主流程 Browser Validation（真實任務，使用者核准後執行）**

任務：`Phase 8 驗證任務：建立 README.md`（研究與文件，自動模式 → claude / claude / codex）

| 階段 | 結果 |
| --- | --- |
| 登入 → Dashboard | ✓ 指標、任務動態、需要你的處理、服務連線皆正常；系統狀態 ok 時不顯示紅色提醒 |
| System Health | ✓ 見上 |
| 建立任務 | ✓ 依任務標題建立新專案於 `F:\TaskFlow\Projects`；引擎依任務類型自動安排 |
| Planning | ✓ `planning` → `awaiting_approval`，計畫 v1（1 步驟、4 條驗收條件、0 待確認問題） |
| Approval | ✓ 使用者核准 v1 → `queued` → `running` |
| Execution | ✓ 工程師（claude）完成步驟 1 / 1 |
| 額度限制情境（非預期但實際發生） | ✓ 獨立驗證 codex 撞到用量上限 → 自動改由 claude 完成驗證，任務未失敗 |
| Validation | ✓ `passed: true`，證據含 `cat README.md` 與 `find . -type f` 實際輸出 |
| Completed | ✓ 狀態「已完成」，`artifactVersion` 已產生 |
| Artifacts | ✓ 成果分頁列出 `README.md` 與 `.taskflow/handoff.json`；下載內容正確（含「TaskFlow」與「2026-09-18」）；未新增其他檔案 |
| 需要人工介入情境 | ✓ 以既有「成果報告不完整」任務驗證：Attention Center 分類、詳情「需要你處理」清單與處理選項皆正常（未觸發任何處理動作） |
| `/attention`、`/tasks`、`/threads`、`/settings` | ✓ 四頁皆正常渲染 |

### ❌ 未驗證
| 項目 | 說明 |
| --- | --- |
| 全新安裝時精靈「自動跳出」 | 這個工作空間已設定完成，`show` 必為 false。自動顯示邏輯由單元測試與 live `onboarding` payload 佐證，但未在真實乾淨安裝上重現（需清空的 `data/`） |
| 成員（非管理者）視角 | 此工作空間只有管理者帳號；「成員不顯示精靈」僅由測試與後端 `canConfigure:false` 佐證 |
| Esc 實體按鍵 | 自動化送出的按鍵未觸發（Claude 視窗當時未在前景，畫面未重繪）；事件層行為已驗證，建議手動按一次確認 |

### ⚠️ 受環境限制
| 項目 | 說明 |
| --- | --- |
| 本機 shell | `F:\TaskFlow` 無法掛載到我的工作環境，`npm test` / `npm run build` / 重啟皆由使用者執行並回報 |
| 容器套件安裝 | npm registry 403，`express`/`zod`/`vue` 無法安裝，故 API 測試與 build 無法在容器先行驗證 |
| LINE 通知 | 3 則通知因雲端收件服務 502（LINE HTTP 429）待重試——既有狀況，與 Phase 8 無關 |

### 🙅 人工略過
| 項目 | 理由 |
| --- | --- |
| 不新增資料表／欄位／步驟進度 | 需求要求「不要建立複雜 Schema」，只加了一個布林 setting |
| 不寫第二套 health checker、不做第二套檔案選擇器與建立任務流程 | 全部 reuse 既有實作 |
| 精靈不替使用者啟用服務、不選路徑、不安裝任何東西 | 測試釘住，實機亦確認取消後設定未變 |
| 核准計畫由使用者自己按 | 不代按會觸發 AI 執行的確認動作 |

---

## 3. 後續事項

1. **測試用專案可以刪**：`Phase 8 驗證任務：建立 README.md`（`F:\TaskFlow\Projects\Phase 8 驗證任務：建立 README.md`）只是這次驗證產物，可從 平台設定 → 可用專案 → 移除專案 清掉。
2. **Codex 額度**：Codex 回報用量上限到 2026-09-23；期間 reviewer 會自動改用 Claude（本次已實測可行）。
3. **未驗證的三項**：若要補齊，最省事的方式是用一份乾淨的 `data/` 啟動一次（可驗證自動跳出），並建立一個成員帳號登入看一次。

---

## 4. 已知風險（更新）
1. ~~`OnboardingWizard.vue` 未經 `vue-tsc` 檢查~~ → 已隨 `npm run build` 通過。
2. ~~巢狀 `<dialog>` 的焦點與行為~~ → 已實機驗證：兩層 modal、焦點正確、取消不影響既有設定。
3. `/api/state` 每 3 秒輪詢會多算一次 `onboardingStatus`（兩個很小的 SQLite 查詢），沒有額外行程或 CLI 呼叫。
