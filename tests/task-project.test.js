import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore,id} from '../server/db.js';
import {createTaskWithProject} from '../server/task-project.js';
import {processLine} from '../server/line.js';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'tf-auto-project-')),store=createStore(join(root,'db.sqlite')),projects=join(root,'projects');mkdirSync(projects);store.setSetting('defaultProjectRoot',projects);const admin=store.addUser('Admin','admin','test-password-admin','admin'),member=store.addUser('Member','member','test-password-member');t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,projects,admin,member};}
test('Task submission creates its title project, disambiguates collisions and preserves existing project selection',t=>{
  const {store,projects,admin,member}=fixture(t);
  const input={title:'我的網站',description:'製作一個歡迎頁面',type:'code',createProject:true};
  const create=(data,user=admin)=>store.transaction(()=>createTaskWithProject(store,user,data));
  const a=create(input),p=store.project(a.projectId);assert.equal(p.name,input.title);assert.equal(p.path,join(projects,input.title));assert.ok(existsSync(p.path));
  const b=create(input);assert.notEqual(a.projectId,b.projectId);assert.equal(store.project(b.projectId).name,'我的網站 (2)');
  const c=create({...input,createProject:false,projectId:p.id});assert.equal(c.projectId,p.id);
  const safe=create({...input,title:'網頁 / API: 測試'});assert.equal(store.project(safe.projectId).name,'網頁 _ API_ 測試');assert.equal(safe.title,'網頁 / API: 測試');
  const before=readdirSync(projects).length;
  assert.throws(()=>create({...input,title:'invalid',description:'x'}));
  assert.throws(()=>create({...input,title:'member project'},member),/管理者/);
  assert.equal(readdirSync(projects).length,before);
  store.setSetting('defaultProjectRoot','');assert.throws(()=>create({...input,title:'missing location'}),/預設專案存放位置/);
});
test('LINE defaults to title project but does not create it until confirmed; replay creates only one task',t=>{
  const {store,projects,admin}=fixture(t),lineId='U'+'c'.repeat(32);store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,admin.id);
  const send=(value,postback=true,eventId=id())=>processLine(store,{webhookEventId:eventId,type:postback?'postback':'message',source:{type:'user',userId:lineId},...(postback?{postback:{data:value}}:{message:{type:'text',text:value}})});
  const flow=()=>JSON.parse(store.db.prepare('SELECT data FROM line_flows WHERE user_id=?').get(admin.id).data);
  send('tf:new');const nonce=flow().id;assert.equal(flow().createProject,true);send(`tf:type:${nonce}:code`);send('LINE 新網站',false);send('建立一個測試歡迎頁',false);
  assert.equal(flow().stage,'confirm');assert.equal(existsSync(join(projects,'LINE 新網站')),false);
  const event=id();send(`tf:submit:${nonce}`,true,event);send(`tf:submit:${nonce}`,true,event);send(`tf:submit:${nonce}`);
  assert.equal(store.tasks().length,1);assert.equal(store.project(store.tasks()[0].projectId).name,'LINE 新網站');
  send('tf:new');const second=flow().id;send(`tf:existing:${second}`);assert.equal(flow().stage,'project');assert.equal(flow().createProject,false);
});
