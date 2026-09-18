# Git 工作流改造 — Phase 1 / 2 / 3

TaskFlow 原本以 `data/workspaces/<taskId>/v<N>` 整包複製專案來隔離 AI 的修改。
Phase 1 把「工作目錄」改由 Git 提供：任務在自己的 **git worktree** 裡執行，版本歷史由
branch 與 commit 記錄，不再靠複製資料夾。

- **Phase 1**：工作目錄與安全守門。
- **Phase 2**：階段 commit 與 commit metadata。
- **Phase 3**：人工核准、merge、conflict 處理、分支清理、rollback 與 legacy 工作副本轉換（API 層）。

自動流程到「驗證完成」為止。之後的每一步都要人按下去才會發生，TaskFlow 不會自己合併任何東西。

---

## 一個任務開始時發生什麼事

```
專案資料夾
   │  git rev-parse --is-inside-work-tree
   ├── 不是 repository → git init + main + .gitignore + 初始 commit
   ├── 是 repository   → 只讀取狀態，絕不重新 init、不改動 main
   ▼
git status --porcelain 有未提交修改？ → 停止，等使用者處理
   ▼
git worktree add data/worktrees/<taskId> -b taskflow/<shortId>-<slug> <目前分支>
   ▼
每次派工前：確認工作目錄仍在該任務分支上，且不是受保護分支
   ▼
Agent 在 worktree 內修改檔案
```

為什麼是 worktree 而不是在專案目錄切分支：worktree 與專案共用同一份 `.git` 歷史，但工作樹
完全獨立。你的專案資料夾永遠停在你自己的分支上，不會被 Agent 改到，也不需要在任務之間
`git switch` 來回切換——多個任務可以同時進行。

## 分支命名

`taskflow/<taskId 前 8 碼>-<標題 slug>`，例如 `taskflow/184abcde-fix-line-webhook`。
標題若是中文會被濾掉，此時只保留 `taskflow/184abcde`，仍可對應任務。

## 安全守門（deterministic，不依賴 AI 判斷）

| 情況 | 行為 |
| --- | --- |
| 專案有未提交修改 | 任務停在 `waiting_input`，帶 `gitIssue.reason = dirty_working_tree` 與檔案清單。**不** reset、不 clean、不 stash、不把你的修改混進任務 |
| 工作目錄被切到 main／master／production／release／develop | 停止，`protected_branch`，訊息為「Git safety check failed.」 |
| 工作目錄被切到其他分支 | 停止，`branch_changed`；TaskFlow 不會自動切回去 |
| 工作目錄處於 detached HEAD | 停止，`detached_head` |
| 專案位於另一個 repository 之內 | 停止，`nested_repository`；不會在上層版本庫建立分支 |
| repository 還沒有任何 commit | 停止，`no_commits`；請先自行完成第一次 commit |
| 工作目錄已被手動刪除 | 停止，`worktree_missing` |

被擋下時任務停在 `waiting_input` 並發出通知；處理完後呼叫
`POST /api/tasks/:id/git/recheck`（body：`{"issueId": "<gitIssue.id>"}`）重新檢查。
這條 API 不執行任何 git 寫入指令，只是清掉旗標讓 runner 重跑同一份檢查。

### 永遠不會自動執行的指令

`git reset --hard`、`git clean`、`git push`、`git stash`、`git restore`、`git checkout -- .`、
`git branch -D`、`git rm`（不含 `--cached`）、`git worktree remove --force`。

這是 `server/git-workspace.js` 裡的 denylist，不是慣例：任何經過該模組的呼叫都會被擋下，
必須由你自己在終端機執行。Agent 的提示詞另外也明確禁止切換分支、merge／rebase／push。

## 初始 commit 收錄什麼

不做 `git add .`。流程是：先確認（或建立）`.gitignore`，再以
`git status --untracked-files=all` 逐一列出未被忽略的檔案，剔除疑似機密或執行期資料的路徑
（`.env*`、`*.pem`／`*.key`／`*.pfx`、`*.sqlite`、`node_modules`、`data`、`dist`、`logs`、
`.ssh`、`.aws`、`credentials*`、`secrets*` 等，含子目錄），只加入剩下的檔案；加入索引後再檢查
一次，仍符合機密特徵的路徑會被移出索引。略過的項目會寫進任務活動紀錄。

既有 repository 的 `.gitignore` 一行都不會被修改。

## 任務資料模型

```json
{
  "workspace": "…/data/worktrees/<taskId>",
  "git": {
    "mode": "worktree",
    "repositoryPath": "F:/Projects/example",
    "workingDirectory": "…/data/worktrees/<taskId>",
    "baseBranch": "main",
    "workingBranch": "taskflow/184abcde-fix-line-webhook",
    "baseCommit": "abc123…",
    "headCommit": "abc123…"
  },
  "gitIssue": null
}
```

`task.workspace` 仍是唯一的「工作目錄」欄位，預覽、Browser Validation、指令授權比對都沿用它，
所以其餘流程不需要改。API 回應只送出 `mode`／`baseBranch`／`workingBranch`／`baseCommit`／
`headCommit`，磁碟路徑（`repositoryPath`、`workingDirectory`）與 `workspace` 一樣不會送到瀏覽器。

## 設定

| 設定鍵 | 預設 | 說明 |
| --- | --- | --- |
| `gitWorkspaceEnabled` | `true` | 關閉後新任務退回舊版 `v1/v2` 工作副本快照 |
| `protectedBranches` | `["main","master","production","release","develop"]` | Agent 一律不得在這些分支上執行 |

找不到 `git` 指令時會記錄一筆活動紀錄並自動退回舊版快照；但安全守門一旦觸發就是停止，
不會「繞過去」。

## 相容性

- 既有任務若已經有 `workspace`（舊的 `v<N>` 資料夾），維持原樣繼續使用，不搬遷、不刪除。
- 新任務一律走 Git 模式。
- 移除專案時，`data/workspaces/<taskId>` 與 `data/worktrees/<taskId>` 都會列入刪除範圍。

---

# Phase 2：階段 commit

## 什麼時候會產生 commit

每個**可能改到檔案**的階段（execute／repair／review）結束後，TaskFlow 在該任務的 worktree 裡
檢查 `git status`：

- 沒有任何變動 → **不 commit**，不留空 commit。原則是「有修改就 commit」，不是「每個 step 一定 commit」。
- 有變動 → 只把不屬於機密／執行期資料的檔案加入索引後 commit（過濾規則與初始 commit 相同，
  例如 `.taskflow/`、`.env*`、憑證、`*.sqlite` 一律排除）。全部變動都被排除時同樣不 commit，
  並在活動紀錄留下 `git_commit_skipped`。
- 規劃階段（plan／repair_plan）是唯讀的，永遠不會 commit。

**執行失敗的階段也會 commit**：引擎中途出錯時檔案可能已經改了一半，先保存起來，否則下一次重試
會在一個來歷不明的工作樹上繼續。commit 訊息會寫明這個階段是以錯誤結束的。

每次 commit 前都重跑一次分支守門；工作目錄若已不在該任務分支上，寧可不 commit 也不寫錯地方。
commit 本身失敗只會留下 `git_commit_failed` 活動紀錄，不會讓整個階段變成失敗——檔案本來就還在
工作目錄裡。

## commit 不等於驗收通過

這是 Phase 2 最重要的分界。commit 只代表「這段開發成果被保存下來」：

```
Build              PASS
Unit Test          PASS
Browser Validation FAIL
```

上面的情況仍然會產生 commit，但任務的 `passed` 是 false、狀態不會變成 `completed`，也不能合併。
commit 訊息裡會同時寫上自我回報的 `passed=` 與一句「commit 只保存開發成果，不代表驗收通過，
也不代表可以合併」，避免日後看 log 的人把 commit 當成核准。

## commit 訊息格式

```
taskflow(execute): 修正 LINE webhook 路由

任務：修正 LINE webhook（<taskId>）
工作：後端工程師 · execute · thread <threadId>
計畫版本：v2　修正輪次：0　引擎：codex
本階段自我回報 passed=true
commit 只保存開發成果，不代表驗收通過，也不代表可以合併。

<該階段的 summary，最多 800 字>
```

標題固定為 `taskflow(<phase>): <步驟標題>`，由平台產生而非 AI 自述，所以可以放心用來 grep 與稽核。

## commit metadata

每個產生 commit 的 thread 會帶上：

```json
{
  "commit": { "commit": "def456…", "subject": "taskflow(execute): 撰寫文件", "files": ["server/index.js"], "fileCount": 1, "at": "…" }
}
```

任務層級：`task.git.headCommit` 跟著最新的 commit 移動；驗證通過而產生成果版本時，另外記下
`task.artifactCommit`，把「這次核准的成果」對應到確切的 commit。

## 關於原本的 v1/v2/v3 版本欄位

TaskFlow 的資料模型裡沒有把 `version` 當成程式碼儲存位置的欄位——舊的 `v<N>` 只存在於工作副本的
路徑中，Phase 1 已經連路徑一起換成 worktree。`planVersion` 是計畫版本、`artifactVersion` 是成果版本，
兩者都是任務流程語意，保留不動；需要追到程式碼時改看 `git.baseCommit`／`git.headCommit`／
`artifactCommit`。

---

# Phase 3：人工核准、Merge、Rollback 與清理

## 流程

```
全部階段執行完畢 → 獨立驗證通過 → 任務 completed → 自動流程停止
                                              │
                          ┌───────────────────┼───────────────────┐
                      要求修改               拒絕              核准並 Merge
                          │                   │                   │
                   沿用同一分支           預設保留分支      main 乾淨？ → merge --no-ff
                   補充需求重新規劃      （明確選擇才刪）    衝突？ → 停下來交給人
                                                                  │
                                                            清理 worktree 與分支
                                                                  │
                                                          需要時 git revert 撤銷
```

## API

| 路徑 | 用途 |
| --- | --- |
| `GET /api/tasks/:id/git/review` | 分支、這條分支上的 commit、各階段驗收結果、正式分支目前狀態 |
| `POST /api/tasks/:id/git/decision` | `{"decision":"merge"\|"changes"\|"reject", …}` |
| `POST /api/tasks/:id/git/rollback` | `{"mergeCommit":"…"}`，撤銷已合併的成果 |
| `GET /api/tasks/:id/git/legacy` | 舊 v1/v2 工作副本的轉換狀態 |
| `POST /api/tasks/:id/git/migrate` | 把舊工作副本轉進任務分支 |

`review` 會實際讀 Git，所以只在開啟審核時呼叫，不放進每 3 秒輪詢的 `/api/state`。

## 核准並 Merge

`{"decision":"merge","artifactVersion":"<目前成果版本>","cleanup":true}`

前置條件，任何一項不成立就不合併：

- 任務是**通過獨立驗證**而完成的。手動標記完成（`manualCompletion`）不算，會被擋下。
- `artifactVersion` 與目前成果版本相符——確保你核准的是你剛才看到的那一份。
- 專案目錄正停在 `baseBranch` 上。**TaskFlow 不會替你 `git switch`**：在別的分支上就直接回報，
  請你自己切換後再核准。
- 專案目錄乾淨。有未提交修改就停止，不清、不 stash。

通過後執行 `git merge --no-ff`，保留這個任務在歷史上的獨立邊界：

```
A ──────── M
 \         /
  B ─ C ─ D
```

合併訊息會帶上任務標題、分支、成果版本與核准人。合併後再檢查一次工作樹是否乾淨、HEAD 是否
真的包含任務分支，不如預期就停下來等人確認。

## 衝突

衝突一律**先預檢**（`git merge-tree --write-tree`，舊版 git 則試一次後 `merge --abort`），
所以正式分支永遠不會被丟在一個解到一半的 merge 狀態裡：

- 任務記下 `gitConflict`（衝突檔案清單），狀態不變、`HEAD` 不動、工作樹維持乾淨。
- TaskFlow **不會**替你選 `ours` 或 `theirs`。
- 你可以自己在專案裡處理完再回來核准，或改走「要求修改」讓 AI 重做。

## 要求修改

`{"decision":"changes","answer":"…"}`

沿用**同一條分支與同一個 worktree**（分支名只由 taskId 決定）。任務從 completed 放回可補充需求的
狀態、成果核准失效、計畫版本 +1，然後重新規劃並執行，最後再次回到審核。

## 拒絕

`{"decision":"reject","keepBranch":true}`

不合併，任務轉為 cancelled。**預設保留分支與工作目錄**，避免開發成果直接消失。只有明確傳
`keepBranch:false` 才會刪除；刪除一個未合併的分支需要 `git branch -D`，它走的是程式碼裡一條
只放行這一個指令的授權通道，不是把守門關掉。

## 清理

合併成功後預設清理（`cleanup:false` 可保留）：先 `git worktree remove`，再 `git branch -d`
（安全刪除，未合併就刪不掉）。工作目錄若還有**未提交的真實內容**就拒絕移除並照實回報；只有在
確認剩下的全是 TaskFlow 自己的暫存檔（`.taskflow/` 等本來就排除在 commit 之外的東西）時才會移除。

清理後 `task.workspace` 設為 `null`、`git.cleanedUp` 為 true。成果此時已經在正式分支上，
審核畫面仍看得到合併結果。

## Rollback

不回頭找舊的 `vX` 資料夾，而是在正式分支上 `git revert -m 1 <merge commit>` 補一個反向 commit：
歷史完整保留，原本的 merge commit 仍在。撤銷後成果核准（`publishApproval`）同時失效。
revert 若發生衝突會還原為撤銷前的狀態，再交給人處理。

## Legacy 工作副本轉換

舊的 `data/workspaces/<taskId>/v<N>` 仍然可以繼續用，不強制轉換。需要時呼叫 migrate：

1. 依 Phase 1 的規則建立任務分支與 worktree（所有守門照常生效）。
2. 把舊工作副本的內容複製進 worktree（`.taskflow/`、`.env*`、憑證等一樣排除）。
3. commit 成 `taskflow(migrate): 匯入既有工作副本`。

**舊資料夾一律保留不刪**（規劃書 2.7）。分支上有、但舊工作副本裡沒有的檔案不會被自動刪除——
那可能是先前被 AI 刪掉的，也可能是做完快照之後專案才加入的，分不出來就不自作主張，只把清單
寫進活動紀錄交給你判斷。

## 尚未實作

- **前端畫面**：Phase 3 的 Review 目前只有 API，`src/` 的 Vue 工作台還沒有對應的審核介面。
- **Conflict Resolution 流程**：衝突時 TaskFlow 只負責停下來並列出檔案，沒有引導式的解衝突流程。

## 測試

```bash
node --test tests/git-workspace.test.js tests/git-runner.test.js tests/git-review.test.js
```

Phase 1：新專案建立版本庫且機密不進入歷史、既有專案不重新 init 也不改 main、未提交修改時停止且
不動使用者內容、worktree 重複使用、受保護分支／detached HEAD／分支被換掉的守門、破壞性指令
被擋下、巢狀 repository 與無 commit 的專案、關閉 Git 模式時退回舊快照、刪除專案時一併清除 worktree。

Phase 2：有修改才 commit、沒修改不留空 commit、機密與 `.taskflow/` 不進版、刪除與改名都被保存、
commit 前重跑分支守門、規劃階段不 commit、`passed=false` 與引擎失敗的階段一樣保存成果但任務不會
變成完成、`headCommit` 與 `artifactCommit` 正確對應。

Phase 3：`--no-ff` 合併與成果真的進入專案、手動完成與成果版本不符會被擋下、正式分支不乾淨或不在
base branch 時不合併且不替使用者切換分支、衝突時完全不動正式分支（HEAD 不變、無 `MERGE_HEAD`）、
要求修改沿用同一分支、拒絕預設保留分支、清理拒絕丟掉未提交內容、rollback 後歷史仍保留原 merge
commit、授權通道只放行它自己那一個指令、legacy 轉換不刪舊資料夾也不自行刪檔。
