import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../server/db.js';
import {createApp} from '../server/app.js';
import {prepareProjectDirectory} from '../server/project-directory.js';

test('Project API creates nested folders, preserves existing content and rejects unauthorized or duplicate requests before creating',async t=>{
  const root=mkdtempSync(join(tmpdir(),'taskflow-folders-')),store=createStore(join(root,'db.sqlite'));
  store.addUser('Admin','admin','test-password-admin','admin');store.addUser('Member','member','test-password-member');
  const server=createApp(store,{status:{busy:false,activeTaskId:null}},{dist:join(root,'no-dist')}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  async function login(username,password){const r=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});return r.headers.get('set-cookie').split(';')[0];}
  const admin=await login('admin','test-password-admin'),member=await login('member','test-password-member');
  const post=(body,cookie=admin)=>fetch(base+'/admin/projects',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const target=join(root,'new','nested','project');
  assert.equal((await post({name:'New',code:'new',path:target,createIfMissing:false})).status,400);assert.equal(existsSync(target),false);
  assert.equal((await post({name:'New',code:'new',path:target,createIfMissing:true},member)).status,403);assert.equal(existsSync(target),false);
  const created=await post({name:'New',code:'new',path:target,createIfMissing:true});assert.equal(created.status,201);assert.equal((await created.json()).directoryCreated,true);assert.equal(existsSync(target),true);
  writeFileSync(join(target,'keep.txt'),'preserve');const existing=await post({name:'Existing',code:'existing',path:target,createIfMissing:true});assert.equal(existing.status,201);assert.equal((await existing.json()).directoryCreated,false);assert.equal(readFileSync(join(target,'keep.txt'),'utf8'),'preserve');
  const duplicateTarget=join(root,'must-not-be-created');assert.equal((await post({name:'Duplicate',code:'new',path:duplicateTarget,createIfMissing:true})).status,409);assert.equal(existsSync(duplicateTarget),false);
  assert.equal((await post({name:'Relative',code:'relative',path:'relative-folder',createIfMissing:true})).status,400);
  assert.equal((await post({name:'File',code:'file',path:join(target,'keep.txt'),createIfMissing:true})).status,400);
});

test('Platform data directories are excluded before filesystem mutation',t=>{
  const root=mkdtempSync(join(tmpdir(),'taskflow-protected-')),dataDir=join(root,'data');mkdirSync(dataDir);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.throws(()=>prepareProjectDirectory(root,{createIfMissing:true,dataDir}),/data/);
  const nested=join(dataDir,'forbidden');assert.throws(()=>prepareProjectDirectory(nested,{createIfMissing:true,dataDir}),/data/);assert.equal(existsSync(nested),false);
});
