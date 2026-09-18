import {randomUUID} from 'node:crypto';
import {initDeliveryState,claimDelivery} from './delivery-state.js';

function securePublicOrigin(value){
  if(typeof value!=='string')return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.includes('.'))return null;
    return url.origin;
  }catch{return null;}
}

export function serviceCommand(event){
  if(event.source?.type!=='user')return null;
  if(event.type==='postback')return {'tf:service-restart':'restart','tf:service-url':'url'}[event.postback?.data]||null;
  if(event.type!=='message'||event.message?.type!=='text')return null;
  return {'重啟服務':'restart','重新啟動服務':'restart','/restart':'restart','最新網址':'url','服務網址':'url','/url':'url'}[event.message.text.trim()]||null;
}
export function initServiceControl(store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS cloud_relay(event_id TEXT PRIMARY KEY,raw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS service_requests(event_id TEXT PRIMARY KEY,line_id TEXT NOT NULL,binding_id TEXT,action TEXT NOT NULL,created INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reply TEXT,retry_key TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);`);
  const columns=store.db.prepare('PRAGMA table_info(service_requests)').all().map(c=>c.name);
  for(const [name,type] of [['attempts','INTEGER NOT NULL DEFAULT 0'],['next_try','INTEGER NOT NULL DEFAULT 0'],['error','TEXT'],['reply_token','TEXT']]){
    if(!columns.includes(name))store.db.exec(`ALTER TABLE service_requests ADD COLUMN ${name} ${type}`);
  }
  initDeliveryState(store.db,'service_requests');
}
export function acceptServiceCommand(store,event){
  const action=serviceCommand(event);if(!action)return false;
  if(!event.webhookEventId)throw new Error('Missing event id');
  initServiceControl(store);
  store.transaction(()=>{
    if(store.db.prepare('SELECT 1 FROM inbox WHERE event_id=?').get(event.webhookEventId))return;
    const link=store.lineLink(event.source.userId),user=link&&store.user(link.user_id);
    let reply=null;
    if(!link)reply='請先在 TaskFlow 綁定 LINE 帳號，才能操作服務。';
    else if(action==='restart'&&user?.role!=='admin')reply='只有已綁定的管理者可以重啟服務。';
    else if(!Number.isFinite(event.timestamp)||Date.now()-event.timestamp>15*60000||event.timestamp>Date.now()+60000)reply='這筆服務指令已過期，請重新傳送「重啟服務」或「最新網址」。';
    store.db.prepare('INSERT INTO inbox VALUES (?,?)').run(event.webhookEventId,new Date().toISOString());
    store.db.prepare('INSERT INTO service_requests(event_id,line_id,binding_id,action,created,status,reply,retry_key) VALUES (?,?,?,?,?,?,?,?)').run(event.webhookEventId,event.source.userId,link?.id||null,action,event.timestamp||Date.now(),reply?'done':'pending',reply,randomUUID());
    if(typeof event.replyToken==='string'&&event.replyToken.length>0&&event.replyToken.length<=200)store.db.prepare('UPDATE service_requests SET reply_token=? WHERE event_id=?').run(event.replyToken,event.webhookEventId);
  });return true;
}
export function stageCloudEvent(store,event){
  if(acceptServiceCommand(store,event))return;
  store.db.prepare('INSERT OR IGNORE INTO cloud_relay VALUES (?,?)').run(event.webhookEventId,JSON.stringify(event));
}
export async function handleServiceRequests(store,{recover,inspect,notify,clock=Date.now,onError=()=>{}}){
  const request=store.db.prepare("SELECT * FROM service_requests WHERE status='pending' ORDER BY created LIMIT 1").get();
  if(request){
    const link=store.lineLink(request.line_id),user=link&&store.user(link.user_id);
    let reply;
    if(!link||link.id!==request.binding_id||(request.action==='restart'&&user?.role!=='admin'))reply='連結或權限已變更，服務操作已取消。';
    else if(clock()-request.created>15*60000)reply='服務指令已過期，請重新傳送。';
    else try{
      const result=await (request.action==='restart'?recover():inspect());
      const publicOrigin=result.ok===true?securePublicOrigin(result.url):null;
      if(publicOrigin){
        store.setSetting('publicOrigin',publicOrigin);
        reply=`${request.action==='restart'?'服務已恢復／確認可用':'服務目前可用'}，服務網址：\n${publicOrigin}\n已確認可連線。`;
      }else reply='服務尚未恢復，未提供失效網址。請傳送「重啟服務」重試；若持續失敗，請在電腦查看守護程式紀錄。';
    }catch(error){onError(error);reply=String(error.stderr||'').includes('Active AI work found')?'目前仍有 AI 工作執行中，尚未重啟服務。工作結束後請再傳「重啟服務」。':request.action==='url'?'目前無法確認服務網址可用。請傳「重啟服務」嘗試恢復。':'服務恢復失敗，未提供失效網址。請在電腦查看 data/service-guardian-error.log 後重試。';}
    store.db.prepare("UPDATE service_requests SET status='done',reply=? WHERE event_id=?").run(reply,request.event_id);
  }
  for(const row of store.db.prepare("SELECT * FROM service_requests WHERE status='done' AND sent=0 AND cancelled_at IS NULL AND next_try<=? AND (claimed_at IS NULL OR claimed_at<?) ORDER BY created LIMIT 5").all(clock(),clock()-120000)){
    // A revoked/rebound identity must never receive the previous binding's URL.
    if(row.binding_id&&store.lineLink(row.line_id)?.id!==row.binding_id){store.db.prepare("UPDATE service_requests SET cancelled_at=?,cancel_reason='LINE 綁定已變更',reply_token=NULL WHERE event_id=?").run(clock(),row.event_id);continue;}
    if(!claimDelivery(store.db,'service_requests',row.event_id,clock()))continue;
    try{
      const replyToken=row.reply_token&&clock()-row.created<55000?row.reply_token:undefined;
      await notify({to:row.line_id,text:row.reply,retryKey:row.retry_key,...(replyToken?{replyToken}:{})});
      store.db.prepare('UPDATE service_requests SET sent=1,sent_at=?,error=NULL,reply_token=NULL,claimed_at=NULL WHERE event_id=?').run(clock(),row.event_id);
    }catch(error){
      store.db.prepare('UPDATE service_requests SET attempts=attempts+1,next_try=?,error=?,claimed_at=NULL WHERE event_id=?').run(clock()+Math.min(3600000,10000*2**Math.min(row.attempts,9)),String(error.message||'Notification failed').slice(0,300),row.event_id);
      onError(error);
    }
  }
}
