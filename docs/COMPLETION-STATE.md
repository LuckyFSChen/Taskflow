# Authoritative Completion State

目標：把「completed／passed」的最終判定從「AI（Executor／Reviewer）自己回報 `passed`／
`completed`」收斂成「由 TaskFlow 依既有 deterministic evidence 重新核算」，讓 AI 的自我
宣稱只是一份 claim，不能單獨成為 TaskFlow 的最終狀態。

## 核心原則

`server/completion-state.js` 的 `reconcileCompletionState(context)` 是唯一的權威判定
入口：

- **純函式，不做任何 I/O**：不讀寫檔案、不呼叫 Git、不呼叫 HTTP、不重新執行任何工作
  （不重跑測試、不重新呼叫 AI）。只讀取呼叫端已經算好、放進 `context` 的證據。
- **AI 的回報只是一項 claim**：`context.executorResult`（Executor／Reviewer 回傳的
  `passed`／`questions`／`evidence`／`summary`）與其餘 Git／測試／部署／驗收證據放在同一
  層級重新核算，不會因為 `passed:true` 就直接判定完成。
- **缺席不是失敗，也不是通過**：任一證據類別在 `context` 裡缺席（舊任務資料、尚未跑到
  那個階段）一律視為「不適用／尚未執行」，寫進 `warnings`，不會單獨促成 `failed`，也
  不能單獨促成 `completed`——`completed` 需要「其餘必要類別都通過或不適用，且沒有任何
  阻擋」。

## 這個模組取代／包住的既有判斷路徑

在 `server/completion-state.js` 檔案開頭的註解裡列出了目前串接的五個既有判斷點，供之後
新增呼叫點時逐一比對：

1. `server/runner.js` 的 `applyPhaseResult()` review 分支：原本只看
   `result.passed && result.evidence.length && !result.questions.length`，現已改為呼叫
   `reconcileCompletionState`。
2. `server/completion-pipeline.js` 的各 stage handler（`testStage`／`mergeStage`／
   `testMainStage`／`restartStage`／`validateStage`／`pushStage`／`cleanupStage`）與
   `advanceCompletion()`：階段推進邏輯與 `task.completion.status` 本身不變，但
   `completionPublic()` 現在會附加 `reconcileCompletionState` 算出的統一欄位。
3. `server/git-review.js` 的 `mergeDecision()`：把 `task.status==='completed'` 當成合併
   前置條件，這個語意不變——它依賴的正是第 1 點 review 分支呼叫
   `reconcileCompletionState` 之後留下的結論。
4. `server/completion-test.js`／`completion-validation.js` 的 `report.status`／
   `verdict`／`passed`：是本模組 `tests`／`runtime` 證據的來源，本身不變。
5. `server/manual-action.js` 的 `decideManualAction()` skip 分支：使用者略過手動操作時
   直接把 `task.status` 設為 `'completed'`，這個既有的人工決定路徑不變（使用者主動跳過
   驗證是明確的人工決策，不是 AI 自我宣稱）。

## 輸出契約

```ts
{
  status: 'running' | 'awaiting_user' | 'conflicted' | 'testing' | 'awaiting_approval'
        | 'merging' | 'deploying' | 'verifying' | 'completed' | 'failed' | 'blocked';
  passed: boolean;           // 只有 status === 'completed' 時才可能是 true
  blockingReasons: string[]; // 阻擋完成的具體原因，可直接顯示給使用者
  warnings: string[];        // 不擋完成，但值得提醒的事（例如某類證據不適用／尚未執行）
  evidence: string[];        // 支持通過的具體 deterministic 依據
  nextAction: string;        // 對應 status 的固定說明文字，告知下一步在等什麼
}
```

`passed === true` 的唯一條件是 `status === 'completed'`：也就是沒有任何
`blockingReasons`，且不在 `running`／`testing`／`merging`／`deploying`／`verifying` 等
仍在進行中的中繼狀態。`blockingReasons`／`warnings`／`nextAction` 一律是純文字說明
（衝突檔名、新失敗的測試名稱、階段訊息……），不含伺服器磁碟路徑或機密，可以直接對外
顯示。

### 十一種狀態的判定依據

| status | 觸發條件 |
| --- | --- |
| `conflicted` | `git.gitConflict` 存在（Git 合併會產生衝突） |
| `testing` | `tests.completionTest`／`completionMainTest` 仍在執行，或部署管線正在跑 `test`／`test_main` 階段 |
| `merging` | 部署管線正在跑 `merge` 階段 |
| `verifying` | 部署管線正在跑 `validate` 階段，或 `runtime.completionValidation` 仍在執行 |
| `deploying` | 部署管線在跑其餘階段（`restart`／`push`／`cleanup`） |
| `running` | 部署流程已核准但尚未進入特定階段 |
| `awaiting_approval` | `pendingActions.repairApproval` 為真（修正方案待核准） |
| `awaiting_user` | `pendingActions` 裡的 `gitIssue`／`userActionRequired`／`outputIssue`／`questions` 任一為真 |
| `failed` | 有 deterministic 證據證明未成功：測試 regression、部署階段失敗、部署驗收未通過、Browser Validation 未通過 |
| `blocked` | 沒有上述 deterministic 失敗證據，但 claim／evidence 仍不足以判定完成（例如完全沒有 `executorResult`） |
| `completed` | 其餘必要類別都通過或不適用，且沒有任何 `blockingReasons` |

`executor` 自己回報 `passed=false`／有待確認問題／缺 `evidence` 只會被歸類為
`blocked`（尚未證實），不會被誤標成 `failed`；`failed` 保留給有明確 deterministic 證據
的情況（測試 regression、部署失敗、驗收未通過等），這樣呼叫端才能區分「需要修正」與
「等待補足證據／處理阻擋事項」。

## Context 的證據來源

`reconcileCompletionState(context)` 只接收已經算好的證據物件，不含任何 I/O 或重新執行
邏輯：

| context 欄位 | 來源 | 說明 |
| --- | --- | --- |
| `executorResult` | Executor／Reviewer 回傳的 `result`（`passed`／`questions`／`evidence`／`summary`） | 只是 claim，會與其餘證據一起核算 |
| `git` | `task.git`／`task.gitMerge`／`task.gitConflict` | 工作樹狀態、head commit、合併結果、衝突檔案 |
| `tests` | `task.completionTest`／`task.completionMainTest` | 測試比對與合併後重測的 `verdict`（`no_regression`／`regression`／`baseline_unavailable`／`parse_failed`） |
| `deployment` | `task.completion`（`status`／`stage`／`results`／`failure`） | 部署管線（見 `docs/GIT-WORKFLOW.md`／`server/completion-pipeline.js`）目前的推進狀態 |
| `runtime` | `task.completionValidation` | 部署後 preview/runtime 驗收的 `passed`／`checks` |
| `browserValidation` | `result.browserValidation`（見 `docs/BROWSER-VALIDATION.md`） | 已經過 `reconcileBrowserValidation` 反造假處理的結果，不是 AI 原始回報 |
| `pendingActions` | `gitIssuePending(t)`、`task.userActionRequired`、`task.outputIssue`、`task.questions`、`task.repairApproval` 等既有欄位 | 是否仍有待使用者處理的事項 |

## 呼叫時機

### 1. Review 完成前（`server/runner.js`）

`applyPhaseResult()` 的 review 分支呼叫 `reviewCompletionContext(t, thread, result)` 組出
`context`（此時部署管線與部署驗收通常還沒開始，缺席會被視為「不適用」，不會擋住審核，
也不會被當成通過），再呼叫 `reconcileCompletionState`：

- 只有 `reconciled.passed && reconciled.status === 'completed'` 才把 `t.status` 設為
  `'completed'` 並寫入 `artifactVersion`／`artifactCommit`。
- 否則沿用既有的 `toolAccessFailure`／`repair_planning` 分支，並把
  `reconciled.blockingReasons`／`warnings`／`nextAction` 一併寫入既有的
  `t.validationFailure`，不會新增任何重新執行該階段工作的路徑。

### 2. 部署管線推進中（`server/completion-pipeline.js`）

`completionPublic(task)` 呼叫 `pipelineReconcileContext(task)` 組出 `context`（`executorResult`
這一項 claim 沿用「核准進入這條 pipeline 前 `task.status` 必須已經是 `'completed'`」的既有
前置條件——那正是第 1 點 review 階段判定通過後留下的結論，這裡不是重新採信一次 AI 的宣稱），
再呼叫 `reconcileCompletionState` 取得統一的 `blockingReasons`／`warnings`／`evidence`／
`nextAction`，附加在回傳物件上。`advanceCompletion()` 與各 stage handler 的推進邏輯、
`completion.status` 本身完全不受影響，這裡只是多算一份可對外顯示的彙整結論。

## 與既有 `task.status`／`completion.status` 狀態機的關係

- `task.status` 的既有列舉與語意（`completed` = 審核通過、成果就緒、可進入合併）不變；
  `reconcileCompletionState` 只是 review 分支判定「要不要」把 `task.status` 設為
  `completed` 的依據，不新增或取代 `task.status` 的列舉值。
- `task.completion.status`（部署管線自己的 `running`／`completed`／`failed`）不變；
  `reconcileCompletionState` 在這裡只讀取既有結果、產出附加的說明欄位，不影響階段推進
  或 `completion.status` 本身的判定。
- `reconcileCompletionState` 回傳的 `status` 是「這一次呼叫當下、依已存在的證據」得到的
  結論，不代表要求部署管線先跑完才能算審核完成——review 階段呼叫時，部署管線尚未開始
  的欄位一律視為不適用，不會因此把 review 階段的判定卡在 `running`／`deploying`。
- `server/git-review.js` 的 `mergeDecision()`（`task.status !== 'completed'` 時拒絕合併）
  維持不變，避免與這次重構產生循環依賴。

## API／前端顯示

- `completionPublic(task)`（`server/completion-pipeline.js`）在既有欄位之外新增
  `blockingReasons`／`warnings`／`evidence`／`nextAction`，隨 `/api/state`、
  `/api/tasks/:id` 的 `task.completion` 一起送出。
- review 未通過時，`t.validationFailure` 同樣附加 `blockingReasons`／`warnings`／
  `nextAction`（`server/runner.js`），隨既有的 `decorated(t)` 一起送出。
- 前端由 `src/completion-view.js` 的 `pipelineView()` 與 `src/task-detail-view.js` 的
  `validationFailureView()` 把這些欄位轉成過濾過空白的純文字陣列／字串，分別在
  `src/Completion.vue`（部署流程區塊）與 `src/App.vue`（「最近未通過的驗證」區塊）顯示。
  兩個 view 函式在欄位缺席時一律回傳空陣列／`null`，不會丟例外。

## 對舊任務資料的相容處理

`reconcileCompletionState` 的每一類證據都允許缺席：

- 完全空的 `context`（模擬沒有任何欄位的舊任務資料）不會丟出例外，也不會被誤判為
  `completed`——因為完全沒有 `executorResult` 時會被歸類為 `blocked`。
- 有有效 `executorResult`（claim 完整）但缺 `git`／`completionTest`／
  `completionMainTest`／`completion`／`completionValidation`／`browserValidation` 等欄位
  的舊任務，缺席的類別只會計入 `warnings`（不適用／尚未執行），不會擋住 `completed`，
  也不會被誤判為 `failed`。
- 這與既有的 `resultSchema`（`server/domain.js`）欄位設計一致：新欄位一律有安全預設值，
  舊資料照常讀取，不需要 migration。

## Testing

- `tests/completion-state.test.js`：涵蓋十一種 `status` 各至少一例，以及驗收情境
  （Git 衝突覆蓋 `passed=true` 的宣稱、測試 regression 阻擋完成、非關鍵欄位缺席不擋
  `completed`、完全空的舊任務 context 不丟例外也不被誤判為 `completed`）。
- `tests/workflow.test.js`：review 分支串接後的既有行為（無回歸）。
- `tests/completion-pipeline.test.js`：部署管線 `completionPublic()` 新增欄位的斷言
  （成功完成、測試 regression 失敗、合併衝突失敗、pipeline 執行中四種既有情境）。
- `tests/completion-view.test.js`／`tests/task-detail-view.test.js`：前端 view 函式在
  正常內容、空陣列、舊資料缺欄位三種情境下的純函式測試。
