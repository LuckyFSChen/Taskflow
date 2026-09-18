# TaskFlow 雲端收件匣（Cloudflare Worker + D1）

這個目錄是 TaskFlow 的**雲端收件匣**：一個獨立於本機服務之外、部署在 Cloudflare
的 Worker，搭配 D1 資料庫，專門負責：

1. 接收並驗簽 LINE 的 webhook，把已驗證的事件原封不動存進 D1（不解讀內容、不執行任何指令）。
2. 讓本機唯一的 runner（`server/line.js` 的 `createBridge`）用共用 token 定期拉取尚未確認的事件、逐筆確認（ack）。
3. 讓本機 runner 委託這個 Worker 呼叫 LINE 的推播（push）API 送出訊息，避免本機需要固定對外 IP 或網域。

對應 `docs/SPEC.md` 的設計：本機關機時，雲端仍持續收件；本機恢復後再拉取、入庫、確認，
已成功存入雲端資料庫的事件可在本機恢復後處理；實際收件仍受 LINE 投遞、雲端可用性及服務配額影響。

> **目前狀態（2026-09-16）**：已部署至 https://taskflow-cloud-inbox.bigtw178.workers.dev ，D1 與本機連線密鑰也已設定。LINE 的 Channel secret / access token 尚待設定。詳見 `../docs/CLOUDFLARE-DEPLOYMENT.md`。以下建立資源的步驟供日後重建參考，目前帳號不要重複建立。

## 檔案說明

| 檔案 | 用途 |
| --- | --- |
| `worker.js` | Worker 主程式（ESM，`export default { fetch }`），同時匯出可測試的小函式 |
| `migrations/0001_init.sql` | D1 schema：`events` 資料表 |
| `wrangler.jsonc` | Wrangler 設定範本（不含真實帳號、資料庫 ID 或密鑰） |
| `worker.test.js` | `node:test` 單元測試，用假的記憶體版 D1 模擬，不需要真的部署 |

沒有任何 npm 套件依賴；`worker.js` 只使用 Cloudflare Workers／Node 24 都支援的
標準 Web API（`crypto.subtle`、`TextEncoder`、`fetch`、`Response`、`URL`）。

## API 端點與協定

這組協定是配合本機 `server/line.js` 的既有實作設計的，**格式必須完全一致**：

### `POST /line/webhook`
- LINE 平台呼叫。用 `X-Line-Signature`（對 raw body 做 HMAC-SHA256，再 base64
  編碼）驗證，密鑰是 `LINE_CHANNEL_SECRET`。驗證使用 Web Crypto 的 HMAC verify。
- 限制 body 大小 1MB；超過回 `413`。
- 空 body 或無法解析的 JSON、或事件缺少 `webhookEventId` → `400`。
- 簽章錯誤 → `401`。
- 驗證通過後，把每個事件依 `webhookEventId` 唯一去重、原始 JSON 完整保存到
  D1 的 `events` 資料表；**全部落地成功才回 `200`**（用 `DB.batch` 確保這點）。
- 事件內容（例如使用者傳來的文字）只當成資料儲存，**絕對不會被當成伺服器指令執行**——
  指令解析是本機 `server/line.js` 收到已入庫事件後，在自己的網域邏輯裡才做的事。

### `POST /runner/pull`
- 需要 `Authorization: Bearer <INBOX_TOKEN>`。
- 回傳 `{ events: [...] }`，最多 30 筆**尚未確認**的事件，依收到順序排列，
  每個元素就是原本存進去的事件物件（不是包一層 metadata）。
- 因為只有一台本機 runner 在拉取，且事件去重在本機交易內完成，這裡刻意不做
  租約（leasing）機制——at-least-once 交付即可。

### `POST /runner/ack`
- 需要 bearer 驗證。Body：`{ "id": "<webhookEventId>" }`。
- 標記該事件為已確認；**冪等**——重複 ack 同一 id、或 ack 不存在的 id，都回
  `{ ok: true }`，不會報錯。
- 確認後**不會刪除**資料列。要清理已確認的舊資料，見下方「保留與清理」。

### `POST /runner/notify`
- 需要 bearer 驗證。Body：`{ "to": "<LINE userId>", "text": "...", "retryKey": "<uuid>" }`。
- 驗證：`to` 必須符合 `U` + 32 碼十六進位；`retryKey` 必須是合法 UUID 格式；
  `text` 必須是非空字串（超過 4900 字元會被裁切，對齊 LINE 訊息長度限制）。
- 用 `env.LINE_CHANNEL_ACCESS_TOKEN` 呼叫 LINE 的
  `POST https://api.line.me/v2/bot/message/push`，並帶上
  `X-Line-Retry-Key: <retryKey>` 讓 LINE 端做重試去重。
- 上游回應 2xx，或 `409`（LINE 判定為重複請求）都視為成功，回 `{ ok: true }`。
- 有 15 秒逾時；**不會**把 channel token 或任何機密寫進回應內容或 log。

### `GET /health`
- 不需要驗證，回 `{ ok: true }`；不包含任何機密或內部狀態。

### 其他
- 未列出的路徑一律 `404`；已知路徑用了錯的 HTTP method 回 `405`。
- 沒有任何 CORS 標頭（尤其不會有 `Access-Control-Allow-Origin: *`）——這個
  Worker 只給伺服器對伺服器呼叫（LINE 平台、本機 runner），不是給瀏覽器直接呼叫。
- 沒有任何 DB 管理／查詢用的額外端點。
- 未預期的例外一律回通用的 `500 { "error": "internal error" }`，不外洩堆疊或設定內容。

## 部署步驟（需要你自己的 Cloudflare 與 LINE 帳號）

以下指令都在 `cloud-inbox` 目錄下執行，用 `npx wrangler`（不需要另外把
wrangler 加進本專案的 `package.json`）。

1. **登入 Cloudflare**
   ```
   npx wrangler login
   ```

2. **建立 D1 資料庫**
   ```
   npx wrangler d1 create taskflow-inbox
   ```
   指令會印出一組 `database_id`，把它填進 `wrangler.jsonc` 的
   `d1_databases[0].database_id`（並視需要把 `database_name`／`name` 改成你想要的名稱）。

3. **套用資料庫 schema**
   ```
   npx wrangler d1 execute taskflow-inbox --remote --file=./migrations/0001_init.sql
   ```
   本機開發時想用本機模擬的 D1，另外執行一次 `--local` 版本：
   ```
   npx wrangler d1 execute taskflow-inbox --local --file=./migrations/0001_init.sql
   ```

4. **設定機密（一定要用 `secret put`，不要寫進 `wrangler.jsonc` 或版本庫）**
   ```
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put INBOX_TOKEN
   ```
   - `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` 從 LINE Developers
     console 的 Messaging API channel 頁面取得。
   - `INBOX_TOKEN` 是你自己產生的長隨機字串，例如：
     `node -e "console.log(require('crypto').randomUUID()+require('crypto').randomUUID())"`
     這個 token 會同時用在本機 `.env`（見下方）與這裡，**不要**放進前端程式碼。

5. **部署**
   ```
   npx wrangler deploy
   ```
   成功後會得到一個 `https://<worker 名稱>.<你的 account>.workers.dev` 網址
   （或你自訂的網域，如果有另外在 Cloudflare 設定 route）。這個網址不需要
   固定 IP，本機也不需要對外開放任何連接埠。

6. **設定 LINE webhook**
   到 LINE Developers console 的 Messaging API 頁面：
   - Webhook URL 填 `https://<你的 worker 網址>/line/webhook`
   - 開啟「Use webhook」
   - 用 console 內建的「Verify」按鈕測試連線；驗證請求也需通過簽章檢查，
     `events` 可為空陣列，此時應回 `200`。若出現 `401`，請檢查 channel secret 與原始 body，不要略過驗簽。
     官方說明：[驗證 webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)、[驗證簽章](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)。

7. **設定本機 TaskFlow 服務**
   在本機 `.env`（或環境變數）加入：
   ```
   INBOX_URL=https://<你的 worker 網址>
   INBOX_TOKEN=<步驟 4 設定的同一個 INBOX_TOKEN>
   ```
   `server/line.js` 的 `createBridge` 會用這兩個值定期呼叫
   `/runner/pull`、`/runner/ack`、`/runner/notify`。設定好之後**不需要**
   再另外設定本機的 `LINE_CHANNEL_ACCESS_TOKEN`（推播改由 Worker 代打）；
   若沒有設定 `INBOX_URL`/`INBOX_TOKEN`，本機才會退回直接用
   `LINE_CHANNEL_ACCESS_TOKEN` 自行呼叫 LINE API 的舊路徑。

   **絕對不要**把 `INBOX_TOKEN` 放進前端（Vue）程式碼或任何會送到瀏覽器的
   設定；它只應該存在於本機伺服器的環境變數裡。

## 本機開發／測試

- 跑 Worker 本地模擬（含本機版 D1）：
  ```
  npx wrangler dev --local
  ```
  搭配一份不進版本庫的 `.dev.vars` 檔（同目錄下建立），內容例如：
  ```
  LINE_CHANNEL_SECRET=dev-secret
  LINE_CHANNEL_ACCESS_TOKEN=dev-token
  INBOX_TOKEN=dev-inbox-token
  ```

- 跑單元測試（不需要 wrangler、不需要真的部署，純 Node）：
  ```
  node --test cloud-inbox/worker.test.js
  ```
  測試用記憶體內的假 D1 模擬 `prepare/bind/run/all/batch`，涵蓋簽章驗證、
  bearer 驗證、去重、pull/ack 冪等性、notify 的格式驗證與裁切、以及
  「LINE 文字內容不會被當成指令執行」這條安全要求。

## 保留與清理（Retention）

- **未確認（`acknowledged_at IS NULL`）的事件永遠不會被自動刪除或過期**——
  就算本機 runner 長時間沒有上線，事件也會一直留著等它來拉。
- 已確認的事件預設也會一直留著（作為稽核紀錄）。如果想清理舊的已確認事件，
  這是**你自行決定要不要做、要多久做一次**的手動操作，例如：
  ```
  npx wrangler d1 execute taskflow-inbox --remote --command "DELETE FROM events WHERE acknowledged_at IS NOT NULL AND acknowledged_at < datetime('now', '-30 days')"
  ```
  這個專案**不包含**任何自動清理的排程或程式碼，也沒有任何對外的 DB
  管理端點——清理與否、保留多久，完全由你手動掌控。

## 已知限制 / 尚未做到的事

- Cloudflare Worker 與 D1 已建立、部署並驗證本機連線；尚未設定 LINE channel 密鑰及 webhook，也沒有實際發送過 LINE 訊息。
- LINE 官方帳號的訊息推播有其**配額限制**（依方案而定，例如免費方案的月推播
  則數上限），實際可發送量請自行到 LINE Official Account Manager 確認；本
  Worker 不會幫你追蹤或限制配額，超過配額時 LINE API 會回非 2xx／非 409
  的錯誤，本 Worker 會如實回報 `502`。
- 測試使用的假 D1 只覆蓋 `worker.js` 實際用到的三種語句形態，**不是**
  D1/SQLite 的完整模擬；真正部署後仍建議先用 `wrangler dev --local`
  搭配 `--local` 版 D1 手動打一次三個 runner 端點與 webhook 端點。
- 本檔案與程式碼本身無法驗證 LINE 平台的網路可達性、Cloudflare 帳單設定或
  自訂網域憑證是否就緒，這些都需要你在自己的帳號內確認。
