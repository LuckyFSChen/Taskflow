// 方案群組的後端：資料表、欄位遷移、建立／指派的授權與專案一致性。
//
// 重點是「舊資料必須仍可以讀取」：既有的 taskflow.sqlite 沒有 plan_groups 資料表，
// 也沒有 tasks.plan_group_id 欄位。開啟舊資料庫之後，舊任務要原封不動讀得出來，
// planGroupId 是 null，而且不會被任何規則補上一個方案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createTask,requirePlanGroup} from '../server/domain.js';
import {createTaskWithProject} from '../server/task-project.js';
import {assignTaskPlanGroup,createPlanGroup,planGroupsPublic,renamePlanGroup} from '../server/plan-group.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'tf-plan-group-'));
  const store=createStore(join(root,'db.sqlite'));
  const source=join(root,'source');mkdirSync(source);
  const other=join(root,'other');mkdirSync(other);
  const admin=store.addUser('Admin','admin','test-password-admin','admin');
  const member=store.addUser('Member','member','test-password-member');
  const stranger=store.addUser('Stranger','stranger','test-password-stranger');
  const projectId=id(),otherProjectId=id();
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'demo','Demo',source);
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(otherProjectId,'other','Other',other);
  for(const user of [member,stranger])for(const pid of [projectId,otherProjectId])store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(user.id,pid);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const make=(user,extra={})=>createTask(store,user,{title:'方案任務',description:'測試方案群組的建立與指派。',projectId,type:'code',...extra});
  return {root,store,admin,member,stranger,projectId,otherProjectId,make};
}

test('建立方案並把任務歸進去：JSON 與 plan_group_id 欄位一起寫入',t=>{
  const f=fixture(t);
  const group=createPlanGroup(f.store,f.member,{name:'結帳流程改版',projectId:f.projectId});
  assert.equal(group.name,'結帳流程改版');
  assert.equal(group.projectId,f.projectId);
  assert.equal(group.ownerId,f.member.id);

  const task=f.make(f.member,{planGroupId:group.id});
  assert.equal(task.planGroupId,group.id);
  // 重新從資料庫讀一次：JSON data 是唯一真相，欄位只是索引用的鏡像，兩邊必須一致。
  assert.equal(f.store.task(task.id).planGroupId,group.id);
  assert.equal(f.store.db.prepare('SELECT plan_group_id FROM tasks WHERE id=?').get(task.id).plan_group_id,group.id);
});

test('沒有指定方案的任務就是獨立任務：欄位與 JSON 都是 null',t=>{
  const f=fixture(t);
  const task=f.make(f.member);
  assert.equal(task.planGroupId,null);
  assert.equal(f.store.task(task.id).planGroupId,null);
  assert.equal(f.store.db.prepare('SELECT plan_group_id FROM tasks WHERE id=?').get(task.id).plan_group_id,null);
});

test('方案必須存在、同專案、而且是自己看得到的，否則直接擋下來',t=>{
  const f=fixture(t);
  const mine=createPlanGroup(f.store,f.member,{name:'我的方案',projectId:f.projectId});
  const elsewhere=createPlanGroup(f.store,f.member,{name:'別的專案的方案',projectId:f.otherProjectId});
  const strangers=createPlanGroup(f.store,f.stranger,{name:'別人的方案',projectId:f.projectId});

  assert.throws(()=>f.make(f.member,{planGroupId:id()}),/找不到方案/);
  assert.throws(()=>f.make(f.member,{planGroupId:elsewhere.id}),/其他專案/);
  assert.throws(()=>f.make(f.member,{planGroupId:strangers.id}),/找不到方案/);
  // 管理者看得到所有方案。
  assert.equal(f.make(f.admin,{planGroupId:strangers.id}).planGroupId,strangers.id);
  assert.equal(f.make(f.member,{planGroupId:mine.id}).planGroupId,mine.id);
  // 空值一律視為「獨立任務」，不是錯誤。
  assert.equal(requirePlanGroup(f.store,f.member,null,f.projectId),null);
  assert.equal(requirePlanGroup(f.store,f.member,undefined,f.projectId),null);
});

test('建立任務時一併建立新方案（planGroupName）',t=>{
  const f=fixture(t);
  const task=f.store.transaction(()=>createTaskWithProject(f.store,f.member,{
    title:'第一個任務',description:'建立任務時順便開一個方案。',projectId:f.projectId,type:'code',planGroupName:'  付款體驗  ',
  }));
  assert.ok(task.planGroupId);
  const group=f.store.planGroup(task.planGroupId);
  assert.equal(group.name,'付款體驗');
  assert.equal(group.projectId,f.projectId);
  // 名稱留白等同沒填：不會生出一個空白方案。
  const standalone=f.store.transaction(()=>createTaskWithProject(f.store,f.member,{
    title:'第二個任務',description:'不歸入任何方案。',projectId:f.projectId,type:'code',planGroupName:'   ',
  }));
  assert.equal(standalone.planGroupId,null);
  assert.equal(f.store.planGroups(f.member).length,1);
});

test('把既有任務移進方案、再移出成為獨立任務，都留下事件紀錄',t=>{
  const f=fixture(t);
  const group=createPlanGroup(f.store,f.member,{name:'結帳流程改版',projectId:f.projectId});
  const task=f.make(f.member);
  assert.equal(task.planGroupId,null);

  const joined=assignTaskPlanGroup(f.store,f.member,task.id,{planGroupId:group.id});
  assert.equal(joined.planGroupId,group.id);
  assert.equal(f.store.task(task.id).planGroupId,group.id);
  assert.ok(f.store.events(task.id).some(e=>e.kind==='plan_group'&&e.message.includes('結帳流程改版')));

  const left=assignTaskPlanGroup(f.store,f.member,task.id,{planGroupId:null});
  assert.equal(left.planGroupId,null);
  assert.equal(f.store.db.prepare('SELECT plan_group_id FROM tasks WHERE id=?').get(task.id).plan_group_id,null);
  assert.equal(f.store.events(task.id).filter(e=>e.kind==='plan_group').length,2);

  // 指派不會動到任務的執行狀態或計畫版本。
  assert.equal(f.store.task(task.id).status,'planning');
  assert.equal(f.store.task(task.id).planVersion,1);
  // 跨專案與別人的任務一律擋下。
  const elsewhere=createPlanGroup(f.store,f.member,{name:'另一個',projectId:f.otherProjectId});
  assert.throws(()=>assignTaskPlanGroup(f.store,f.member,task.id,{planGroupId:elsewhere.id}),/其他專案/);
  assert.throws(()=>assignTaskPlanGroup(f.store,f.stranger,task.id,{planGroupId:group.id}),/找不到任務/);
});

test('改名只改名稱；成員只看得到自己的方案，管理者看得到全部',t=>{
  const f=fixture(t);
  const mine=createPlanGroup(f.store,f.member,{name:'舊名字',projectId:f.projectId});
  createPlanGroup(f.store,f.stranger,{name:'別人的',projectId:f.projectId});

  const renamed=renamePlanGroup(f.store,f.member,mine.id,{name:'新名字'});
  assert.equal(renamed.name,'新名字');
  assert.equal(renamed.id,mine.id);
  assert.equal(renamed.projectId,f.projectId);
  assert.throws(()=>renamePlanGroup(f.store,f.stranger,mine.id,{name:'搶過來'}),/找不到方案/);

  const own=planGroupsPublic(f.store,f.member);
  assert.deepEqual(own.map(g=>g.name),['新名字']);
  assert.equal(own[0].projectName,'Demo');
  assert.equal(planGroupsPublic(f.store,f.admin).length,2);
});

test('舊資料庫：沒有 plan_groups 與 plan_group_id 也要能升級，舊任務原封不動讀出來',t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-plan-group-legacy-'));
  const file=join(root,'legacy.sqlite');
  t.after(()=>rmSync(root,{recursive:true,force:true}));

  // 用升級前的 schema 手工造一個舊資料庫：tasks 只有原本的 8 個欄位，沒有 plan_groups。
  const legacy=new DatabaseSync(file);
  legacy.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL,line_id TEXT UNIQUE,link_hash TEXT,link_expires INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,priority INTEGER NOT NULL,position REAL NOT NULL,updated TEXT NOT NULL,data TEXT NOT NULL);`);
  const userId=id(),projectId=id(),taskId=id();
  legacy.prepare('INSERT INTO users(id,name,username,password,role) VALUES (?,?,?,?,?)').run(userId,'Legacy','legacy','x:y','member');
  legacy.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'legacy','Legacy Project','/tmp/legacy');
  const legacyTask={id:taskId,ownerId:userId,projectId,title:'升級前就在的任務',description:'舊資料',status:'queued',priority:1,position:1,planVersion:2,approvedVersion:2,updated:'2025-12-01T00:00:00.000Z'};
  legacy.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)').run(taskId,userId,projectId,'queued',1,1,legacyTask.updated,JSON.stringify(legacyTask));
  legacy.close();

  // 新版程式開啟同一個檔案：只補欄位與資料表，不改任何既有資料。
  const store=createStore(file);
  const loaded=store.task(taskId);
  assert.equal(loaded.title,'升級前就在的任務');
  assert.equal(loaded.planVersion,2);
  assert.equal(loaded.approvedVersion,2);
  // 舊任務沒有方案，而且不會被補上一個。
  assert.equal(loaded.planGroupId,undefined);
  assert.equal(store.db.prepare('SELECT plan_group_id FROM tasks WHERE id=?').get(taskId).plan_group_id,null);
  assert.equal(store.planGroups({role:'admin'}).length,0);

  // 存回去之後仍然是獨立任務，而且其他欄位一個都沒掉。
  store.saveTask(loaded);
  const resaved=store.task(taskId);
  assert.equal(resaved.planVersion,2);
  assert.equal(resaved.title,'升級前就在的任務');
  assert.equal(store.db.prepare('SELECT plan_group_id FROM tasks WHERE id=?').get(taskId).plan_group_id,null);

  // 再開一次：遷移必須是冪等的。
  store.close();
  const again=createStore(file);
  t.after(()=>again.close());
  assert.equal(again.task(taskId).title,'升級前就在的任務');
  assert.equal(again.task(taskId).planGroupId,undefined);
});

test('備份還原：JSON 裡已經有 planGroupId 時，升級會把它同步到欄位，但不會憑空造方案',t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-plan-group-restore-'));
  const file=join(root,'restore.sqlite');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const groupId=id(),userId=id(),projectId=id(),taskId=id();
  const legacy=new DatabaseSync(file);
  legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL,line_id TEXT UNIQUE,link_hash TEXT,link_expires INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,position REAL NOT NULL,updated TEXT NOT NULL,data TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO users(id,name,username,password,role) VALUES (?,?,?,?,?)').run(userId,'R','restore','x:y','member');
  legacy.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId,'restore','Restore','/tmp/restore');
  legacy.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)').run(taskId,userId,projectId,'queued',1,1,'2025-12-01T00:00:00.000Z',JSON.stringify({id:taskId,ownerId:userId,projectId,planGroupId:groupId,title:'還原的任務'}));
  legacy.close();

  const store=createStore(file);
  t.after(()=>store.close());
  assert.equal(store.db.prepare('SELECT plan_group_id FROM tasks WHERE id=?').get(taskId).plan_group_id,groupId);
  assert.equal(store.task(taskId).planGroupId,groupId);
  // 方案本身沒被還原：欄位保留座標，但不會幫忙生一筆 plan_groups。
  assert.equal(store.planGroup(groupId),null);
});
