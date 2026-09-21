import 'dotenv/config';
import {createServer} from 'node:net';
import {resolveGuardianPort} from './ports.js';
import {writeFileSync} from 'node:fs';
import {runServiceRecovery} from './service-recovery.js';
import {createStore} from './db.js';
import {initServiceControl,stageCloudEvent,handleServiceRequests} from './service-control.js';
// 從網頁核准的重新啟動也走這支守護程式：主 server 不能自己殺自己，
// 否則沒有人能把結果寫回去，也沒有人能在失敗時把舊服務救回來。
import {handleControlRequests,initControlRequests,recoverStuckRestarts} from './control-requests.js';
import {createPreviewRegistryOwnershipProof,createRuntimePortManager} from './runtime-port-manager.js';
import {stopPid} from './process-lifecycle.js';
import {resolve} from 'node:path';
const store=createStore();initServiceControl(store);initControlRequests(store.db);
const previewRegistryPath=resolve('data/preview/registry.json');
const portLeasePath=resolve('data/runtime/port-leases.json');
// Runtime Port Pool 的定期 garbage collection：只清理磁碟上 port-leases.json 裡有明確
// ownership 證據（pid 出現在 Preview 登錄檔且健康檢查答得出來）的孤兒 lease。
// 絕不掃描 45000~45099 範圍看誰在監聽就動手——port 只是資源，process ownership 才是 kill 依據。
// 每次都重新從磁碟建立一個 portManager：Guardian 是獨立行程，本來就沒有主 server 那份記憶體帳本，
// 只能靠登錄檔對帳，用完即丟即可，不需要跨 tick 保留狀態。
async function runtimePortGc(){
  const portManager=createRuntimePortManager({leasePath:portLeasePath});
  const outcome=await portManager.reconcile({canProveOwnership:createPreviewRegistryOwnershipProof(previewRegistryPath),stop:lease=>stopPid(lease.pid)});
  if(outcome.reconciled.length)console.log(new Date().toISOString(),`[runtime-port] Guardian GC 已清理孤兒 lease：${outcome.reconciled.map(l=>`${l.port}(pid=${l.pid})`).join('、')}`);
}
const lock=createServer(socket=>socket.end());
lock.on('error',()=>{store.close();process.exit(1);});
async function request(path,body){
  const response=await fetch(`${process.env.INBOX_URL.replace(/\/$/,'')}${path}`,{method:'POST',headers:{authorization:`Bearer ${process.env.INBOX_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok){
    const detail=await response.json().catch(()=>({}));
    throw new Error(`Inbox HTTP ${response.status}${Number.isInteger(detail.upstreamStatus)?` (LINE HTTP ${detail.upstreamStatus})`:''}`);
  }return response.json();
}
async function repair(checkOnly=false){
  return runServiceRecovery({checkOnly});
}
let busy=false;
async function tick(){
  if(busy)return;busy=true;
  try{
    // Commit every event locally BEFORE acknowledging it. Ordinary messages stay
    // queued for the main service; they cannot hide recovery commands behind them.
    try{if(process.env.INBOX_URL&&process.env.INBOX_TOKEN){
      const {events}=await request('/runner/pull',{});
      for(const event of events){stageCloudEvent(store,event);await request('/runner/ack',{id:event.webhookEventId});}
    }}catch(e){console.error(new Date().toISOString(),'Cloud inbox unavailable',e.message);}
    await handleServiceRequests(store,{recover:()=>repair(),inspect:()=>repair(true),notify:body=>request('/runner/notify',body),onError:e=>console.error(new Date().toISOString(),'Service request failed',String(e.stderr||e.message||e.code||'').slice(-2000))});
    // 網頁核准的部署重啟。build=true：合併進 main 的原始碼要先建置，不然重啟後網頁還是舊的。
    recoverStuckRestarts(store);
    await handleControlRequests(store,{restart:()=>runServiceRecovery({build:true}),onError:e=>console.error(new Date().toISOString(),'Restart request failed',String(e.stderr||e.message||e.code||'').slice(-2000))});
    store.setSetting('guardianLastSuccess',new Date().toISOString());
  }catch(e){console.error(new Date().toISOString(),e.code||'Guardian cycle failed',String(e.message||'').slice(0,300));}
  finally{busy=false;}
}
// Guardian 的 port 同樣固定（TASKFLOW_GUARDIAN_PORT 或 4311），不受 runtime port 影響。
lock.listen(resolveGuardianPort(),'127.0.0.1',()=>{
  writeFileSync('data/service-guardian.pid',String(process.pid));
  console.log('TaskFlow LINE recovery guardian ready');void tick();setInterval(()=>void tick(),5000);
  // 獨立於 LINE 復原的 5 秒週期之外：runtime port GC 失敗不該拖累 LINE 復原，
  // 60 秒一次也足夠及時清掉孤兒 lease，不需要跟 tick() 搶同一個節奏。
  setInterval(()=>void runtimePortGc().catch(e=>console.error(new Date().toISOString(),'Runtime port GC failed',String(e.message||e).slice(0,300))),60000);
});
