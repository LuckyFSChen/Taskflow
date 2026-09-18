import {claimDelivery} from './delivery-state.js';
import {initServiceControl,acceptServiceCommand} from './service-control.js';
import { hash,id } from './db.js';
import { createTask,approveTask,reviseTask } from './domain.js';
import {handleLineUI,lineMessage} from './line-ui.js';
import {enqueueChat,createLineChatWorker} from './line-chat.js';
import {lineReplyDelivery} from './line-reply.js';
export function processLine(store,event,{runner}={}) {
  if(acceptServiceCommand(store,event))return true;
  const eventId=event.webhookEventId;if(!eventId)throw new Error('LINE event 缺少 webhookEventId');
  return store.transaction(()=>{
    if(store.db.prepare('SELECT 1 FROM inbox WHERE event_id=?').get(eventId))return false;
    store.db.prepare('INSERT INTO inbox VALUES (?,?)').run(eventId,new Date().toISOString());
    if(event.source?.type!=='user'||!['message','postback'].includes(event.type)||(event.type==='message'&&event.message?.type!=='text'))return true;
    const lineId=event.source.userId,text=event.type==='message'?event.message.text.trim():'';
    const delivery=lineReplyDelivery(event);
    const send=message=>store.enqueueLine(lineId,[lineMessage(message)],delivery);
    if(text.startsWith('/link ')){const code=text.slice(6).trim();const row=store.db.prepare('SELECT id,link_label FROM users WHERE link_hash=? AND link_expires>?').get(hash(code),Date.now());if(!row){send('連結碼無效或已過期，請從網頁設定重新產生。');return true;}if(store.lineLink(lineId)&&store.lineLink(lineId).user_id!==row.id){send('此 LINE 帳號已連結其他成員。');return true;}if(!store.lineLink(lineId))store.db.prepare('INSERT INTO line_links(id,user_id,line_id,label,created,last_seen) VALUES (?,?,?,?,?,?)').run(id(),row.id,lineId,row.link_label||'LINE',new Date().toISOString(),new Date().toISOString());store.db.prepare("UPDATE users SET link_hash=NULL,link_expires=NULL,link_label='' WHERE id=?").run(row.id);send('LINE 已連結！點選下方快捷功能，即可發布任務、查看進度或審核計畫。');return true;}
    const row=store.lineLink(lineId);if(!row){send('請先登入 TaskFlow 網頁，在設定取得連結碼，再傳送 /link 連結碼。');return true;}store.db.prepare('UPDATE line_links SET last_seen=? WHERE id=?').run(new Date().toISOString(),row.id);const user=store.user(row.user_id);
    if(handleLineUI(store,user,lineId,{text,data:event.type==='postback'?event.postback?.data||'tf:home':'',delivery},runner))return true;
    try {
      if(text.startsWith('/task ')||text.startsWith('/research ')){const research=text.startsWith('/research ');const match=text.match(/^\/(?:task|research)\s+(\S+)\s+([^\n]+)\n([\s\S]+)$/);if(!match)throw new Error('格式：/task 專案代號 標題\n詳細需求（研究文件請用 /research）');const project=store.db.prepare('SELECT id FROM projects WHERE code=?').get(match[1]);if(!project)throw new Error('專案代號不存在');const task=createTask(store,user,{title:match[2],description:match[3],projectId:project.id,type:research?'research':'code',priority:1,executor:research?'claude':'codex',reviewer:research?'codex':'claude'});send(`已收件：${task.title}\n任務：${task.id}\n等待本機 AI 規劃；可在網頁查看計畫與進度。`);}
      else if(text.startsWith('/approve ')){const [,tid,v]=text.split(/\s+/);approveTask(store,user,tid,Number(v));send('此版本計畫已核准，等待派工。');}
      else if(text.startsWith('/answer ')){const match=text.match(/^\/answer\s+(\S+)\s+([\s\S]+)$/);if(!match)throw new Error('格式：/answer 任務ID 補充內容');reviseTask(store,user,match[1],match[2]);send('補充已收到，將重新規劃並請你審核。');}
      else if(text==='/status'){const tasks=store.tasks(user).filter(t=>t.ownerId===user.id).slice(0,8);send(tasks.length?tasks.map(t=>`${t.title}｜${t.status}\n${t.id}`).join('\n\n'):'目前沒有任務。');}
      else if(/^\/(task|research|approve|answer|link|status)(?:\s|$)/.test(text))send('指令格式不完整。請使用下方快捷功能，或輸入 /task 專案代號 標題，再換行填寫詳細需求。');
      else enqueueChat(store,user,lineId,eventId,text,event);
    }catch(e){send(`無法完成：${e.message}`);}
    return true;
  });
}
export function createBridge(store,{runner}={}) {
  initServiceControl(store);
  const chat=createLineChatWorker(store,{onReply:()=>tick()});
  let busy=false;
  async function request(path,body){const response=await fetch(`${process.env.INBOX_URL.replace(/\/$/,'')}${path}`,{method:'POST',headers:{authorization:`Bearer ${process.env.INBOX_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(`雲端收件服務 ${response.status}${Number.isInteger(detail.upstreamStatus)?` (LINE HTTP ${detail.upstreamStatus})`:''}`);}return response.json();}
  async function tick(){if(busy)return;busy=true;try {
    for(const row of store.db.prepare('SELECT * FROM cloud_relay ORDER BY rowid LIMIT 30').all()){processLine(store,JSON.parse(row.raw),{runner});store.db.prepare('DELETE FROM cloud_relay WHERE event_id=?').run(row.event_id);}
    if(process.env.INBOX_URL&&process.env.INBOX_TOKEN){const events=await request('/runner/pull',{});for(const event of events.events){processLine(store,event,{runner});await request('/runner/ack',{id:event.webhookEventId});}store.setSetting('inboxLastSuccess',new Date().toISOString());store.setSetting('inboxError',null);}
    const messages=store.db.prepare('SELECT * FROM outbox WHERE sent=0 AND cancelled_at IS NULL AND next_try<=? AND (claimed_at IS NULL OR claimed_at<?) ORDER BY (reply_token IS NOT NULL AND reply_expires>?) DESC,rowid LIMIT 5').all(Date.now(),Date.now()-120000,Date.now());
    for(const m of messages){
      if(m.binding_id&&store.lineLink(m.line_id)?.id!==m.binding_id){
        store.db.prepare("UPDATE outbox SET cancelled_at=?,cancel_reason='LINE 綁定已變更',reply_token=NULL WHERE id=?").run(Date.now(),m.id);continue;
      }
      if(!(process.env.INBOX_URL&&process.env.INBOX_TOKEN)&&!process.env.LINE_CHANNEL_ACCESS_TOKEN)continue;
      if(!claimDelivery(store.db,'outbox',m.id))continue;
      try{
        const payload=m.payload?JSON.parse(m.payload):[lineMessage(m.message)];
        const replyToken=m.reply_token&&m.reply_expires>Date.now()?m.reply_token:undefined;
        if(process.env.INBOX_URL&&process.env.INBOX_TOKEN)await request('/runner/notify',{to:m.line_id,text:m.message,messages:payload,retryKey:m.id,...(replyToken?{replyToken}:{})});
        else{
          const send=(kind,body)=>fetch(`https://api.line.me/v2/bot/message/${kind}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,'Content-Type':'application/json',...(kind==='push'?{'X-Line-Retry-Key':m.id}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
          let pushed=!replyToken,r=replyToken?await send('reply',{replyToken,messages:payload}):null;
          if(!r||r.status===400){r=await send('push',{to:m.line_id,messages:payload});pushed=true;}
          if(!r.ok&&!(pushed&&r.status===409))throw new Error(`LINE ${r.status}`);
        }
        store.db.prepare('UPDATE outbox SET sent=1,sent_at=?,error=NULL,reply_token=NULL,claimed_at=NULL WHERE id=?').run(Date.now(),m.id);
      }catch(e){store.db.prepare('UPDATE outbox SET attempts=attempts+1,next_try=?,error=?,claimed_at=NULL WHERE id=?').run(Date.now()+Math.min(3600000,10000*2**Math.min(m.attempts,9)),e.message,m.id);}
    }
  }catch(e){store.setSetting('inboxError',e.message);}finally{busy=false;}}
  const timer=setInterval(()=>void tick(),10000);timer.unref();return {tick,stop:()=>{clearInterval(timer);chat.stop();}};
}
