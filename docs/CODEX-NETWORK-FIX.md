# Codex 套件環境修正（2026-09-16）

TaskFlow 的 Codex 工作階段原先使用 workspace-write，未配置網路存取，npm ping 在引擎內連線至 127.0.0.1:9 而失敗。本機 npm ping 可正常連線。

已授權的執行與套件檢查階段加入 session scoped `sandbox_workspace_write.network_access=true`，保留 workspace-write 檔案隔離。唯讀規劃不加入此設定。npm 快取移至工作副本 `.taskflow/npm-cache`，避免寫入副本外的使用者快取。未修改全域 Codex 設定或 npm registry。

驗證：105 個自動測試通過。真實 Codex 預檢回傳 npm 11.17.0、官方 registry ping 成功（PONG 230ms）、toolAvailable/registryReachable/installationAllowed 皆 true。此預檢未實際安裝依賴；各專案仍須重新檢查及完成自己的安裝與建置驗證。

證據：`data/validation/network-1789553516657/report.json`。服務已在空閒時重新啟動，HTTP 200。原任務環境問題仍保留供使用者核准重新檢查。

官方設定說明：https://learn.chatgpt.com/docs/config-file/config-reference
