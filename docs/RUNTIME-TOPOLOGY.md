# Project Runtime Topology 與 Multi-Service Preview

## 這份文件在解決什麼

整改前，TaskFlow 的 Preview／Browser Validation 隱含一個假設：

```
One Project = One Working Directory = One Runtime Process = One Preview
```

前後端分離的專案不符合這個假設。`server/project-preview.js` 的 `resolveWebRoot()` 只會回傳**一個**目錄，而 `detectWebProjectHere()` 只認得「有 vite 依賴 + build script」的目錄，所以 `backend/` 直接被判定成「不是網頁專案」而整個略過。結果是：

```
frontend preview 開得起來
  → /api/* 命中 express 的 SPA fallback（app.get('/{*path}') → index.html）
  → HTTP 200 text/html
  → 前端 JSON.parse 失敗，資料載不出來
  → Browser Validation 失敗
  → 被當成「功能壞掉」丟給 Repair Agent，或讓任務卡在 waiting_input
```

問題不在 `frontend/vite.config.ts`，也不在 stale preview process：**backend 從頭到尾沒有被啟動過**，而且那份 vite proxy 設定在 Preview 期間根本沒有生效——TaskFlow 並不執行 `vite preview`，而是自己用 express 靜態伺服 `dist/`。

## 模型

```
Task
 └── ProjectRuntimeTopology        server/runtime-topology.js
      ├── RuntimeService（backend） cwd / startCommand / port / healthCheck / dependsOn
      └── RuntimeService（frontend）cwd / proxyPaths / browserEntry / dependsOn: [backend]
```

一個 `RuntimeService` 有自己的 `PID / port / cwd / command / url / status / startedAt / fingerprint`。`Task` 與 `RuntimeService` 是分離的兩件事。

`mode` 由有沒有 `startCommand` 決定，不另外設定：

| mode | 意義 |
| --- | --- |
| `spawn` | TaskFlow 真的 spawn 一個子程序（後端、worker，或前端自己跑 dev/preview） |
| `managed` | TaskFlow 用自己的 express 伺服建置輸出，並負責把 `proxyPaths` 轉發到後端 |

前端預設走 `managed`。這是唯一能保證 `/api/*` 真的打到**本次配到的**後端 port 的做法：專案自己的 vite proxy target 幾乎都寫死 `localhost:3001`，而那個 port 在 Preview 期間沒有任何東西在聽。

## topology 的來源，依優先順序

1. `taskflow.runtime.json`／`.taskflow/runtime.json`／`package.json` 的 `taskflow.runtime`（`explicit_config`）
2. 專案 metadata（`project_metadata`）
3. 自動偵測（`auto_detection`）
4. 單一服務 fallback——`resolveRuntimeTopology()` 回傳 `null`，走整改前既有的 Preview 流程，行為完全不變

### 自動偵測規則

掃描專案根目錄的第一層子目錄，外加 `apps/*` 與 `packages/*`，略過 `node_modules`、`dist`、`docs`、`tests` 這類目錄。每個目錄依**依賴與設定檔**（不是目錄名稱）分類：

* frontend：`vite`／`next`／`nuxt`／`react-scripts`／`@angular/core`／`svelte`…，或 `vite.config.*`／`next.config.*`／`angular.json`
* backend：`express`／`fastify`／`koa`／`@nestjs/core`／`prisma`／`drizzle-orm`／`hono`…，或 `composer.json`／`artisan`／`prisma/schema.prisma`
* worker：具後端訊號且目錄名為 `worker`／`queue`／`jobs`／`consumer`

只有**同時看得到前端與後端**時才產生 multi-service topology。前端候選超過一個而且沒有恰好一個命中慣用名稱（`frontend`／`web`／`client`…）時，回傳 `null` 而不是硬挑一個——挑錯一個去驗收比不驗收更糟。

其他自動判斷：

* `healthCheck.path`：掃該服務的原始碼找 `'/api/health'`、`'/healthz'`、`'/ping'`、`'/status'` 這類路由。掃不到就標成 `inferred: true` 並改用 `anyHttpResponse`（「伺服器回應得出 HTTP 且不是 HTML」），不假裝有一個不存在的端點。
* `proxyPaths`：讀專案自己的 `vite.config.*`／`vue.config.js`／`next.config.js` 的 `proxy` 區塊，**只取路徑，不取 target**。讀不到就預設 `/api`。每一條都帶 `kind`（見下節）。
* `packageManager`：每個服務各自判斷（`pnpm-lock.yaml` / `yarn.lock` / `composer.json` / 預設 npm）。
* 後端**不**自動建置：`dev` script 幾乎都是從原始碼直接跑（`tsx watch`、`nodemon`、`artisan serve`），先跑一次 `tsc` 只是白花時間，而且 build 失敗會擋住一個其實跑得起來的服務。需要先建置的專案在明確設定寫 `buildCommand`。

## proxy namespace 與驗證端點是兩件事

這是最容易搞錯、而且搞錯會很吵的一個區別：

* `proxyPaths` 是 **namespace**。`/api` 的意思是「`/api/*` 轉發給後端」，**不**代表後端有實作 `GET /api`。拿 namespace 本身當端點去打，會得到一個完全合理的 404，然後被誤判成 `proxy_routing_failure`，接著整組 runtime 被沒必要地重啟——真正的問題反而被這些 noise 蓋掉。
* 驗證端點是**實際存在的路徑**，例如 `/api/health`、`/api/profile`。

每一條 proxy path 因此帶 `kind`：

| kind | 什麼 | 怎麼驗 |
| --- | --- | --- |
| `api` | JSON API namespace（`/api`、`/graphql`、`/trpc`…） | 用**已知端點**驗，期待 `application/json` |
| `static` | 檔案／媒體 namespace（`/uploads`、`/static`、`/media`、`/files`、`/assets`…） | 只證明「沒有落進 SPA fallback」。301 導向、404、`image/*`、`application/pdf` 全都合法 |

`kind` 由路徑推斷，明確宣告永遠優先。

驗證端點的來源依序是：

1. service 的 `validationProbes`（明確宣告）
2. 呼叫端另外指定的端點
3. 後端 `healthCheck.path`，而且**必須被某條 proxyPath 涵蓋**

三者都拿不到時（後端 health 是推測值、或不在轉發範圍內、或 static namespace 沒有可驗證的實際檔案），該項標成 **skipped 並附上原因**——不是 fail，也不是靜靜放行。

「落進 SPA fallback」的判準是**完整的 HTML 文件**（`<!doctype html>` / `<html>`），不是單看 `Content-Type: text/html`——express 的 `res.redirect()` 也會送一小段 `<p>Moved Permanently…</p>`，那不是 SPA fallback。

## 明確宣告格式

`taskflow.runtime.json`：

```json
{
  "runtime": {
    "services": [
      {
        "id": "backend",
        "type": "backend",
        "cwd": "backend",
        "startCommand": "npm run dev",
        "buildCommand": "npm run build",
        "healthCheck": {
          "path": "/api/health",
          "expectedStatus": 200,
          "expectedContentType": "application/json",
          "expectedJsonShape": { "ok": true }
        },
        "environment": { "DATABASE_URL": "file:./preview.db" }
      },
      {
        "id": "frontend",
        "type": "frontend",
        "cwd": "frontend",
        "dependsOn": ["backend"],
        "browserEntry": true,
        "proxyPaths": [
          { "path": "/api", "kind": "api" },
          { "path": "/uploads", "kind": "static" }
        ],
        "validationProbes": [
          { "path": "/api/profile" },
          { "path": "/uploads/seed.png", "kind": "static" }
        ]
      }
    ]
  }
}
```

`proxyPaths` 也接受純字串（`"/api"`），`kind` 會依路徑推斷。`validationProbes` 省略時由後端的 `healthCheck` 衍生。`type` 是 `frontend` / `backend` / `worker` / `database` / `other`。`cwd` 必須在專案目錄內（`../` 會被拒絕）。`browserEntry` 最多一個。`dependsOn` 不得成環、不得指向不存在的 service——兩者都在解析階段就丟出可讀的錯誤，不會等到啟動時才炸。`persistent: true` 的服務在 Task 結束時不會被停掉。

## 連接埠與環境變數

`PORT` 只代表「**這個** service 自己的 port」，不再同時兼任 backend／frontend／preview 三種身分。每個服務拿到：

```
PORT / HOST                          自己的
TASKFLOW_SERVICE_ID / _TYPE          自己的身分
BACKEND_URL / BACKEND_PORT           該型別唯一時才提供的別名
TASKFLOW_SERVICE_<ID>_URL / _PORT    一定提供，不會有歧義
FRONTEND_PORT / FRONTEND_URL         前端服務自己的
```

單一服務的 Preview 另外提供 `PREVIEW_PORT` / `PREVIEW_URL`。

連接埠一律向作業系統要（`allocatePort()`），不寫死任何數字。

## 啟動與驗證流程

```
Resolve Runtime Topology
  ↓  orderRuntimeServices()：依 dependsOn 拓撲排序，環狀相依直接拒絕
Start services（相依未 READY 就不啟動下游）
  ↓  waitForServiceHealth()：PID 存在不算 ready，一定要拿到符合契約的 HTTP 回應
Frontend Health           GET / → 200 + text/html
  ↓
Frontend → Backend Probe  GET {frontendUrl}/api/health → 必須是 application/json
  ↓
Browser Validation（Playwright）
  ↓
Cleanup：反向順序關閉 → 確認 PID 消失 → 確認連接埠釋放
```

### 為什麼要繞過前端打後端

直接打 backend port 只證明後端活著，證明不了前端那一層的轉發有沒有接上——而使用者在瀏覽器裡走的正是前端那一層。`validateApiResponse()` 會檢查 **status + Content-Type + body 可解析 + expectedJsonShape**，任何一項不符都判定未通過：

* 期待 `application/json`、實際 `text/html`（而且 body 是 HTML 文件）→ `proxy_routing_failure`
* `401` / `403` / `404` 但型別是 JSON → **通過**（後端真的接到了；重點是型別，不是狀態碼）
* `static` 類：`301` / `404` / `image/*` / `application/pdf` 全部通過，只有 SPA fallback 不通過
* 轉發目標不在 → managed 前端回 `502 application/json`，**絕不**交給 SPA fallback

## 失敗分類

```ts
type RuntimeFailureKind =
  | 'service_not_started' | 'service_start_failed' | 'service_unhealthy'
  | 'dependency_unavailable' | 'port_conflict' | 'proxy_routing_failure'
  | 'unexpected_content_type' | 'stale_runtime' | 'runtime_timeout'
  | 'browser_failure' | 'topology_unresolved' | 'unknown';
```

每一種都有責任歸屬（`failureOwner()`）：

| owner | 哪些 | 下一步 |
| --- | --- | --- |
| `taskflow` | `proxy_routing_failure`、`unexpected_content_type`、`stale_runtime`、`port_conflict`、`runtime_timeout`、`dependency_unavailable`、`service_not_started` | 自動回復；用盡後 `runtime_blocked`，**不**叫 Repair Agent、**不**進 waiting_input |
| `project` | `service_start_failed`、`service_unhealthy`、`browser_failure` | 自動回復用盡後仍起不來＝專案的程式問題，照既有流程進修正 |
| `user` | `topology_unresolved` | 唯一會進 waiting_input 的一種，並附上「請新增 taskflow.runtime.json」的具體指示 |

## Authoritative runtime state

回復會停掉舊的 runtime、再建一個新的。**誰是權威的 runtime 狀態必須有明確答案：最後一次實際建立起來的那一組**，由 `runtimePreflight()` 一路帶回呼叫端：

| 欄位 | 通過時 | 被 block 時 |
| --- | --- | --- |
| `info` / `previewUrl` | 有（Browser Validation 就在這上面跑） | `null`——runtime 已經收掉了，給一個指向死掉服務的網址只會誤導 |
| `runtime` | 目前這一組的服務快照 | **最後一次實際建立的那一組**的快照（這是「backend 曾經 READY、卡在轉發那一層」的唯一證據） |
| `shutdown` | `null`（由呼叫端負責停止） | preflight 在回復流程中停掉那一次的結果 |

少了後兩者，呼叫端就只能說「沒有後端服務」、cleanup 只能回 `[]`——與事件紀錄裡的 `runtime_service_ready backend` 自相矛盾。

## Runtime Fingerprint 與 service-level restart

指紋涵蓋：HEAD、該服務目錄的未提交變更摘要、`cwd`、`startCommand`、`buildCommand`、`proxyPaths`、`healthCheck`、`dependsOn`、注入的環境變數，以及 `package.json`／lock 檔／`vite.config.*`／`next.config.*`／`tsconfig.json`／`.env`／`prisma/schema.prisma`／根目錄 runtime 設定的內容雜湊。

指紋改變 → 該服務標成 `STALE` → **只重啟它與它的下游**，其餘沿用同一個程序。整個 Task 不會被砍掉重跑。

## 自動回復與 waiting_input

`MAX_RUNTIME_RECOVERY_ATTEMPTS = 2`。可回復的失敗會停掉整組 runtime 再重來（重新配 port、重新接轉發）。超過上限就標成 `runtime_blocked`，任務進 `failed` 並帶 `task.runtimeIssue`（含逐項檢查結果），畫面上提供「重新準備執行環境」（`POST /api/tasks/:id/runtime/retry`）。

**不可**進 waiting_input 的情況（計畫書第二十二章）：backend 沒啟動、frontend stale、Preview 需要 restart、port 被占用、proxy routing failure、health check timeout、child process dead。

**可以**進 waiting_input 的情況：需要使用者選擇方案、缺少憑證、需要明確核准、merge conflict、需求歧義，以及這次新增的 `topology_unresolved`。

## 結構化事件

```
runtime_topology_detected   runtime_service_starting   runtime_service_ready
runtime_service_failed      runtime_service_stale      runtime_service_restarting
runtime_service_stopped     runtime_proxy_validation_failed
runtime_api_validation_passed
runtime_preflight_passed    runtime_preflight_failed   runtime_blocked
browser_validation_started  browser_validation_completed
```

## 實機驗收

```
node scripts/runtime-acceptance.js <projectPath> [--json <報告路徑>] [--no-browser]
node scripts/runtime-topology-report.js <projectPath>
```

前者會真的啟動服務、真的經由前端打後端、真的開瀏覽器載入頁面、真的停掉並確認連接埠釋放，逐步輸出 PASS／FAIL 與原因。

## 相關檔案

| 檔案 | 責任 |
| --- | --- |
| `server/runtime-topology.js` | domain model、偵測、明確設定、相依圖、指紋 |
| `server/runtime-validation.js` | health check、API response semantics、connectivity、失敗分類 |
| `server/runtime-manager.js` | 多服務生命週期：啟動順序、port、PID、restart、cleanup |
| `server/runtime-recovery.js` | 失敗歸屬、自動回復、Browser Validation Preflight |
| `server/project-preview.js` | Preview 入口；multi-service 走 topology，單一服務維持原流程 |
| `server/runner.js` | 在 Browser Validation 之前執行 preflight，並處理 `RUNTIME_BLOCKED` |
