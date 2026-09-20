import 'dotenv/config';
import { createStore } from './db.js';
import { createRunner } from './runner.js';
import { createApp } from './app.js';
import { createBridge } from './line.js';
import { createProjectPreview } from './project-preview.js';
import { recoverCompletionTests } from './completion-test.js';
import { recoverStuckRestarts } from './control-requests.js';
import { recoverCompletionValidations } from './completion-validation.js';
import { reconcilePreviewRegistry, stopPid } from './process-lifecycle.js';
// 主服務的 port 是固定的基礎設施，不是由誰配發的 runtime 資源（server/ports.js）。
import { inheritedRuntimePorts, resolveMainHost, resolveMainPort } from './ports.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const store=createStore();
if(!store.db.prepare('SELECT id FROM users LIMIT 1').get()){console.error('請先執行 npm run setup 建立管理者。');process.exit(1);}
// 上次執行中被服務重啟打斷的測試比對不能留在「執行中」，否則畫面會永遠停在那個狀態。
recoverCompletionTests(store);
// 同理：守護程式若在重啟過程中被中斷，會留下永遠不會完成的「重新啟動中」請求。
recoverStuckRestarts(store);
recoverCompletionValidations(store);
// 上一個行程開的 Preview 子程序不會隨服務結束：記憶體那張表沒了，程序還活著。
// 只停掉「PID 還在、而且那個網址仍回應得出 Preview 健康檢查」的，認不出來的一律不動——
// PID 會被作業系統重複使用，殺錯就是殺掉使用者自己的程式。
void reconcilePreviewRegistry(resolve('data/preview/registry.json'),{stop:entry=>stopPid(entry.pid)})
  .then(outcome=>{
    if(outcome.stopped.length)console.log(`已清理上次殘留的 Preview 程序：${outcome.stopped.map(e=>e.pid).join('、')}`);
    for(const entry of outcome.unknown)console.warn(`保留未能確認身分的程序 PID ${entry.pid}：${entry.reason||''}`);
  })
  .catch(error=>console.error('Preview 程序對帳失敗',error.message));
const previews=createProjectPreview();
const runner=createRunner(store,{previews}),bridge=createBridge(store,{runner}),app=createApp(store,runner,{previews});
// Pipeline 的計時器由這裡持有，不由 createApp 持有：app 會在測試裡被建立很多次，
// 計時器留在那裡會在資料庫關閉後繼續跳。
const completionTimer=setInterval(()=>{
  try{app.locals.completionPipeline.tick();}
  catch(error){console.error(new Date().toISOString(),'Completion pipeline tick failed',String(error?.message||error).slice(0,300));}
},3000);
// 主服務的位置：TASKFLOW_PORT 或 4310。泛用的 PORT 屬於 runtime 子程序，這裡一律不看，
// 但如果它被繼承進來，就照實記錄一行——那是「為什麼服務跑到別的 port」唯一的直接證據。
const port=resolveMainPort(),host=resolveMainHost();
const inheritedPorts=inheritedRuntimePorts();
if(inheritedPorts.length)console.warn(`忽略從啟動環境繼承的 runtime port 變數：${inheritedPorts.join('、')}；主服務固定使用 ${port}。`);
const server=app.listen(port,host,()=>{
  const actual=server.address()?.port;
  // 綁到別的 port 就是啟動失敗，不是「換個 port 也能用」：Restart、Guardian、PUBLIC_ORIGIN
  // 與所有健康檢查都以這個 port 為準。
  if(actual!==port){console.error(`TaskFlow main server started on an unexpected port.\n\nExpected:\n${port}\n\nActual:\n${actual}`);process.exit(1);}
  // server.pid 必須是「現在真的在聽這個 port 的那一個主服務」。由服務自己在確定聽到之後寫，
  // 啟動腳本就不會把一個還沒成功、或根本綁錯 port 的 PID 留在檔案裡。
  try{writeFileSync(resolve('data/server.pid'),String(process.pid));}
  catch(error){console.error('無法寫入 data/server.pid',String(error?.message||error).slice(0,200));}
  console.log(`TaskFlow: http://${host}:${actual}`);
});
server.on('error',error=>{
  if(error?.code==='EADDRINUSE')console.error(`Port ${port} is already in use; TaskFlow main server did not start.`);
  else console.error('TaskFlow main server failed to start',String(error?.message||error).slice(0,300));
  process.exit(1);
});
function stop(){runner.stop();bridge.stop();clearInterval(completionTimer);app.locals.completionPipeline?.stop();void app.locals.previews.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
