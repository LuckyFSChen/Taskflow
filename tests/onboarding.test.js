import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
import {onboardingStatus,completeOnboarding,workspaceSignals,ONBOARDING_SETTING} from '../server/onboarding.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'tf-onboarding-'));
  const store=createStore(join(root,'db.sqlite'));
  const admin=store.addUser('管理者','admin','fixture-password-admin','admin');
  const member=store.addUser('成員','member','fixture-password-member');
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,admin,member};
}
function addProject(store,root,name='demo'){
  const path=join(root,name);mkdirSync(path,{recursive:true});
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(id(),name,name,path);
  return path;
}
const settingsRows=store=>store.db.prepare('SELECT key,value FROM settings ORDER BY key').all();
const tableNames=store=>store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);

// --- 設定狀態的判斷 ------------------------------------------------------------------
test('全新的工作空間會請管理者走一次設定；成員不會被一個他無法完成的流程擋住',t=>{
  const {store,admin,member}=fixture(t);
  const forAdmin=onboardingStatus(store,admin);
  assert.deepEqual(
    {completed:forAdmin.completed,show:forAdmin.show,hasProjectRoot:forAdmin.hasProjectRoot,hasProject:forAdmin.hasProject},
    {completed:false,show:true,hasProjectRoot:false,hasProject:false}
  );
  const forMember=onboardingStatus(store,member);
  assert.equal(forMember.show,false,'精靈裡的每一步都需要管理者權限，成員不顯示');
  assert.equal(forMember.canConfigure,false);
  assert.equal(onboardingStatus(store,null).show,false);
});

test('只有存放位置、或只有專案，都還不算設定完成',t=>{
  const {store,root,admin}=fixture(t);
  store.setSetting('defaultProjectRoot',root);
  assert.equal(onboardingStatus(store,admin).show,true);
  store.setSetting('defaultProjectRoot','');
  addProject(store,root);
  assert.equal(onboardingStatus(store,admin).show,true);
  assert.deepEqual(workspaceSignals(store),{hasProjectRoot:false,hasProject:true});
});

test('既有安裝（已有存放位置與專案）不會被要求重跑精靈，而且判斷本身不寫入任何設定',t=>{
  const {store,root,admin}=fixture(t);
  store.setSetting('defaultProjectRoot',root);
  addProject(store,root);
  const before=settingsRows(store);
  const status=onboardingStatus(store,admin);
  assert.equal(status.configured,true);
  assert.equal(status.completed,true);
  assert.equal(status.show,false);
  assert.equal(status.dismissed,false,'沒有人按過任何按鈕，就不該假裝使用者做過決定');
  // 純讀取：不因為「看起來設定過了」就偷偷寫一個旗標進去。
  assert.deepEqual(settingsRows(store),before);
});

// --- 稍後設定 / 完成 -----------------------------------------------------------------
test('「稍後設定」與「完成」記錄同一個旗標，之後不再自動出現，且不新增任何 Schema',t=>{
  const {store,admin}=fixture(t);
  const tablesBefore=tableNames(store);
  const status=completeOnboarding(store,admin);
  assert.equal(status.dismissed,true);
  assert.equal(status.show,false);
  assert.equal(onboardingStatus(store,admin).show,false);
  // 只多了一個布林設定：沒有新資料表、沒有新欄位、沒有步驟進度紀錄。
  assert.deepEqual(settingsRows(store).map(row=>[row.key,row.value]),[[ONBOARDING_SETTING,'true']]);
  assert.deepEqual(tableNames(store),tablesBefore);
});

test('記錄決定不等於宣稱環境沒問題：它不碰系統狀態，也不啟用任務服務',t=>{
  const {store,admin}=fixture(t);
  completeOnboarding(store,admin);
  assert.equal(store.setting('runnerEnabled',false),false,'精靈不會替使用者啟用任何服務');
  assert.equal(store.setting('defaultProjectRoot',''),'','精靈不會替使用者選一個位置');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
});

test('後來把專案刪光，也不會再跳一次精靈（使用者已經自己做過決定）',t=>{
  const {store,root,admin}=fixture(t);
  store.setSetting('defaultProjectRoot',root);
  addProject(store,root);
  completeOnboarding(store,admin);
  store.db.prepare('DELETE FROM projects').run();
  store.setSetting('defaultProjectRoot','');
  const status=onboardingStatus(store,admin);
  assert.equal(status.configured,false);
  assert.equal(status.show,false);
  assert.equal(status.completed,true);
});

// --- API ---------------------------------------------------------------------------
test('只有管理者能記錄設定狀態，/api/state 會帶出目前的狀態',async t=>{
  const {store,root,admin,member}=fixture(t);
  store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('admin-session'),admin.id,Date.now()+60000);
  store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('member-session'),member.id,Date.now()+60000);
  const server=createApp(store,{status:{}},{dist:join(root,'no-dist')}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(session,body='{}')=>fetch(base+'/api/onboarding/complete',{method:'POST',headers:{cookie:`tf_session=${session}`,'Content-Type':'application/json'},body});
  const state=session=>fetch(base+'/api/state',{headers:{cookie:`tf_session=${session}`}}).then(r=>r.json());

  assert.equal((await state('admin-session')).onboarding.show,true);
  const forbidden=await post('member-session');
  assert.equal(forbidden.status,403);
  assert.equal(store.setting(ONBOARDING_SETTING,false),false,'成員的請求不能改動工作空間的設定狀態');

  const done=await post('admin-session');
  assert.equal(done.status,200);
  assert.equal((await done.json()).show,false);
  assert.equal((await state('admin-session')).onboarding.show,false);
  assert.equal((await state('member-session')).onboarding.show,false);

  // 未登入不能寫，也不會透露狀態。
  const anonymous=await fetch(base+'/api/onboarding/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(anonymous.status,401);
  // 多餘欄位會被擋下來：這個 endpoint 只負責記錄一件事。
  const extra=await post('admin-session','{"completed":false}');
  assert.equal(extra.status,400);
});
