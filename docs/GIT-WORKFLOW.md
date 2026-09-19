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
git status --porcelain 有未提交修改？
   ├── 指紋與 task.gitDirtyApproval 相同 → 使用者已確認，繼續（檔案一個都不動）
   └── 否則 → 停止，等使用者確認（保留修改並繼續／重新檢查／取消任務）
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

## Repository topology 判斷（RepositoryInfo）

「這個路徑到底是什麼」由 `server/git-repository.js` 單一入口回答，其他模組不自己拼湊
`git rev-parse` 的結果，也不自己向上找 `.git`。判斷與決策刻意分開：

```
detectRepositoryInfo(projectPath, { git, projectRoot, managedProjectsRoot })
    → RepositoryInfo      只描述現況，不做決策

evaluateRepositoryPolicy(repositoryInfo)
    → { blocked, requiresUserAction, nextAction, blockReason }
```

### 三個判斷原則

1. **Git 語意優先於 filesystem 結構。** working tree root 一律以 `git rev-parse --show-toplevel`
   為準。向上搜尋 `.git` 只寫進 `physicalParentRepository` 當診斷資訊，**不得**參與 blocked 判斷——
   那會誤傷 linked worktree、nested independent repository 與 submodule。
2. **`.git` 只判斷存不存在，不判斷是不是資料夾。** linked worktree 的 `.git` 是一個文字檔
   （內容為 `gitdir: ...`），用 `isDirectory()` 判斷會把合法的 worktree 判成非 repository。
3. **Git 語意不是唯一的事實來源。** TaskFlow 自己在「預設專案存放位置」底下建立的專案，在還沒
   `git init` 前 `--show-toplevel` 會穿透到上層 repository。那個結果在 Git 語意上正確，但在
   TaskFlow 的產品語意上錯誤：它是一個尚未初始化的獨立專案 root。

### repositoryType 與 policy

| repositoryType | 什麼情況 | blocked | nextAction |
| --- | --- | --- | --- |
| `normal` | `projectPath == show-toplevel`，實體上層沒有其他 repository | false | `continue` |
| `nested-independent` | 同上，但實體上位於另一個 repository 底下（例如 `Projects/idv-web`） | false | `continue` |
| `linked-worktree` | `git-dir != git-common-dir`，且 `worktree list --porcelain` 列有這個 root | false | `continue` |
| `managed-uninitialized` | TaskFlow 管理的專案 root，還沒有自己的 `.git` | false | `git-init` |
| `non-git` | 完全不在任何 Git context 裡 | false | `git-init` |
| `subdirectory` | `projectPath != show-toplevel`，且不是上面任何一種 | **true** | `user-action` |

認不出來的型別一律 `blocked`：放行一個看不懂的狀態，比多問一次危險得多。

### managed project root

一個路徑要被當成 TaskFlow 管理的專案 root，必須**同時**滿足兩個條件：

- 與 TaskFlow DB 記錄的 project root 完全一致（不是它的子目錄）
- 位於平台設定「預設專案存放位置」（`defaultProjectRoot`）底下

第二個條件是刻意的：使用者手動註冊的 `C:\repo\frontend` 雖然也在 DB 裡，但它是別人 repository
的真實子目錄，仍必須走 `subdirectory` 的保護。

`managed-uninitialized` 的出路是 TaskFlow 自己 `git init`，不是叫使用者去處理，所以它**不會**
產生 `gitIssue`。專案建立時（LINE 建專案、管理端建立新資料夾）就會呼叫 `ensureProjectRepository()`
先劃清 repository 邊界；萬一漏掉，第一個任務的 `prepareTaskWorkspace()` 會再補一次。

### repository topology 是會變的

`managed-uninitialized → git init → normal` 是正常的演進，所以 `task.gitIssue` 裡的判定只是
**diagnostic snapshot**，不是永久真相。任務「重新檢查」或恢復時一律重跑 `detectRepositoryInfo()`
再重新 evaluate policy，舊的 `nested_repository` 不會把任務永遠卡住。

---

## 安全守門（deterministic，不依賴 AI 判斷）

| 情況 | 行為 |
| --- | --- |
| 專案有未提交修改 | 任務停在 `waiting_input`，帶 `gitIssue.reason = dirty_working_tree`、檔案清單與指紋，UI 出現三個可操作選項。**不** reset、不 clean、不 stash、不把你的修改混進任務 |
| 工作目錄被切到 main／master／production／release／develop | 停止，`protected_branch`，訊息為「Git safety check failed.」 |
| 工作目錄被切到其他分支 | 停止，`branch_changed`；TaskFlow 不會自動切回去 |
| 工作目錄處於 detached HEAD | 停止，`detached_head` |
| 專案是另一個 repository 的子目錄 | 停止，`nested_repository`；不會在上層版本庫建立分支。判定依據見下面的 Repository topology 一節——linked worktree、nested independent repository 與 TaskFlow 自己管理的專案 root 都不算 |
| repository 還沒有任何 commit | 停止，`no_commits`；請先自行完成第一次 commit |
| 工作目錄已被手動刪除 | 停止，`worktree_missing` |

被擋下時任務停在 `waiting_input`（不是 `failed`：這是「需要你決策」，不是執行失敗）並發出通知，
同時把被擋下來之前的狀態記在 `gitIssue.resumeStatus` 與 `task.resumeStatus`，處理完才能回到原本的
流程（規劃中被擋回到 `planning`、修正方案分析中被擋回到 `repair_planning`、執行中被擋回到 `queued`）。

### 未提交修改的人工處理閉環

任務詳情頁會出現「需要確認 Git 修改」區塊：完整檔案清單、TaskFlow 的不作為承諾，以及三個動作。
三個動作共用既有路徑 `POST /api/tasks/:id/git/recheck`，body：

```json
{ "issueId": "<gitRequest.requestId 或 gitIssue.id>", "action": "approve | recheck | cancel" }
```

`action` 省略時等於 `recheck`（舊的呼叫方式照樣可用）。這條 API 不執行任何 git 寫入指令，
只會讀 `git status`：不 reset、不 clean、不 stash、不 checkout、不 commit、不刪除任何檔案。

| action | 行為 |
| --- | --- |
| `approve` | **保留修改並繼續**。重新讀一次 `git status` 確認畫面上那組修改沒變（變了就更新清單並要求重新確認，不代替你核准沒看過的修改），把指紋寫進 `task.gitDirtyApproval`，任務回到 `resumeStatus`。只有 `dirty_working_tree` 可以這樣解除 |
| `recheck` | **我已自行處理，重新檢查**。真的重跑 `git status`：乾淨就關閉 blocker 並回到 `resumeStatus`；仍 dirty 只更新同一筆 blocker 的檔案清單與指紋（不建立第二個 blocker），維持等待 |
| `cancel` | 取消任務，並把 `gitIssue`／`userActionRequired` 的 `status` 一起改成 `cancelled`，UI 不再顯示「待我處理」 |

### 指紋：同一組修改只問一次

`gitIssue.fingerprint` 是 `git status --porcelain` **完整**輸出（不是顯示用的前 30 筆）正規化排序後的
SHA-256，untracked（`??`）與 staged／unstaged 一視同仁納入計算。

```
第一次      git status = A → fingerprint = hash(A) → 要求確認
使用者確認   gitDirtyApproval.fingerprint = hash(A)
下一輪派工   hash(A) === approved → 不再阻塞（活動紀錄寫下「已依你的確認保留 N 項未提交修改」）
又有新修改   hash(B) !== approved → 再次要求確認
```

沒有這個指紋就會出現「按了繼續，下一輪又被同一組修改擋住」的無限循環。

「保留修改並繼續」不代表 TaskFlow 會在你的主工作樹上工作：任務分支照樣從**最後一次 commit**
開出、在獨立的 worktree 執行，你那些未提交修改留在專案目錄裡原樣不動，也不會被帶進任務。

`git status` 本身執行失敗時一律回報 `git_status_failed`，**不會**被當成「工作目錄乾淨」——
讀不到狀態時假設乾淨等於關掉守門。

### 顯示狀態優先序

`decorated().displayStatus`（`server/task-status.js` 的 `taskDisplayStatus`）：
`cancelled` → `completed` → `waiting_git_confirmation`（Git 待確認）→ `waiting_user_action`
（需要你在本機操作）→ `task.status`。已結束的狀態永遠贏過待處理項目，所以「任務已取消卻仍顯示
待我處理」不會再發生，連舊資料（`gitIssue` 沒有 `status` 欄位）也一樣。

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
  "gitIssue": {
    "id": "…",
    "reason": "dirty_working_tree",
    "status": "pending | approved | resolved | cancelled",
    "files": ["M README.md", "?? scratch.txt"],
    "fileCount": 14,
    "fingerprint": "sha256…",
    "resumeStatus": "planning",
    "planVersion": 1,
    "at": "…"
  },
  "gitDirtyApproval": {
    "approvedAt": "…", "approvedBy": "…", "fingerprint": "sha256…",
    "files": ["M README.md"], "fileCount": 14
  },
  "gitIssueHistory": []
}
```

`gitIssue` 不再是「有／沒有」：處理完之後會留在任務上（`approved`／`resolved`／`cancelled`）供 UI
顯示歷程，**是否還擋著任務一律用 `gitIssuePending(task)` 判斷**，不要用 `!!task.gitIssue`。
API 另外送出 `gitRequest`（只有真的還需要你處理時才存在，含 `requestId`、`approvable`、
`title`、`files`、`fileCount`）給前端渲染。

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

### 真正執行的 merge 一樣不信任 exit code

預檢通過只代表「當下看起來沒問題」；預檢與真正執行 `git merge --no-ff --no-edit` 之間可能有新的
變化，舊版 git 的探測本身也不夠準。所以這個 command 一律用 `allowFailure` 執行，不管它回報成功
還是失敗，接下來都用 `inspectMergeState()`（`server/git-workspace.js`）重新讀 Git 本身的真實狀態
做最終判斷：

```
git status --porcelain             一般 dirty 檔案
git diff --name-only --diff-filter=U   目前未解決的衝突檔案
git rev-parse -q --verify MERGE_HEAD   是否處於一個進行中的 merge
目前 branch 與 HEAD                    HEAD 是否真的包含任務分支
```

只要 `mergeInProgress` 為真或 `unresolvedFiles` 非空，一律視為衝突：取未解決檔案清單、
自動執行 `git merge --abort`（走專用授權通道）讓 `baseBranch` 回到合併前的乾淨狀態，
再回報跟預檢衝突相同形狀的結果——即使 merge 指令本身回報「成功」也一樣不採信。
只有 `inspectMergeState()` 確認乾淨、且 HEAD 確實包含任務分支時才算合併成功；其餘不一致的
情況（工作樹髒污、HEAD 對不上）觸發 `merge_incomplete`，停下來等人工確認，不猜測、不重試。

### `merge_in_progress` 與 `dirty_working_tree` 是两回事

`assertMergeReady()` 在核准合併前，會先用 `inspectMergeState()` 檢查 `MERGE_HEAD` 是否存在。
`MERGE_HEAD` 存在但沒有 `unresolvedFiles`，代表「衝突已經解決、只是還沒 commit」——這跟一般
的未提交修改（`dirty_working_tree`）是完全不同的處境，不需要使用者再解一次衝突，只差一個
commit 或一次 `git merge --abort`。因此這個狀態會先被獨立分類成 `merge_in_progress`（附上仍未
解決的檔案清單），不會被下面籠統的 `dirty_working_tree` 訊息蓋過去。`mergeDecision`
（`server/git-review.js`）接住這個例外後，一樣寫入 `t.gitConflict` 並發出 Human Action
Request，不會變成無結構的純文字錯誤直接往外拋。

### 使用者手動解決衝突並完成 merge commit 之後

如果你已經自己在專案目錄處理完衝突並手動完成了 merge commit（`workingBranch` 的內容已經在
`baseBranch` 上），`mergeTaskBranch` 會用 `merge-base --is-ancestor` 偵測到並回報
`already_merged`。這不會被當成錯誤擋下：`mergeDecision` 會重新呼叫 `gitWorkspace.inspect()`
核對一次正式分支目前的 HEAD，等同重新執行一次 Git state reconciliation，然後把這次核對的結果
視為合併完成——寫入 `t.gitMerge`（帶 `reconciled: true`）、清除 `gitConflict`、照常觸發清理與
通知，流程繼續往下走，不再回傳 409 擋住使用者。

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
node --test tests/git-workspace.test.js tests/git-runner.test.js tests/git-review.test.js tests/git-issue.test.js
```

Phase 1：新專案建立版本庫且機密不進入歷史、既有專案不重新 init 也不改 main、未提交修改時停止且
不動使用者內容、worktree 重複使用、受保護分支／detached HEAD／分支被換掉的守門、破壞性指令
被擋下、巢狀 repository 與無 commit 的專案、關閉 Git 模式時退回舊快照、刪除專案時一併清除 worktree。

Repository topology（`git-workspace.test.js` 的 topology A–G）：TaskFlow 管理的專案在 `git init`
之前不得被判成 `nested_repository`、派工時自行初始化且不動上層版本庫、真正的 repository 子目錄仍被擋
且不會就地 `git init`、linked worktree 實體位於另一個 repository 底下仍是合法 worktree root、
nested independent repository 合法、純資料夾為 `non-git`、專案建立時就取得自己的版本庫。
另有一個回歸測試釘住舊版 git（`< 2.38`，沒有 `merge-tree --write-tree`）的合併退路：專案未設定
`user.name`／`user.email` 時不得被誤判成「有衝突、但沒有任何衝突檔案」。

Phase 2：有修改才 commit、沒修改不留空 commit、機密與 `.taskflow/` 不進版、刪除與改名都被保存、
commit 前重跑分支守門、規劃階段不 commit、`passed=false` 與引擎失敗的階段一樣保存成果但任務不會
變成完成、`headCommit` 與 `artifactCommit` 正確對應。

Git 守門的人工處理閉環（`tests/git-issue.test.js`）：dirty working tree 進入待確認而非失敗且不呼叫
Agent、待我處理與詳情頁都有可操作選項、確認後回到原本狀態且相同指紋不再阻塞、確認後又新增
untracked 檔案會以新指紋再問一次、自行 commit 後重新檢查即解除、仍 dirty 只更新同一筆 blocker、
取消任務會關閉待確認項目、已取消（含舊資料）永遠顯示 `cancelled` 而非待我處理、`git status`
失敗如實回報而不推論乾淨、受保護分支這類問題不能用「保留修改並繼續」跳過、過期請求被擋下、
`/git/recheck` 三種 action 與舊呼叫方式相容。每一項都同時檢查使用者的檔案沒有被動到
（內容不變、`git stash list` 為空、專案目錄仍在原分支）。

Phase 3：`--no-ff` 合併與成果真的進入專案、手動完成與成果版本不符會被擋下、正式分支不乾淨或不在
base branch 時不合併且不替使用者切換分支、衝突時完全不動正式分支（HEAD 不變、無 `MERGE_HEAD`）、
要求修改沿用同一分支、拒絕預設保留分支、清理拒絕丟掉未提交內容、rollback 後歷史仍保留原 merge
commit、授權通道只放行它自己那一個指令、legacy 轉換不刪舊資料夾也不自行刪檔。

`inspectMergeState()` 與 merge conflict guard 額外涵蓋五種情境：clean merge（HEAD 真的包含
`workingBranch`）、真實衝突（自動 `abort` 後 `baseBranch` 保持乾淨、無 `MERGE_HEAD` 殘留）、衝突
已解決但尚未 commit（判定為 `merge_in_progress` 而非籠統的 `dirty_working_tree`）、使用者手動解決
衝突並完成 merge commit 後透過 reconciliation 補上 `t.gitMerge`（不再是 409）、以及 merge 指令
本身回報成功但 repository 實際仍有 unresolved files（不採信該回報，一樣判定為衝突並自動
abort）。
