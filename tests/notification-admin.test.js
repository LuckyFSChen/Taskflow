import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
import {createBridge} from '../server/line.js';
import {acceptServiceCommand,handleServiceRequests} from '../server/service-control.js';
import {notificationSnapshot,manageNotifications} from '../server/notification-admin.js';
import {claimDelivery} from '../server/delivery-state.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'tf-notification-')),store=createStore(join(root,'db.sqlite'));
 const admin=store.addUser('Administrator','admin','fixture-password','admin'),member=store.addUser('Member','member','fixture-password'),line='U'+'a'.repeat(32);
 store.db.prepare('INSERT INTO line_links(id,user_id,line_id,label,created) VALUES (?,?,?,?,?)').run(id(),admin.id,line,'Work LINE',new Date().toISOString());
 const app=createApp(store,{status:{}});
 function message(text){store.enqueueLine(line,[{type:'text',text}],{replyToken:'secret-reply-token',replyExpires:Date.now()+55000});return store.db.prepare('SELECT * FROM outbox ORDER BY rowid DESC LIMIT 1').get();}
 const action=(action,items)=>manageNotifications(store,admin,{action,confirm:true,items});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,store,admin,member,line,app,message,action};
}

test('History lists paginated, filtered records and never exposes reply tokens or raw payloads',t=>{
 const f=fixture(t);for(let i=0;i<23;i++)f.message('idv-web '+i);
 let result=notificationSnapshot(f.store,{state:'all'});assert.equal(result.total,23);assert.equal(result.rows.length,20);
 assert.equal(notificationSnapshot(f.store,{state:'all',page:2}).rows.length,3);
 assert.equal(notificationSnapshot(f.store,{search:'idv-web 22'}).total,1);
 assert.equal(notificationSnapshot(f.store,{search:'Work LINE'}).total,23);
 assert.doesNotMatch(JSON.stringify(result),/secret-reply-token|payload|retry_key|"line_id"/);
 const old=f.message('legacy timestamp');f.store.db.prepare('UPDATE outbox SET created_at=NULL,sent=1 WHERE id=?').run(old.id);
 const row=notificationSnapshot(f.store,{state:'sent'}).rows[0];assert.equal(row.created,null);assert.equal(row.sentAt,null);
});

test('Cancel preserves history and retry keys; retry reschedules only failed unsent messages',t=>{
 const f=fixture(t),pending=f.message('pending'),failed=f.message('failed'),sent=f.message('sent');
 f.store.db.prepare('UPDATE outbox SET error=?,attempts=4,next_try=? WHERE id=?').run('LINE 429',Date.now()+3600000,failed.id);
 f.store.db.prepare('UPDATE outbox SET sent=1 WHERE id=?').run(sent.id);
 const result=f.action('cancel',[{source:'outbox',id:pending.id},{source:'outbox',id:pending.id},{source:'outbox',id:sent.id}]);
 assert.equal(result.changed.length,1);assert.equal(result.skipped.length,1);
 const cancelled=f.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(pending.id);assert.equal(cancelled.sent,0);assert.ok(cancelled.cancelled_at);assert.equal(cancelled.reply_token,null);
 assert.equal(claimDelivery(f.store.db,'outbox',pending.id),false);
 assert.equal(f.action('retry',[{source:'outbox',id:pending.id}]).changed.length,0);
 assert.equal(f.action('retry',[{source:'outbox',id:failed.id}]).changed.length,1);
 const retried=f.store.db.prepare('SELECT * FROM outbox WHERE id=?').get(failed.id);assert.equal(retried.id,failed.id);assert.equal(retried.next_try,0);assert.equal(retried.attempts,4);assert.equal(retried.error,null);
 assert.equal(notificationSnapshot(f.store,{state:'cancelled'}).total,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM notification_actions').get().n,2);
});

test('Cancelling a service reply never repeats recovery; processing requests cannot be cancelled',async t=>{
 const f=fixture(t),event={webhookEventId:id(),timestamp:Date.now(),type:'message',source:{type:'user',userId:f.line},message:{type:'text',text:'重啟服務'}};
 acceptServiceCommand(f.store,event);
 assert.equal(f.action('cancel',[{source:'service',id:event.webhookEventId}]).changed.length,0);
 let recoveries=0,sends=0;
 const options={recover:async()=>{recoveries++;return {ok:true,url:'https://ready.example.com'};},notify:async()=>{sends++;throw Error('LINE 429');}};
 await handleServiceRequests(f.store,options);
 assert.equal(notificationSnapshot(f.store,{source:'service',state:'failed'}).total,1);
 const key=f.store.db.prepare('SELECT retry_key FROM service_requests').get().retry_key;
 f.action('retry',[{source:'service',id:event.webhookEventId}]);await handleServiceRequests(f.store,options);
 assert.equal(recoveries,1);assert.equal(sends,2);assert.equal(f.store.db.prepare('SELECT retry_key FROM service_requests').get().retry_key,key);
 f.action('cancel',[{source:'service',id:event.webhookEventId}]);await handleServiceRequests(f.store,{...options,clock:()=>Date.now()+4000000});assert.equal(sends,2);
 assert.equal(notificationSnapshot(f.store,{source:'service',state:'cancelled'}).total,1);
});

test('Sender and cancellation coordinate atomically even after a batch has been read',async t=>{
 const f=fixture(t),first=f.message('first'),second=f.message('second');
 const oldUrl=process.env.INBOX_URL,oldToken=process.env.INBOX_TOKEN;process.env.INBOX_URL='https://inbox.example.com';process.env.INBOX_TOKEN='test';
 let entered,release;const started=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/pull'))return Response.json({events:[]});
  calls.push(JSON.parse(options.body));entered();await blocked;return Response.json({ok:true});
 });
 const bridge=createBridge(f.store);
 try{
  const running=bridge.tick();await started;
  assert.equal(notificationSnapshot(f.store,{state:'sending'}).total,1);
  assert.equal(f.action('cancel',[{source:'outbox',id:first.id}]).changed.length,0);
  assert.equal(f.action('cancel',[{source:'outbox',id:second.id}]).changed.length,1);
  release();await running;assert.equal(calls.length,1);
  assert.ok(f.store.db.prepare('SELECT sent_at FROM outbox WHERE id=?').get(first.id).sent_at);
 }finally{release();bridge.stop();if(oldUrl===undefined)delete process.env.INBOX_URL;else process.env.INBOX_URL=oldUrl;if(oldToken===undefined)delete process.env.INBOX_TOKEN;else process.env.INBOX_TOKEN=oldToken;}
});

test('Admin endpoints enforce authentication, admin role, origin, explicit confirmation and stale-state guards',async t=>{
 const f=fixture(t),row=f.message('keep');
 for(const [token,user] of [['admin-session',f.admin],['member-session',f.member]])f.store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),user.id,Date.now()+60000);
 const server=f.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/admin/notifications`;
 try{
  assert.equal((await fetch(base)).status,401);assert.equal((await fetch(base,{headers:{cookie:'tf_session=member-session'}})).status,403);
  const headers={cookie:'tf_session=admin-session','content-type':'application/json'};
  assert.equal((await fetch(base,{headers})).status,200);
  const body={action:'cancel',items:[{source:'outbox',id:row.id}]};
  assert.equal((await fetch(base+'/action',{method:'POST',headers,body:JSON.stringify(body)})).status,400);
  assert.equal((await fetch(base+'/action',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify({...body,confirm:true})})).status,403);
  const response=await fetch(base+'/action',{method:'POST',headers,body:JSON.stringify({...body,confirm:true})});assert.equal(response.status,200);assert.equal((await response.json()).changed.length,1);
  assert.equal(notificationSnapshot(f.store).total,0);
 }finally{await new Promise(r=>server.close(r));}
});
