# Windows 子程序執行阻礙（2026-09-16）

圖片任務安裝 sharp 時，npm log 顯示 esbuild postinstall 建立子程序發生 EPERM，Node 測試執行器也無法啟動。

使用 scripts/probe-child-process.cjs 實測：一般本機環境的 Node 子程序與 cmd 空指令都 exit 0；同一檔案在 Codex workspace-write、network_access=true、目前 unelevated 沙箱內，兩項皆為 EPERM。沒有證據可以認定是防毒或檔案鎖。

測試官方建議 elevated 沙箱時，初始化回報 helper_sandbox_lock_failed / SetNamedSecurityInfoW sandbox dir failed: 5。這是 Windows 沙箱設定的存取權阻礙，尚未排除，不能宣稱 sharp 已安裝或功能已完成。不要停用防毒或改成無沙箱來掩蓋失敗。

TaskFlow 已補上 Node 與安裝腳本 shell 的子程序探針，隨同引擎內 npm 預檢執行；npm ping 成功不足以判定可安裝。預檢快取版本已更新。尚需完成 Windows 沙箱管理員設定後重新驗證實際安裝、測試及圖片功能。

官方指引：https://learn.chatgpt.com/docs/windows/windows-sandbox

## 修復與實測結果

使用者以管理員 takeown 將 `.sandbox-bin` 擁有者恢復為自己的帳號後，沙箱初始化成功。TaskFlow 對 Windows Codex 工作階段使用 elevated 沙箱，仍保留 workspace-write/read-only 邊界。

沙箱內建 Node 沒有 npm，原本位於使用者 AppData 的另一套 Node 則無法由沙箱帳號執行。因此使用 `node scripts/setup-node-runtime.js` 將已安裝的 Node/npm 公開工具檔複製到 `data/tools/node`，在 TaskFlow 的 Codex 工作階段 PATH 指向此工具環境。沒有複製個人 npm 設定或憑證，也沒有放寬原安裝目錄權限。

實測 `node scripts/smoke-sandbox-npm.js` 通過：沙箱內 npm 11.17.0、npm install sharp 成功、Node 測試執行器成功啟動並完成 8x8 → 4x4 圖片縮放。證據位於 `data/validation/npm-sandbox-1789554951508/report.json`。107 項自動測試通過；恢復未完成步驟時不再跳到下一步。

工具環境可用上述 setup 指令重新建立（例如主機 Node 更新後）。實際任務仍需依其目前計畫完成安裝、實作與獨立驗證；測試工作區成功不代表任務成果已完成。
