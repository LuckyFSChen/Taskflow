import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,id} from '../server/db.js';
import {processLine,createBridge} from '../server/line.js';
import {createLineChatWorker} from '../server/line-chat.js';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'tf-chat-test-')),store=createStore(join(dir,'db.sqlite'));
  const user=store.addUser('Test','test','test-password-123'),lineId='U'+'a'.repeat(32),project=id();
  store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,user.id);
  mkdirSync(join(dir,'project'));store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(project,'demo','測試專案',join(dir,'project'));
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(user.id,project);
  const send=(text,eventId=id(),from=lineId,extra={})=>processLine(store,{webhookEventId:eventId,type:'message',source:{type:'user',userId:from},message:{type:'text',text},...extra});
  const last=()=>JSON.parse(store.db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').get().payload)[0].text;
  const worker=generate=>{const w=createLineChatWorker(store,{generate,intervalMs:3600000});t.after(()=>w.stop());return w;};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,user,lineId,send,last,worker};
}

test('Unknown commands carry their reply token through GPT and send before failed push backlog',async t=>{
 const f=fixture(t),event=id();
 for(let n=0;n<8;n++)f.store.enqueueLine(f.lineId,[{type:'text',text:'older notification'}]);
 f.send('/unknown-chat',event,f.lineId,{replyToken:'fresh-reply-token',timestamp:Date.now()});
 let wakeups=0;const worker=createLineChatWorker(f.store,{intervalMs:3600000,generate:async()=> 'GPT answer',onReply:async()=>{wakeups++;}});
 try{await worker.tick();}finally{worker.stop();}
 assert.equal(wakeups,1);assert.equal(f.store.db.prepare('SELECT reply_token FROM line_chats WHERE event_id=?').get(event).reply_token,null);
 const oldUrl=process.env.INBOX_URL,oldToken=process.env.INBOX_TOKEN;
 process.env.INBOX_URL='https://inbox.example.com';process.env.INBOX_TOKEN='test';
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/runner/pull'))return Response.json({events:[]});
  const body=JSON.parse(options.body);calls.push(body);
  return body.replyToken?Response.json({ok:true}):Response.json({upstreamStatus:429},{status:502});
 });
 const bridge=createBridge(f.store);
 try{await bridge.tick();}finally{bridge.stop();if(oldUrl===undefined)delete process.env.INBOX_URL;else process.env.INBOX_URL=oldUrl;if(oldToken===undefined)delete process.env.INBOX_TOKEN;else process.env.INBOX_TOKEN=oldToken;}
 assert.equal(calls[0].replyToken,'fresh-reply-token');assert.equal(calls[0].messages[0].text,'GPT answer');
 const row=f.store.db.prepare('SELECT * FROM outbox WHERE message=?').get('GPT answer');
 assert.equal(row.sent,1);assert.equal(row.attempts,0);assert.equal(row.reply_token,null);
 assert.match(f.store.db.prepare('SELECT error FROM outbox WHERE sent=0 AND attempts>0 LIMIT 1').get().error,/LINE HTTP 429/);
 assert.equal(f.store.tasks().length,0);
});

test('Offline chats never reuse expired reply tokens; generation failures retain fresh reply delivery',async t=>{
 const f=fixture(t);
 f.send('older message',id(),f.lineId,{replyToken:'expired',timestamp:Date.now()-60000});
 const worker=f.worker(async()=>{throw Error('failure');});await worker.tick();
 assert.equal(f.store.db.prepare('SELECT reply_token FROM outbox ORDER BY rowid DESC LIMIT 1').get().reply_token,null);
 f.send('new message',id(),f.lineId,{replyToken:'fresh',timestamp:Date.now()});await worker.tick();
 const row=f.store.db.prepare('SELECT reply_token,message FROM outbox ORDER BY rowid DESC LIMIT 1').get();
 assert.equal(row.reply_token,'fresh');assert.match(row.message,/暫時無法/);
});

test('Ordinary chat is durable, deduplicated, contextual, and never creates a task',async t=>{
  const f=fixture(t),event=id();f.send('你好',event);f.send('你好',event);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM line_chats').get().n,1);
  let calls=0;const w=f.worker(async({text,history})=>{calls++;assert.equal(history.length,calls-1);return text==='你好'?'你好，我能幫你釐清需求。':'接續回答';});
  await w.tick();assert.match(f.last(),/釐清需求/);f.send('繼續');await w.tick();await w.tick();assert.equal(calls,2);assert.equal(f.store.tasks().length,0);
});

test('Unlinked users, known malformed commands, and wizard text bypass GPT',t=>{
  const f=fixture(t);f.send('你好',id(),'U'+'b'.repeat(32));assert.match(f.last(),/連結碼/);
  f.send('/task');assert.match(f.last(),/格式/);
  f.send('建立任務');f.send('demo');f.send('程式開發');f.send('測試標題');f.send('完整的任務需求');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM line_chats').get().n,0);
  assert.equal(f.store.tasks().length,0);f.send('確認發布');assert.equal(f.store.tasks().length,1);
  f.send('確認發布');assert.equal(f.store.tasks().length,1);
});

test('Text approval is tied to the displayed task and plan version; no context cannot approve',t=>{
  const f=fixture(t);f.send('/task demo Approval\nCreate a sample file.');let task=f.store.tasks()[0];task.status='awaiting_approval';task.plan={summary:'Plan',acceptance:['File exists'],questions:[],steps:[{title:'Write',role:'Writer',instructions:'Write file'}]};task.planVersion=1;f.store.saveTask(task);
  f.send('核准執行');assert.equal(f.store.task(task.id).status,'awaiting_approval');
  f.send('待我審核');f.send('1');assert.match(f.last(),/核准執行/);
  task.planVersion=2;f.store.saveTask(task);f.send('核准執行');assert.equal(f.store.task(task.id).status,'awaiting_approval');assert.match(f.last(),/變更/);
  f.send('待我審核');f.send('1');f.send('核准執行');assert.equal(f.store.task(task.id).approvedVersion,2);
  f.send('核准執行');assert.match(f.last(),/先回覆/);
});

test('Failure produces one useful reply; pending flood is bounded and unknown commands can chat',async t=>{
  const f=fixture(t);f.send('/something');f.send('第二句');f.send('第三句');f.send('第四句');assert.match(f.last(),/稍候/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM line_chats').get().n,3);
  const w=f.worker(async()=>{throw new Error('private token must not leak');});await w.tick();assert.match(f.last(),/暫時無法/);assert.ok(!f.last().includes('private'));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM line_chats WHERE status='failed'").get().n,1);
});

test('Restart recovers jobs; user histories and changed LINE bindings stay isolated',async t=>{
  const f=fixture(t);const other=f.store.addUser('Other','other','test-password-123');const otherLine='U'+'b'.repeat(32);f.store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(otherLine,other.id);
  f.send('秘密訊息',id(),otherLine);const w=f.worker(async()=> '秘密回覆');await w.tick();w.stop();
  f.send('我的問題');f.store.db.prepare("UPDATE line_chats SET status='running' WHERE status='pending'").run();
  const next=f.worker(async({history})=>{assert.equal(history.length,0);return '你的回答';});await next.tick();assert.equal(f.last(),'你的回答');
  f.send('不得送往舊帳號');f.store.db.prepare('UPDATE users SET line_id=NULL WHERE id=?').run(f.user.id);await next.tick();assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM line_chats WHERE status='cancelled'").get().n,1);
});

test('Expired approval context and unrelated task views do not approve an earlier plan',t=>{
  const f=fixture(t);f.send('/task demo Review\nCreate a file for review.');const task=f.store.tasks()[0];task.status='awaiting_approval';task.plan={summary:'Plan',acceptance:['File exists'],steps:[]};task.planVersion=1;f.store.saveTask(task);
  f.send('待我審核');f.send('1');f.store.db.prepare('UPDATE line_flows SET expires=0').run();f.send('核准');assert.equal(f.store.task(task.id).status,'awaiting_approval');
  f.send('待我審核');f.send('1');f.send('主選單');f.send('核准');assert.equal(f.store.task(task.id).status,'awaiting_approval');
});
