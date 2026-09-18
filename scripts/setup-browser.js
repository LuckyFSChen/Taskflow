// Install-time only. Never run automatically by the TaskFlow server itself —
// see docs/BROWSER-VALIDATION.md §Setup. Checks first, then installs only
// what is actually missing.
import {spawnSync} from 'node:child_process';
import {resolvePlaywrightMcpEntry,resolveBrowserExecutable,checkClaudeBrowserCapability,resetBrowserCapabilityCache} from '../server/browser-capability.js';

console.log('檢查 Browser Validation（Claude Code + Playwright MCP）安裝狀態…');
const entry=resolvePlaywrightMcpEntry();
if(!entry){
  console.error('找不到 @playwright/mcp。請先執行 npm ci 或 npm install（此套件已列在 devDependencies）。');
  process.exitCode=1;
}else{
  console.log('已找到 @playwright/mcp：'+entry);
  const executable=resolveBrowserExecutable();
  if(executable){
    console.log('已偵測到可用的瀏覽器執行檔：'+executable+'，略過下載。');
  }else{
    console.log('尚未偵測到本機 Chromium，開始下載（僅限本次 setup 手動執行，伺服器啟動時不會自動下載）…');
    const npx=process.platform==='win32'?'npx.cmd':'npx';
    const result=spawnSync(npx,['--yes','playwright','install','chromium'],{stdio:'inherit',shell:process.platform==='win32'});
    if(result.status!==0){console.error('Chromium 下載失敗，請檢查網路後重試 npm run setup:browser。');process.exitCode=1;}
  }
}
if(!process.exitCode){
  resetBrowserCapabilityCache();
  const capability=await checkClaudeBrowserCapability({cache:false});
  console.log('Browser Validation 能力偵測結果：'+JSON.stringify(capability));
  if(!capability.available)process.exitCode=1;
}
