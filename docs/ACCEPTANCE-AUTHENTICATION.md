# 部署驗收認證（Acceptance Authentication Runtime）

需要登入的專案，部署驗收曾經永遠停在 `/api/login` 401。這份文件說明修正後的機制、
專案端要怎麼配合，以及失敗代碼怎麼讀。

實作：`server/acceptance-auth.js`、`server/project-preview.js`、`server/deployment-validation.js`。

---

## 1. 為什麼會 401（根因）

`startFullstack()` 每次啟動 Preview 都重新亂數產生一組密碼，但只有在 Preview 資料庫
**完全沒有使用者**時才寫進去：

```js
// 修正前
const password = randomBytes(18).toString('base64url');
if (!seedStore.db.prepare('SELECT id FROM users LIMIT 1').get())
    seedStore.addUser('TaskFlow Preview', username, password, 'admin');
```

Preview 資料庫（`data/preview/<key>/taskflow.sqlite`）是跨次保留的。所以第一次之後，
validator 手上的新密碼與資料庫裡的舊雜湊永遠對不起來——401 是**必然**，不是偶發。

修正：`store.upsertUser()`，每次啟動都把驗收帳號的密碼重設成這一輪的那一組；
Preview 停止時 `removeAcceptanceUser()` 把帳號與工作階段一起刪掉。

---

## 2. AcceptanceContext

帳密只在一個地方產生，Preview 與 Deployment Validator 共用同一份：

```text
createAcceptanceContext()
   ↓ acceptanceEnvironment()  → Preview child process env
   ↓ upsertUser()             → Preview DB（TaskFlow 結構的專案）
Preview 啟動
   ↓ authenticatePreview()    → session（cookie / bearer）
API 驗收 /api/state
Browser Validation（同一組身份）
   ↓ cleanupAcceptanceContext() + removeAcceptanceUser()
```

不得使用正式帳密，不得修改專案 `.env`，不得建立永久驗收帳號，不得寫死測試帳密。

---

## 3. 注入 Preview 的環境變數

```text
TASKFLOW_ACCEPTANCE_MODE=1
TASKFLOW_ACCEPTANCE_ID
TASKFLOW_ACCEPTANCE_AUTH_MODE    none | credentials | bearer | custom
TASKFLOW_ACCEPTANCE_USERNAME
TASKFLOW_ACCEPTANCE_EMAIL
TASKFLOW_ACCEPTANCE_PASSWORD
TASKFLOW_ACCEPTANCE_TOKEN
```

TaskFlow 自己的專案不需要做任何事：帳號已經直接寫進隔離的 Preview 資料庫。

**其他專案**（非 TaskFlow 資料庫結構）在啟動時可以自己建立這個暫時帳號：

```js
if (process.env.TASKFLOW_ACCEPTANCE_MODE === '1') {
  ensureAcceptanceUser({
    username: process.env.TASKFLOW_ACCEPTANCE_USERNAME,
    email:    process.env.TASKFLOW_ACCEPTANCE_EMAIL,
    password: process.env.TASKFLOW_ACCEPTANCE_PASSWORD,
  });
}
```

```php
if (env('TASKFLOW_ACCEPTANCE_MODE')) {
    // 建立 runtime acceptance user
}
```

這個帳號只能建立在 Preview／暫時資料庫（TaskFlow 會用 `TASKFLOW_DB_FILE` 指定），
不得進入正式資料庫。

---

## 4. 專案宣告登入方式：`taskflow.acceptance.json`

放在專案根目錄。有這個檔案就完全照它做，不做任何猜測：

```json
{
  "authentication": {
    "mode": "credentials",
    "login": {
      "method": "POST",
      "path": "/api/login",
      "body": { "email": "$acceptance.email", "password": "$acceptance.password" }
    },
    "state": { "method": "GET", "path": "/api/me" },
    "session": { "type": "cookie" }
  }
}
```

可用的佔位符：`$acceptance.username`、`$acceptance.email`、`$acceptance.password`、
`$acceptance.token`、`$acceptance.id`。

### 四種 mode

| mode | 行為 |
| --- | --- |
| `none` | 完全不登入，直接驗 health → state |
| `credentials` | 打登入端點，接受 Set-Cookie 或 JSON token |
| `bearer` | 不需要登入端點，直接用注入的一次性 token 當 `Authorization: Bearer` |
| `custom` | 專案自備 acceptance adapter；尚未提供 adapter 時回 `auth_mode_unsupported`，不會污染核心流程 |

沒有設定檔時，TaskFlow 只做**有限的** convention detection：路徑依序試
`/api/login`、`/login`、`/api/auth/login`（只有在回 404 時才往下試），欄位先試
`username/password`，只有在回 400／422 時才改試 `email/password`。401 不會換欄位重問。

---

## 5. 驗收狀態機

```text
PREVIEW_READY → HEALTH_VALIDATED → AUTHENTICATING → AUTHENTICATED → API_VALIDATED → PASSED
失敗：HEALTH_FAILED / AUTH_FAILED / API_FAILED / PREVIEW_NOT_STOPPED
```

`passed` 的判定（不得只看 health 200，也不得只看 Preview 停掉）：

```text
passed = previewStarted
      && healthPassed
      && authenticationPassedIfRequired
      && apiValidationPassed
      && previewStopped(且 PID 已確認消失)
```

---

## 6. 失敗代碼與責任歸屬

| failureCode | failureCategory | 意思 |
| --- | --- | --- |
| `credentials_missing` | taskflow_infrastructure | TaskFlow 沒產生一次性帳密 |
| `credentials_not_injected` | taskflow_infrastructure | 產生了但沒送進 Preview（不會真的送出空帳密登入） |
| `session_not_propagated` | taskflow_infrastructure | 登入成功但工作階段沒帶到後續請求 |
| `login_endpoint_not_found` | project_defect | 登入端點 404：架構缺陷，不是「未登入的正常行為」 |
| `login_payload_invalid` | project_defect | 端點不接受這組欄位（400／422） |
| `authentication_failed` | project_defect | 帳密被拒（401／403） |
| `login_server_error` | project_defect | 登入端點 500 |
| `login_unreachable` | preview_runtime | Preview 沒有回應 |
| `auth_mode_unsupported` | taskflow_infrastructure | 專案宣告的認證方式尚未支援 |

`taskflow_infrastructure` 類別的失敗**不是使用者專案驗收失敗**，事件訊息會明確標示，
不得要求使用者去改自己的程式。

---

## 7. 祕密處理

完整的 password／token／cookie 只存在於這個行程的記憶體與 Preview 子程序的環境變數。
不得進入 log、資料庫、任務結果、UI 或通知：

- `maskSecrets()` 會把祕密值、`password`／`token`／`cookie`／`authorization` 形狀的欄位換成 `[redacted]`。
- 診斷只輸出：端點、狀態碼、送出的**欄位名稱**、是否注入成功、遮蔽後的回應內容。
- `/api/projects/:id/preview` 等 API 回傳前會拿掉 `credentials` 與 `acceptance`。
- 唯一的例外是交給本機 Browser Validation Agent 的 prompt：它必須拿到帳密才能實際登入操作，
  那組帳密是一次性的，Preview 結束即失效，且不會寫進任務結果或資料庫。

---

## 8. 測試

- `tests/acceptance-auth.test.js`：身份產生、環境變數、設定檔、四種 mode、失敗代碼、遮蔽、清除。
- `tests/deployment-validation.test.js`：狀態機、session propagation、診斷、結果結構。
- `tests/acceptance-preview.test.js`：真的 spawn 子程序——環境變數注入、完整驗收、
  **同一個 key 重複啟動仍登得進去（401 回歸測試）**、失敗時的 cleanup、資料庫隔離、密碼重設。
- `tests/browser-validation.test.js`：Browser Validation 使用同一組 Acceptance Identity。
- `scripts/acceptance-e2e.mjs`：真實 Preview 端到端驗收（health → login → state → browser → cleanup）。
