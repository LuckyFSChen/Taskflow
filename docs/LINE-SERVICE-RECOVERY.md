# LINE 服務重啟與驗證

## 2026-09-17 修正

- 原先 `重啟服務` 只在健康檢查失敗時啟動服務；現在守護程式使用 `Recover-TaskFlow.ps1 -Restart`，要求更換主服務程序。
- 重啟前保留程序身分檢查與 AI 工作保護。存在執行中的任務或 LINE AI 對話時，拒絕中斷工作。
- `最新網址` 使用 `-CheckOnly`，不會重啟主服務。一般啟動腳本仍採用既有的健康檢查與恢復行為。
- 新的服務指令保留 webhook reply token，結果在有效期內優先使用 LINE Reply API；過期或被 LINE 明確拒絕的 token 回退至原有 Push API。
- 通知失敗會記錄錯誤並採用 10 秒起、最長 1 小時的退避重試；失敗的一筆不會阻塞其他結果。重試沿用原本 retry key，也不會再次執行重啟。
- 雲端收件服務回傳 LINE 上游 HTTP 狀態碼，守護程式不再只留下空白的 `Guardian cycle failed`。
- Windows 背景服務會繼承原本 `execFile` 的輸出管線，導致 PowerShell 已退出但呼叫端仍等待。改以 `stdio: ignore`、結果檔及程序退出事件確認完成，避免已啟動成功卻無法及時回覆。

## 已確認的故障證據

正式環境的一筆服務恢復結果已完成，但通知持續失敗。補上診斷後確認為 `Inbox HTTP 502 (LINE HTTP 429)`。429 本身不能區分月訊息額度與短期 API 限速，因此不把它直接判定為額度用完。

## 驗證方式

1. 執行 `npm test`，涵蓋指令權限、去重、過期、綁定撤銷、通知退避、直接回覆及回退路徑。
2. 使用 `Recover-TaskFlow.ps1 -CheckOnly` 驗證本機及正式 HTTPS `/api/health`。
3. 在 AI 工作結束後，以 `-Restart` 驗證 `data/server.pid` 更換、主服務與公開網址恢復。
4. 使用手機 LINE 傳送 `最新網址`、`重啟服務`；確認收到回覆並核對 `service_requests` 的 `status`、`sent`、`error`。API 成功不等於手機已讀。

目前已通過 127 項自動測試與正式 HTTPS 健康檢查。2026-09-17 手機傳送「最新網址」後，使用者確認收到網址，本機對應紀錄為 `done`、`sent=1`、`attempts=0`、`error=null`。

首次實際重啟驗證遇到執行中的 AI 任務，保護機制正確拒絕中斷。暫停新派工並等待原任務完成後，最終版本在約 3.5 秒內完成重啟：PID `50088` → `7884`，正式網址 `https://taskflow.lucky0504.idv.tw` 健康檢查通過。證據位於 `data/service-restart-verification.json`。原派工設定已恢復為啟用。

`node scripts/verify-service-restart.js` 可重跑等待閒置、暫停新派工、重啟及恢復設定的驗證；最長等待 30 分鐘，不取消既有 AI 任務。

使用者接著由手機送出的正式「重啟服務」事件也已完成：PID `7884` → `43664`，對應紀錄為 `done`、`sent=1`、`attempts=0`、`error=null`，守護程式沒有新增錯誤。此項確認了真實 LINE 收件、主服務重啟、公開健康檢查及 LINE API 接受回覆的完整路徑。

Reply token 的使用限制以 [LINE 官方 API 文件](https://developers.line.biz/en/reference/messaging-api/#send-reply-message) 為準。長時間離線或超過 token 有效期的恢復結果仍依賴 Push API 可用性。

## 一般聊天回覆修正

後續確認一般聊天的 GPT 生成紀錄為 `completed`，但相應 outbox 一直 `sent=0`、回報雲端 502；原本只有服務控制指令接上 Reply API，聊天仍使用 Push API。

- `line_chats` 與 `outbox` 保存回覆 token 及期限，回答產生後把有效期一併交给發送佇列。
- GPT 完成後立即觸發送出，有效的直接回覆優先於舊的失敗推播；成功後清除 token。
- 過期 token 不送給 Reply API；無有效 token 時仍保留原有推播重試。舊的未送出回答不會憑空取得新 token。
- 未知指令和一般文字可聊天，已知指令、建立任務流程、核准與帳號隔離仍保留原有規則。
- 回歸測試 `npm test`：129 項通過；新增涵蓋未知指令經 GPT 到實際通知介面的 token 傳遞、舊推播積壓、過期 token 與 GPT 失敗回覆。
- 修正上線時主服務 PID `43664` → `58280`，正式健康檢查成功，原派工設定已恢復。
