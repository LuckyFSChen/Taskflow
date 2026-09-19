// LINE 一般對話：queue、history、delivery、timeout 與 LINE 回覆。
//
// 這裡刻意不知道任何 CLI 細節：要用 Codex 還是 Claude、用哪一個模型、參數長什麼樣子、
// 輸出怎麼解析，全部在 server/chat-provider.js。本檔只認得一個結果與一組錯誤碼。
import {lineMessage} from './line-ui.js';
import {lineReplyDelivery} from './line-reply.js';
import {ChatProviderError,chatFailureMessage,resolveChatConfig,runChat} from './chat-provider.js';

export function enqueueChat(store,user,lineId,eventId,text,event={}){
  const delivery=lineReplyDelivery(event);
  const send=message=>store.enqueueLine(lineId,[lineMessage(message)],delivery);
  if(!text||text.length>4000){send('一般對話請輸入 1～4,000 字；較長的需求可使用「發布任務」。');return;}
  const pending=store.db.prepare("SELECT COUNT(*) n FROM line_chats WHERE status IN ('pending','running') AND user_id=?").get(user.id).n;
  const recent=store.db.prepare('SELECT COUNT(*) n FROM line_chats WHERE user_id=? AND created>?').get(user.id,Date.now()-60000).n;
  if(pending>=3||recent>=10){send('正在回覆你的訊息，請稍候再傳送。');return;}
  store.db.prepare('INSERT INTO line_chats(event_id,user_id,line_id,prompt,created,binding_id,reply_token,reply_expires) VALUES (?,?,?,?,?,?,?,?)').run(eventId,user.id,lineId,text,Date.now(),store.lineLink(lineId)?.id||null,delivery.replyToken,delivery.replyExpires);
}

// config 由 worker 在 job 開始時解析好並傳進來；這裡不自己再讀一次設定，
// 否則同一個 job 可能前後看到不同的 Provider。
export async function generateChat({text,history=[],signal,config}={}){
  const active=config||resolveChatConfig(null);
  return runChat({provider:active.provider,model:active.model,text,history,signal});
}

// 舊的 generate 介面回傳字串，新的回傳 {provider,model,text}：兩種都接受。
export function chatReplyText(result){
  const text=typeof result==='string'?result:typeof result?.text==='string'?result.text:'';
  return text.trim();
}

export function createLineChatWorker(store,{generate=generateChat,intervalMs=1000,onReply=async()=>{},log=console.error}={}){
  let busy=false,stopped=false,controller;
  store.db.prepare("UPDATE line_chats SET status='pending' WHERE status='running'").run();
  async function tick(){
    if(busy||stopped)return;
    const job=store.db.prepare("SELECT * FROM line_chats WHERE status='pending' ORDER BY created,rowid LIMIT 1").get();if(!job)return;
    busy=true;controller=new AbortController();
    try{
      if(store.lineLink(job.line_id)?.user_id!==job.user_id||store.lineLink(job.line_id)?.id!==job.binding_id){store.db.prepare("UPDATE line_chats SET status='cancelled' WHERE event_id=?").run(job.event_id);return;}
      store.db.prepare("UPDATE line_chats SET status='running' WHERE event_id=?").run(job.event_id);
      const history=store.db.prepare("SELECT prompt,reply FROM line_chats WHERE user_id=? AND line_id=? AND binding_id=? AND status='completed' AND created>? ORDER BY created DESC,rowid DESC LIMIT 6").all(job.user_id,job.line_id,job.binding_id,Date.now()-24*3600000).reverse();
      // 一個 job 一份設定：21:00 開始的對話用當下的 Provider 跑完，
      // 21:00:03 使用者在後台換成另一家，只影響下一個 job。
      const config=resolveChatConfig(store);
      let reply,status='completed';
      try{
        reply=chatReplyText(await generate({text:job.prompt,history,signal:controller.signal,config}));
        if(!reply)throw new ChatProviderError('INVALID_OUTPUT','empty reply');
        reply=reply.slice(0,4800);
      }
      catch(error){
        if(stopped)return;
        status='failed';
        // 詳細錯誤只進 server log；LINE 只看得到一句友善訊息，不會外洩 CLI 原始輸出。
        log(new Date().toISOString(),`LINE chat failed (provider=${config.provider} model=${config.model||'cli-default'} code=${error?.code||'UNKNOWN'})`,String(error?.detail||error?.message||error).slice(0,300));
        reply=chatFailureMessage(config,error);
      }
      if(stopped)return;
      store.transaction(()=>{
        if(store.lineLink(job.line_id)?.user_id!==job.user_id||store.lineLink(job.line_id)?.id!==job.binding_id){store.db.prepare("UPDATE line_chats SET status='cancelled' WHERE event_id=?").run(job.event_id);return;}
        store.enqueueLine(job.line_id,[lineMessage(reply)],{replyToken:job.reply_token,replyExpires:job.reply_expires});
        store.db.prepare('UPDATE line_chats SET status=?,reply=?,reply_token=NULL WHERE event_id=?').run(status,reply,job.event_id);
      });
      await onReply();
    }finally{busy=false;controller=null;}
  }
  const timer=setInterval(()=>void tick().catch(()=>{}),intervalMs);timer.unref();
  return {tick,stop(){stopped=true;clearInterval(timer);controller?.abort();}};
}
