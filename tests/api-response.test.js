import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/api.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
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
