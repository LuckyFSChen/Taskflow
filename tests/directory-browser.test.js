import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../server/db.js';
import {createApp} from '../server/app.js';
import {browseDirectory} from '../server/directory-browser.js';

test('Directory listing hides files and protected data while allowing ancestor navigation',t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-browser-')),dataDir=join(root,'data');mkdirSync(dataDir);mkdirSync(join(root,'中文專案'));writeFileSync(join(root,'file.txt'),'file');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const listing=browseDirectory(root,{dataDir});assert.deepEqual(listing.folders.map(f=>f.name),['中文專案']);assert.equal(listing.selectable,false);
  assert.equal(browseDirectory(join(root,'中文專案'),{dataDir}).selectable,true);
  assert.throws(()=>browseDirectory(dataDir,{dataDir}),/內部資料夾/);assert.throws(()=>browseDirectory('relative',{dataDir}),/完整/);
});
test('Admin folder picker loads default, creates directories, rejects collisions and prevents unauthorized filesystem access',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-picker-')),store=createStore(join(root,'db.sqlite')),baseDir=join(root,'projects');mkdirSync(baseDir);
  store.addUser('Admin','admin','test-password-admin','admin');store.addUser('Member','member','test-password-member');store.setSetting('defaultProjectRoot',baseDir);
  const server=createApp(store,{status:{}},{dist:join(root,'no-dist')}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const post=(path,body,cookie='')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body)});
  const login=async(username,password)=>(await post('/login',{username,password})).headers.get('set-cookie').split(';')[0];
  const admin=await login('admin','test-password-admin'),member=await login('member','test-password-member');
  assert.equal((await fetch(base+'/admin/directories')).status,401);
  assert.equal((await fetch(base+'/admin/directories',{headers:{cookie:member}})).status,403);
  const listing=await (await fetch(base+'/admin/directories',{headers:{cookie:admin}})).json();assert.equal(listing.path,baseDir);
  assert.equal((await post('/admin/directories',{parent:baseDir,name:'拒絕'},member)).status,403);assert.equal(existsSync(join(baseDir,'拒絕')),false);
  const created=await post('/admin/directories',{parent:baseDir,name:'我的網站'},admin);assert.equal(created.status,201);assert.equal((await created.json()).path,join(baseDir,'我的網站'));
  assert.equal((await post('/admin/directories',{parent:baseDir,name:'我的網站'},admin)).status,409);
  assert.equal((await post('/admin/directories',{parent:baseDir,name:'../outside'},admin)).status,400);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM projects').get().n,0);
});
