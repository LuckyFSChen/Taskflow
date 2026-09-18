# Cloudflare 部署紀錄

部署日期：2026-09-16。Cloudflare Worker 與 D1 已實際建立，不是預覽或模擬。

- Worker：`taskflow-cloud-inbox`
- 正式網址：https://taskflow-cloud-inbox.bigtw178.workers.dev
- LINE Webhook：https://taskflow-cloud-inbox.bigtw178.workers.dev/line/webhook
- D1：`taskflow-inbox`，APAC，binding `DB`
- D1 ID：`73ba82ce-6f8c-4a0e-8876-60616c2e4fe3`
- 部署版本：`2c3bd5e6-cfdc-401f-8bf4-43178572be61`
- 本機 `.env` 已設定 INBOX_URL / INBOX_TOKEN。密鑰未寫入此文件。

## 已驗證
- 公開 `/health`：200。
- 不帶密鑰的 `/runner/pull`：401。
- 帶本機密鑰的 `/runner/pull`：200，D1 查詢成功。
- INBOX_TOKEN 已確認為 Cloudflare `secret_text`。
- 雲端收件匣相關 18 個本機測試通過；正式 LINE 事件尚未測試。

## 尚需填入 LINE 設定
Cloudflare 後台 → Workers & Pages → taskflow-cloud-inbox → Settings → Variables and Secrets：

| Secret 名称 | 填入值 |
| --- | --- |
| LINE_CHANNEL_SECRET | LINE Developers → Basic settings → Channel secret |
| LINE_CHANNEL_ACCESS_TOKEN | LINE Developers → Messaging API → Channel access token |

兩筆均設為 Secret，儲存並部署。保留已建立的 INBOX_TOKEN，不需變更。

LINE Developers → Messaging API：Webhook URL 填上面的 LINE Webhook 網址，開啟 Use webhook，再按 Verify。首次設定時也請檢查預設自動回應，避免和 Bot 回覆重複。

完成後，在本機工作台的平台設定產生 LINE 連結碼，私訊 Bot 綁定成員。正式發送測試訊息應由使用者完成；此次部署沒有向任何 LINE 用戶發訊息。

注意：本機平台顯示收件匣已連線，只代表 Windows 能讀取雲端收件資料庫，不代表 LINE Channel secret、access token 或 webhook 已驗證成功。缺少 LINE 設定時，雲端仍會拒絕處理 LINE webhook。

雲端僅部署收件服務；Vue 工作台仍在 Windows，未公開到 Internet，也尚未設定 Cloudflare Tunnel。
