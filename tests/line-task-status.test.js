import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,id} from '../server/db.js';
import {createTask} from '../server/domain.js';
import {processLine,createBridge} from '../server/line.js';
import {validMessages} from '../cloud-inbox/line-menu.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'tf-line-status-')),store=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);
 const user=store.addUser('Owner','owner','fixture-password'),other=store.addUser('Other','other','fixture-password'),pid=id(),lineId='U'+'f'.repeat(32);store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);for(const u of [user,other])store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,user.id);
 const make=(owner=user)=>createTask(store,owner,{title:'LINE status task',description:'Verify real event processing.',projectId:pid,type:'code'}),task=make();let stops=0;
 const send=(value,postback=true,eventId=id(),runner={stopTask:()=>stops++})=>processLine(store,{webhookEventId:eventId,type:postback?'postback':'message',source:{type:'user',userId:lineId},...(postback?{postback:{data:value}}:{message:{type:'text',text:value}})},{runner});
 const last=()=>JSON.parse(store.db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').get().payload)[0];
 const button=label=>last().quickReply.items.find(i=>i.action.label===label).action.data;
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,task,other,lineId,make,send,last,button,stops:()=>stops};
}

test('Progress replies show current blockers privately and use Reply delivery despite exhausted push quota',async t=>{
 const f=fixture(t);Object.assign(f.task,{status:'waiting_input',planVersion:1,approvedVersion:1,plan:{steps:[{},{}]},questions:['此步驟無法完成']});f.store.saveTask(f.task);
 f.store.saveThread({id:id(),taskId:f.task.id,version:1,phase:'execute',role:'前端工程',status:'completed',result:{passed:false,questions:[],summary:'瀏覽器存取遭工具拒絕，未完成驗證',evidence:[]}});
 const privateTask=f.make(f.other);privateTask.title='PRIVATE TASK';f.store.saveTask(privateTask);
 const oldUrl=process.env.INBOX_URL,oldToken=process.env.INBOX_TOKEN;process.env.INBOX_URL='https://inbox.example.com';process.env.INBOX_TOKEN='test';
 const sent=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/runner/pull'))return Response.json({events:[]});
  const body=JSON.parse(options.body);sent.push(body);
  return body.replyToken?Response.json({ok:true}):Response.json({upstreamStatus:429},{status:502});
 });
 const bridge=createBridge(f.store);
 try{
  for(const value of ['任務進度','tf:status:0','1','待我審核']){
   const event={webhookEventId:id(),timestamp:Date.now(),replyToken:'token-'+id(),source:{type:'user',userId:f.lineId},...(value.startsWith('tf:')?{type:'postback',postback:{data:value}}:{type:'message',message:{type:'text',text:value}})};
   processLine(f.store,event);processLine(f.store,event);
   const row=f.store.db.prepare('SELECT * FROM outbox ORDER BY rowid DESC LIMIT 1').get();
   assert.equal(row.reply_token,event.replyToken);assert.doesNotMatch(row.message,/PRIVATE TASK/);
   if(value==='任務進度'){assert.match(row.message,/待處理 1 項/);assert.match(row.message,/0\/2 步驟/);assert.match(row.message,/驗證受限／未通過/);assert.match(row.message,/待處理：選擇是否跳過/);}
   if(value==='1')assert.match(row.message,/是否跳過/);
   await bridge.tick();assert.equal(f.store.db.prepare('SELECT sent FROM outbox WHERE id=?').get(row.id).sent,1);
  }
  assert.equal(sent.length,4);assert.ok(sent.every(x=>x.replyToken));assert.equal(f.store.db.prepare('SELECT count(*) n FROM line_chats').get().n,0);
  assert.equal(f.store.task(f.task.id).status,'waiting_input');
  processLine(f.store,{webhookEventId:id(),timestamp:Date.now()-60000,replyToken:'old',source:{type:'user',userId:f.lineId},type:'message',message:{type:'text',text:'任務進度'}});
  assert.equal(f.store.db.prepare('SELECT reply_token FROM outbox ORDER BY rowid DESC LIMIT 1').get().reply_token,null);
 }finally{bridge.stop();if(oldUrl===undefined)delete process.env.INBOX_URL;else process.env.INBOX_URL=oldUrl;if(oldToken===undefined)delete process.env.INBOX_TOKEN;else process.env.INBOX_TOKEN=oldToken;}
});
test('LINE buttons update status, stop active AI, reject stale actions and retain manual completion label',t=>{
 const f=fixture(t);f.store.saveThread({id:id(),taskId:f.task.id,status:'running',version:1});f.send(`tf:view:${f.task.id}`);
 const command=f.button('標記完成'),eventId=id();f.send(command,true,eventId);f.send(command,true,eventId);
 assert.equal(f.stops(),1);assert.equal(f.store.task(f.task.id).status,'completed');assert.match(f.last().text,/手動完成/);
 f.send(command);assert.match(f.last().text,/失效/);
 f.send(`tf:view:${f.task.id}`);assert.ok(f.button('恢復處理'));assert.equal(validMessages([f.last()]),true);
});
test('LINE supports text controls only for selected tasks, expiry and changed task state fail closed',t=>{
 const f=fixture(t);f.send('結束任務',false);assert.match(f.last().text,/先點/);assert.equal(f.store.task(f.task.id).status,'planning');
 f.send(`tf:view:${f.task.id}`);f.send('暫停任務',false);assert.equal(f.store.task(f.task.id).status,'paused');
 f.send(`tf:view:${f.task.id}`);f.send('恢復處理',false);assert.equal(f.store.task(f.task.id).status,'planning');
 f.send(`tf:view:${f.task.id}`);const stale=f.button('取消任務');const changed=f.store.task(f.task.id);changed.status='queued';f.store.saveTask(changed);f.send(stale);assert.match(f.last().text,/已更新/);assert.equal(f.store.task(f.task.id).status,'queued');
 f.send(`tf:view:${f.task.id}`);const expired=f.button('標記完成');f.store.db.prepare('UPDATE line_flows SET expires=0').run();f.send(expired);assert.match(f.last().text,/失效/);
 const other=f.make(f.other);f.send(`tf:view:${other.id}`);assert.match(f.last().text,/找不到|自己/);assert.equal(f.store.task(other.id).status,'planning');
});
test('LINE refuses active task changes without runner connection',t=>{
 const f=fixture(t);f.store.saveThread({id:id(),taskId:f.task.id,status:'running',version:1});f.send(`tf:view:${f.task.id}`);f.send(f.button('標記完成'),true,id(),null);assert.equal(f.store.task(f.task.id).status,'planning');assert.match(f.last().text,/無法連接/);
});
