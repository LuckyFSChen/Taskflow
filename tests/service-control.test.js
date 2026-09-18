import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {processLine} from '../server/line.js';
import {initServiceControl,stageCloudEvent,handleServiceRequests,serviceCommand} from '../server/service-control.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'tf-recovery-')),s=createStore(join(root,'db.sqlite'));initServiceControl(s);
 const admin=s.addUser('Admin','admin','test-password','admin'),member=s.addUser('Member','member','test-password');
 const a='U'+'a'.repeat(32),b='U'+'b'.repeat(32);
 for(const [u,line] of [[admin,a],[member,b]])s.db.prepare('INSERT INTO line_links(id,user_id,line_id,label,created) VALUES (?,?,?,?,?)').run(id(),u.id,line,'test',new Date().toISOString());
 const event=(text='重啟服務',line=a)=>({webhookEventId:id(),timestamp:Date.now(),source:{type:'user',userId:line},type:'message',message:{type:'text',text}});
 t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return {s,a,b,event};
}
test('Recovery commands are exact, private, authorized and deduplicated across consumers',async t=>{
 const {s,a,b,event}=fixture(t),e=event();stageCloudEvent(s,e);processLine(s,e);
 let calls=0;const sent=[];
 await handleServiceRequests(s,{recover:async()=>{calls++;return {ok:true,url:'https://new-url.trycloudflare.com'};},notify:async x=>sent.push(x)});
 assert.equal(calls,1);assert.equal(sent.length,1);assert.match(sent[0].text,/new-url/);assert.equal(s.setting('publicOrigin'),'https://new-url.trycloudflare.com');
 stageCloudEvent(s,event('重啟服務',b));await handleServiceRequests(s,{recover:()=>{throw Error('must not run');},notify:async x=>sent.push(x)});assert.match(sent.at(-1).text,/管理者/);
 assert.equal(serviceCommand({...event(),source:{type:'group',userId:a}}),null);assert.equal(serviceCommand(event('幫我在任務中重啟服務')),null);
});
test('Offline ordinary messages are durable and replayed once; controls behind a backlog still run',async t=>{
 const {s,event}=fixture(t);const events=Array.from({length:35},()=>event('/status'));for(const e of events)stageCloudEvent(s,e);
 const control=event();stageCloudEvent(s,control);let called=0;
 await handleServiceRequests(s,{recover:async()=>{called++;return {ok:true,url:'https://ready.trycloudflare.com'};},notify:async()=>{}});
 assert.equal(called,1);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM cloud_relay').get().n,35);
 const e=events[0];processLine(s,e);processLine(s,e);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM inbox WHERE event_id=?').get(e.webhookEventId).n,1);
});
test('Expired or revoked requests cannot restart; failed recovery never returns a stale URL',async t=>{
 const {s,a,event}=fixture(t);let called=0;const sent=[];const opts={recover:async()=>{called++;throw Error('failure');},notify:async x=>sent.push(x)};
 stageCloudEvent(s,{...event(),timestamp:Date.now()-16*60000});await handleServiceRequests(s,opts);assert.equal(called,0);assert.match(sent[0].text,/過期/);
 stageCloudEvent(s,event());s.unlinkLine(s.lineLink(a).user_id,s.lineLink(a).id);await handleServiceRequests(s,opts);assert.equal(called,0);assert.equal(sent.length,1);
});
test('Notification retries keep one retry key and do not rerun recovery',async t=>{
 const {s,event}=fixture(t);stageCloudEvent(s,event());let calls=0;const keys=[];
 let time=Date.now();const opts={clock:()=>time,recover:async()=>{calls++;return {ok:true,url:'https://ready.trycloudflare.com'};},notify:async x=>{keys.push(x.retryKey);if(keys.length===1)throw Error('network');}};
 await handleServiceRequests(s,opts);await handleServiceRequests(s,opts);assert.equal(keys.length,1);
 const failed=s.db.prepare('SELECT attempts,error,sent FROM service_requests').get();assert.equal(failed.attempts,1);assert.equal(failed.error,'network');assert.equal(failed.sent,0);
 time+=10000;await handleServiceRequests(s,opts);assert.equal(calls,1);assert.equal(keys[0],keys[1]);
 stageCloudEvent(s,event());const replies=[];await handleServiceRequests(s,{recover:async()=>({ok:false,url:'https://stale.trycloudflare.com'}),notify:async x=>replies.push(x.text)});assert.doesNotMatch(replies[0],/https:\/\//);
});

test('A failed notification does not block later service replies or rerun recovery',async t=>{
 const {s,event}=fixture(t);const first=event(),second=event();stageCloudEvent(s,first);stageCloudEvent(s,second);
 let calls=0;const sent=[],errors=[];
 const opts={recover:async()=>{calls++;return {ok:true,url:'https://ready.example.com'};},notify:async x=>{
   if(x.retryKey===s.db.prepare('SELECT retry_key FROM service_requests WHERE event_id=?').get(first.webhookEventId).retry_key)throw Error('Inbox HTTP 502 (LINE HTTP 429)');
   sent.push(x);
 },onError:e=>errors.push(e.message)};
 await handleServiceRequests(s,opts);await handleServiceRequests(s,opts);
 assert.equal(calls,2);assert.equal(sent.length,1);assert.equal(errors.length,1);
 assert.equal(s.db.prepare('SELECT sent FROM service_requests WHERE event_id=?').get(second.webhookEventId).sent,1);
 initServiceControl(s);assert.equal(s.db.prepare('SELECT attempts FROM service_requests WHERE event_id=?').get(first.webhookEventId).attempts,1);
});
test('Latest URL lookup does not start services',async t=>{
 const {s,b,event}=fixture(t);stageCloudEvent(s,event('最新網址',b));let checked=0;
 await handleServiceRequests(s,{recover:()=>{throw Error('must not restart');},inspect:async()=>{checked++;return {ok:true,url:'https://current.trycloudflare.com'};},notify:async()=>{}});assert.equal(checked,1);
});

test('Fresh LINE controls use reply tokens; stale tokens are omitted and successful tokens cleared',async t=>{
 const {s,event}=fixture(t);let time=Date.now();const sent=[];
 const opts={clock:()=>time,recover:async()=>({ok:true,url:'https://ready.example.com'}),notify:async x=>sent.push(x)};
 const fresh={...event(),replyToken:'fresh-token'};stageCloudEvent(s,fresh);stageCloudEvent(s,fresh);
 await handleServiceRequests(s,opts);assert.equal(sent.length,1);assert.equal(sent[0].replyToken,'fresh-token');
 assert.equal(s.db.prepare('SELECT reply_token FROM service_requests WHERE event_id=?').get(fresh.webhookEventId).reply_token,null);
 stageCloudEvent(s,{...event(),replyToken:'expired-token'});time+=60000;
 await handleServiceRequests(s,opts);assert.equal(sent.length,2);assert.equal(sent[1].replyToken,undefined);
});

test('Verified fixed domains work for both recovery and URL lookup',async t=>{
 const {s,event}=fixture(t),url='https://taskflow-line.lucky0504.idv.tw';
 for(const command of ['重啟服務','最新網址']){
  stageCloudEvent(s,event(command));const replies=[];
  const result=async()=>({ok:true,url:url+'/'});
  await handleServiceRequests(s,{recover:result,inspect:result,notify:async x=>replies.push(x.text)});
  assert.equal(replies.length,1);assert.ok(replies[0].includes(url));assert.match(replies[0],/已確認可連線/);
  assert.equal(s.setting('publicOrigin'),url);
 }
});

test('Invalid or unverified public URLs never replace the configured origin',async t=>{
 const {s,event}=fixture(t),original='https://taskflow-line.lucky0504.idv.tw';s.setSetting('publicOrigin',original);
 for(const result of [
  {ok:false,url:original},{ok:true,url:'http://example.com'},
  {ok:true,url:'https://user:password@example.com'},
  {ok:true,url:'https://example.com/path'},{ok:true,url:'https://example.com/?token=secret'},
  {ok:true,url:'https://example.com/#fragment'},{ok:true,url:'https://localhost'},
  {ok:true,url:'not a URL'},{ok:true,url:null}
 ]){
  stageCloudEvent(s,event());const replies=[];
  await handleServiceRequests(s,{recover:async()=>result,notify:async x=>replies.push(x.text)});
  assert.doesNotMatch(replies[0],/https?:\/\//);assert.match(replies[0],/服務尚未恢復/);
  assert.equal(s.setting('publicOrigin'),original);
 }
});
