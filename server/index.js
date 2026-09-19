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
const server=app.listen(Number(process.env.PORT||4310),process.env.HOST||'127.0.0.1',()=>console.log(`TaskFlow: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||4310}`));
function stop(){runner.stop();bridge.stop();clearInterval(completionTimer);app.locals.completionPipeline?.stop();void app.locals.previews.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
