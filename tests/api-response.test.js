import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/api.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,hash,id} from '../server/db.js';
import {createApp} from '../server/app.js';
import {createTask} from '../server/domain.js';
test('API client handles HTML and malformed responses and recovers on valid JSON',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let request;
 globalThis.fetch=async(url,options)=>{request=options;return new Response('<!doctype html><html>SPA</html>',{headers:{'Content-Type':'text/html'}});};
 await assert.rejects(api('/account/line-links'),/服務版本尚未就緒/);assert.equal(request.cache,'no-store');assert.equal(request.headers.Accept,'application/json');
 globalThis.fetch=async()=>new Response('<html>Bad gateway</html>',{status:502,headers:{'Content-Type':'text/html'}});await assert.rejects(api('/account/line-links'),/502/);
 globalThis.fetch=async()=>new Response('{',{headers:{'Content-Type':'application/json'}});await assert.rejects(api('/account/line-links'),/資料不完整/);
 globalThis.fetch=async()=>Response.json({error:'請先登入'},{status:401});await assert.rejects(api('/account/line-links'),/請先登入/);
 globalThis.fetch=async()=>Response.json({links:[{id:'kept'}]});assert.deepEqual(await api('/account/line-links'),{links:[{id:'kept'}]});
});
test('Missing API endpoints return JSON 404 while Vue routes still return HTML',async t=>{
 const root=mkdtempSync(join(tmpdir(),'tf-api-routing-')),s=createStore(join(root,'db.sqlite')),dist=join(root,'dist');mkdirSync(dist);writeFileSync(join(dist,'index.html'),'<!doctype html><html>TaskFlow</html>');const u=s.addUser('Admin','admin','fixture-password','admin');s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('test-session'),u.id,Date.now()+60000);const server=createApp(s,{status:{}},{dist}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));s.close();rmSync(root,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}`;
 for(const method of ['GET','POST']){const r=await fetch(base+'/api/account/unknown',{method,headers:{cookie:'tf_session=test-session','Content-Type':'application/json'},body:method==='POST'?'{}':undefined});assert.equal(r.status,404);assert.match(r.headers.get('content-type'),/application\/json/);assert.match((await r.json()).error,/找不到此功能/);}
 const health=await fetch(base+'/api/health');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true,service:'taskflow'});
 s.setSetting('publicOrigin','https://new-tunnel.trycloudflare.com');
 const originCheck=await fetch(base+'/api/account/unknown',{method:'POST',headers:{cookie:'tf_session=test-session','Content-Type':'application/json',Origin:'https://new-tunnel.trycloudflare.com'},body:'{}'});assert.equal(originCheck.status,404);
 const oldOrigin=await fetch(base+'/api/account/unknown',{method:'POST',headers:{cookie:'tf_session=test-session','Content-Type':'application/json',Origin:'https://expired-tunnel.trycloudflare.com'},body:'{}'});assert.equal(oldOrigin.status,403);
 const actual=await fetch(base+'/api/account/line-links',{headers:{cookie:'tf_session=test-session'}});assert.equal(actual.status,200);assert.deepEqual((await actual.json()).links,[]);
 const page=await fetch(base+'/settings');assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
});

// 守住既有的 canonical rule：一個 Task 任一時間只有一個有效的計畫版本，API 的投影
// （decorated()）只送目前版本的工作階段，completedSteps 也只採計目前版本。
// 這條規則目前是正確的；補這個測試是為了讓它不會在後續重構中被悄悄拿掉——一旦拿掉，
// 重新規劃過的任務就會把上一個版本已完成的步驟算進目前進度。
test('completedSteps only counts the active plan version, never earlier ones',async t=>{
 const root=mkdtempSync(join(tmpdir(),'tf-completed-steps-')),s=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);
 const u=s.addUser('Owner','owner','fixture-password'),pid=id();
 s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);
 s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
 s.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('steps-session'),u.id,Date.now()+60000);
 const task=createTask(s,u,{title:'Re-planned task',description:'Re-planned after supplementary requirements',projectId:pid,type:'research'});
 Object.assign(task,{status:'queued',planVersion:2,approvedVersion:2,workspace:source,
  plan:{summary:'v2',acceptance:['done'],questions:[],steps:[{title:'A',role:'r',instructions:'i'},{title:'B',role:'r',instructions:'i'},{title:'C',role:'r',instructions:'i'}]}});
 s.saveTask(task);
 const pass=summary=>({passed:true,questions:[],evidence:['ok'],artifacts:[],summary});
 // v1 走完三步；v2 只完成第一步。
 for(const [n,version] of [[1,1],[2,1],[3,1],[4,2]])
  s.saveThread({id:id(),taskId:task.id,version,phase:'execute',round:0,status:'completed',result:pass('step '+n)});
 const server=createApp(s,{status:{}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));s.close();rmSync(root,{recursive:true,force:true});});
 const detail=await (await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${task.id}`,{headers:{cookie:'tf_session=steps-session'}})).json();
 assert.equal(detail.completedSteps,1,'v1 的三個步驟屬於已被取代的計畫，不能算進 v2 的進度');
 assert.equal(detail.totalSteps,3);
 assert.equal(detail.threads.length,1,'API 只投影目前計畫版本的工作階段；舊版本留在 store 裡供歷史查詢');
});
