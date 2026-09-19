# Domain Model：Project → Plan → Task → Run → Attempt

本文件盤點 `server/db.js`、`server/domain.js`、`server/plan-group.js`、
`server/thread-presentation.js`、`server/limit-retry.js`、`server/runner.js`、
`server/task-status.js` 後，定義新的五層資料模型如何對應到既有結構，並評估
向下相容風險。目的是給後續「後端 API 相容性實作」（Step 2）與前端（Step 3、4）
一份可以直接照著寫的對應表，全程**不新增資料表、不改既有欄位語意**。

沿用 `server/plan-group.js` 的寫法風格：先講「是什麼」「刻意不做的事」，
再講衍生規則，最後講風險。

## 1. 對應表

| 目標概念 | 既有實體 | 資料位置 |
| --- | --- | --- |
| Project | 專案 | `projects` 資料表（`server/db.js`） |
| Plan | 方案群組 | `plan_groups` 資料表 + `tasks.plan_group_id`（`server/plan-group.js`） |
| Task | 任務 | `tasks` 資料表，JSON 存在 `tasks.data`（`server/domain.js` `createTask`） |
| Run | 某 Task 的一次「執行」 | **不是新資料**，是 `threads` 依 `(taskId, planVersion, round, phase, stepIndex)` 分組後的邏輯群組 |
| Attempt | Run 中的一次嘗試（重試／恢復） | **不是新資料**，就是 `threads` 資料表裡的一筆 thread（`server/db.js` `threads` 表，JSON 存在 `threads.data`） |

沒有新增任何資料表或欄位。`threads` 本來就是「一次角色工作」的最小單位；
Run 只是把同一個邏輯步驟被重跑多次的那幾筆 thread（Attempt）收在一起呈現。

### 1.1 為什麼 Attempt＝thread，而不是新概念

`server/runner.js` 的 `runTask()`（約 210～227 行）在每次真正呼叫 AI 引擎前，
都會 `thread={id:id(),...};store.saveThread(thread)` 建立一筆全新的 thread，
即使这是同一個邏輯步驟（同一個 `round`、同一個 `phase`、同一個 `step`）的第二次、
第三次執行。以下情境都會讓同一個「Run」底下出現多筆 thread（多個 Attempt），
但完全不改變 `threads` 資料表結構：

- **使用者手動重試**：`server/app.js` 的 `POST /api/tasks/:id/action`
  （`action==='retry'`）只是把 `task.status` 撥回 `queued`／`planning`，
  不會動 `task.round`；`runner.js` 的 `tick()` 之後會用同一個
  `nextTaskEngine()` 邏輯算出同一個 phase／step，建立新 thread。
- **AI 引擎額度受限（rate limit）**：`server/limit-retry.js` 的
  `scheduleLimitRetry()` 把失敗中的 thread 標成 `status:'rate_limited'`，
  `task.status` 也變成 `rate_limited`；額度恢復後 `tick()` 同樣重算出
  一模一樣的 phase／step，建立新 thread（`server/runner.js` 168～175 行）。
- **服務中斷後的恢復（recovery）**：`server/runner.js` 開機時的
  `recover` 區塊（約 161 行）把上次來不及結束、還卡在 `running` 的 thread
  標成 `status:'failed'`、`error:'上次執行中斷，需人工確認'`，任務轉
  `paused`；使用者確認後恢復，同樣的 phase／step 會建立新 thread。
- **Git 守門待確認**：`thread.stoppedReason==='git_blocked'`
  （`server/thread-presentation.js`）之後使用者確認繼續，也是同一個
  phase／step 上再開一筆新 thread。

也就是說，Attempt 之間的差異已經完整寫在既有欄位裡（`status`、`error`、
`stoppedReason`、`engine`、`started`/`finished`），不需要新欄位就能分辨
「這次為什麼要重試」。

## 2. Run 的分組鍵與推導演算法（純函式，不落地）

Run 的識別鍵是四元組（execute 階段是五元組，多一個 step 序號）：

```
runKey = (taskId, planVersion, round, phase[, stepIndex])
```

原因：`server/limit-retry.js` 的 `nextTaskEngine()` 與 `server/runner.js`
的 `runTask()` 都是用「同一個 planVersion／round／phase（execute 階段還要
看目前已通過的 step 數）」來決定下一顆 thread要做什麼工作——這正是判斷
「兩筆 thread 是不是同一次 Run 的不同 Attempt」的唯一依據，不能用標題、
角色文字或時間相近去猜。

推導規則（依 `threads` 陣列既有的建立順序，也就是 `store.threads(tid)`
回傳的 `ORDER BY rowid` 順序）：

1. **plan / repair_plan / review / repair**：同一個 `(planVersion, round, phase)`
   底下的所有 thread 都是同一個 Run 的 Attempt（這四種 phase 在同一輪次裡
   本來就只會有一個邏輯步驟）。
2. **execute**：因為同一輪只有 `round===0` 會有 execute 階段，且
   `runner.js` 是用「目前已通過驗收的 step 數」`done.length` 來決定要跑
   `t.plan.steps[done.length]`（見 `runTask()` 217 行），所以要在推導時
   維護一個游標 `stepCursor`（初始為 0），依序掃過該任務 `round===0` 的
   execute 階段 thread：
   - 這筆 thread 的 `stepIndex = stepCursor`（也就是這次 Attempt 是在
     嘗試 `plan.steps[stepCursor]`）；
   - 若這筆 thread 是「通過」的（`status==='completed' && result?.passed===true
     && !(result?.questions?.length)`），`stepCursor += 1`（下一筆 execute
     thread換成嘗試下一個 step，等同開新的 Run）；
   - 否則（`failed`／`rate_limited`／`cancelled`／未通過驗收）stepCursor
     不變，下一筆 execute thread 仍歸在同一個 Run（是同一個 step 的下一個
     Attempt）。
   - 這個規則和 `nextTaskEngine()`／`runTask()` 判斷「下一步要跑哪個 step」
     的邏輯完全一致，只是反過來從既有紀錄推回「這筆屬於哪個 Run」。

3. Run 內的 Attempt 依 `started` 時間（即 thread 建立順序）排序，
   **最後一筆**代表目前狀態；`Run.status` 依最後一筆 Attempt 的
   `displayStatus`（`threadPresentation()` 既有邏輯）決定，
   不重新定義新的狀態機。
4. Run 沒有結束（`Run.status` 為 running／waiting_user_action 等未完成
   狀態）代表這是「目前正在做的事」；已有一筆 Attempt 通過驗收，代表
   `Run.status='completed'`。

這一整套推導都是**唯讀、無副作用的純函式**，可以放在
`server/thread-presentation.js` 旁新增一個小檔案（例如
`server/run-attempt.js`，风格比照 `plan-group.js`），輸入是
`store.threads(taskId)`（既有 API），輸出是 `Run[]`（每個 Run 內含
`attempts: Attempt[]`），不寫回資料庫、不影響 `saveThread`／`saveTask`。

## 3. 序列化建議（給 Step 2 參考，本步驟不動 API）

- `Attempt` 對外形狀直接複用現有 thread 的欄位（`id`、`engine`、`status`、
  `started`、`finished`、`summary`、`result`、`error`、`sessionId`、
  `commit`、加上既有的 `threadPresentation()` 展開），**不刪減任何既有
  欄位**，只是換一種分組方式回傳，`/api/tasks/:id` 現有的扁平 `threads`
  陣列可以照舊保留（向下相容），新增一個 `runs` 欄位是額外附加，不影響
  既有前端讀取 `threads`。
- `Run` 對外形狀建議：`{id, phase, round, stepIndex, title, status,
  displayStatus, statusLabel, attempts: Attempt[]}`。`id` 可以用
  `${taskId}:${planVersion}:${round}:${phase}:${stepIndex ?? ''}` 這種
  穩定字串組成，不需要另外存 uuid。
- 沒有任何 thread 的任務（例如剛建立、還沒開始規劃）`runs` 給空陣列
  `[]`，不是 `undefined`，避免前端要多判斷一種情況。
- `decorated()`（`server/app.js` 119 行）目前已經把 `threads` 過濾成
  `th.version===t.planVersion`（只給目前這個計畫版本），Run／Attempt 的
  推導也應該沿用同一個過濾條件，維持「舊計畫版本的歷史不會混進目前顯示」
  的既有行為。

## 4. 相容性風險與因應

| 風險 | 情境 | 因應 |
| --- | --- | --- |
| 舊任務沒有 thread | 剛建立、尚未開始規劃的任務 | `runs=[]`，前端顯示「尚未開始」，不當成錯誤 |
| 舊任務沒有 `round`／`round=0` | 所有任務都有 `round`（`createTask` 預設 0），沒有相容性問題；`round>0` 的任務只是走過修正流程 | 不需特殊處理，`round` 一律存在 |
| 沒有 `planGroupId` 的任務 | 既有大量舊任務 | 與 Run／Attempt 無關；沿用 `plan-group.js` 既定規則歸入「其他任務」，本次不改這條規則 |
| execute 階段 stepIndex 算錯 | 若 `t.plan` 為 null（尚未規劃完成）或 `t.plan.steps` 與既有 execute thread 對不上（理論上不會發生，因為 `step` 是規劃當下的快照） | 推導函式在 `t.plan` 為 null 時，execute 類 thread 一律退化成不分 stepIndex（全部視為 `stepIndex=null`），不拋錯、不中斷渲染 |
| 同一 phase 出現非預期的重複 | 理論上不會發生（thread 建立與消化都在同一個 `runTask` 呼叫序列裡），但推導函式仍必須是**忽略未知情況也不拋錯**的防禦寫法，寧可多分一個 Run 也不能讓整頁報錯 | 推導函式對任何無法歸類的 thread，一律各自獨立成一個 Run（保底行為） |
| 前端尚未讀取新欄位 | Step 2 上線後，若舊版前端快取／未更新的分頁仍在跑 | `runs` 是新增欄位，不影響既有 `threads` 陣列讀取路徑，屬於向後相容的附加 |

## 5. 本步驟刻意不做的事

- 不新增 `threads` 或 `tasks` 的資料表欄位。
- 不在 `threads.data` 這個既有 JSON 欄位塞入新的可選欄位——盤點後
  Run／Attempt 100% 可以從既有欄位（`version`、`round`、`phase`、
  `status`、`result`、`started`）純運算推導，不需要額外標記。
  若之後真的需要「這次 Attempt 是因為 rate limit／recovery／使用者手動
  重試而產生」這種更細的分類（目前需求沒有要求），建議做法是比照既有
  `thread.stoppedReason`、`thread.commit` 的先例，在 thread 物件上加一個
  可選欄位（例如 `thread.attemptReason`），預設不存在時前端顯示為「重試」
  這個通用文案即可，不會讓舊資料出錯。
- 不改變 `plan_groups`／`taskPlanGroupInput`／「沒有 planGroupId 就進其他
  任務」的既有規則。
- 不在本步驟修改任何 `server/*.js` 的可執行程式碼；Run／Attempt 的實際
  序列化留給 Step 2（「後端 API 相容性實作」）依本文件第 2、3 節實作。
