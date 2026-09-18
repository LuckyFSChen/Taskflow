import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,parse} from 'node:path';
import {createStore,id} from '../server/db.js';
import {projectRemovalPlan,removeProject} from '../server/project-removal.js';
import {createApp} from '../server/app.js';
import {createProjectPreview} from '../server/project-preview.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'tf-removal-')),dataDir=join(root,'data'),path=join(root,'projects','example'),appRoot=join(root,'app');mkdirSync(path,{recursive:true});mkdirSync(appRoot);writeFileSync(join(path,'keep.txt'),'project');
 const store=createStore(join(dataDir,'db.sqlite')),admin=store.addUser('Admin','admin','test-password-123','admin'),pid=id(),tid=id(),threadId=id();
 store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'example','Example',path);
 const workspace=join(dataDir,'workspaces',tid,'v1'),run=join(dataDir,'runs',threadId);mkdirSync(workspace,{recursive:true});mkdirSync(run,{recursive:true});writeFileSync(join(workspace,'file.txt'),'work');writeFileSync(join(run,'log.txt'),'log');
 store.saveTask({id:tid,ownerId:admin.id,projectId:pid,status:'completed',priority:1,position:0,workspace,planVersion:1});store.saveThread({id:threadId,taskId:tid,status:'completed'});store.event(tid,'test','event');
 store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(admin.id,pid);
 const runner={status:{activeTaskIds:[]}},previews={hasProjectActivity:()=>false},options={dataDir,appRoot};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const plan=()=>projectRemovalPlan(store,runner,previews,pid,options);
 const remove=(input)=>removeProject(store,runner,previews,pid,input||{confirmCode:'example',fingerprint:plan().fingerprint},options);
 return {root,path,store,pid,tid,threadId,workspace,run,runner,previews,options,plan,remove,admin};
}
test('Deletion removes all versions, logs, records and memberships but preserves unrelated files',t=>{
 const f=fixture(t),v2=join(f.options.dataDir,'workspaces',f.tid,'v2');mkdirSync(v2);const other=join(f.root,'unrelated');mkdirSync(other);writeFileSync(join(other,'safe.txt'),'safe');
 f.store.db.prepare('INSERT INTO line_flows VALUES (?,?,?,?)').run(f.admin.id,'test-line',JSON.stringify({projectId:f.pid}),Date.now()+10000);
 f.store.notify(f.store.task(f.tid),'test');
 const result=f.remove();assert.deepEqual(result.pendingCleanup,[]);assert.equal(result.deletedTasks,1);assert.equal(f.store.project(f.pid),undefined);assert.equal(f.store.task(f.tid),null);
 for(const p of [f.path,f.workspace,v2,f.run])assert.equal(existsSync(p),false,p);
 assert.equal(readFileSync(join(other,'safe.txt'),'utf8'),'safe');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memberships').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM line_flows').get().n,0);
});
test('Wrong confirmation, stale plan, active tasks and previews cannot delete',t=>{
 const f=fixture(t);assert.throws(()=>f.remove({confirmCode:'wrong',fingerprint:f.plan().fingerprint}),/代號/);
 const old=f.plan();f.store.event(f.tid,'test','does not alter task');const task=f.store.task(f.tid);task.planVersion++;f.store.saveTask(task);assert.throws(()=>f.remove({confirmCode:'example',fingerprint:old.fingerprint}),/變更/);
 f.runner.status.activeTaskIds=[f.tid];assert.throws(f.plan,/執行中/);f.runner.status.activeTaskIds=[];f.previews.hasProjectActivity=()=>true;assert.throws(f.plan,/預覽/);assert.equal(existsSync(f.path),true);
});
test('Reject shared/nested projects, protected paths, junctions and escaped workspaces',t=>{
 const f=fixture(t),other=id();f.store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(other,'other','Other',join(f.path,'nested'));assert.throws(f.plan,/重疊/);f.store.db.prepare('DELETE FROM projects WHERE id=?').run(other);
 for(const path of [parse(f.path).root,f.options.appRoot,f.options.dataDir]){f.store.db.prepare('UPDATE projects SET path=? WHERE id=?').run(path,f.pid);assert.throws(f.plan,/不允許/);}
 f.store.db.prepare('UPDATE projects SET path=? WHERE id=?').run(f.path,f.pid);f.store.setSetting('defaultProjectRoot',f.path);assert.throws(f.plan,/預設專案/);f.store.setSetting('defaultProjectRoot','');
 const alias=join(f.root,'alias');symlinkSync(f.path,alias,process.platform==='win32'?'junction':'dir');f.store.db.prepare('UPDATE projects SET path=? WHERE id=?').run(alias,f.pid);assert.throws(f.plan,/Junction/);
 f.store.db.prepare('UPDATE projects SET path=? WHERE id=?').run(f.path,f.pid);const task=f.store.task(f.tid);task.workspace=f.path;f.store.saveTask(task);assert.throws(f.plan,/工作副本/);assert.equal(existsSync(f.path),true);
});
test('Child junction does not delete external target',t=>{
 const f=fixture(t),outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'safe.txt'),'safe');symlinkSync(outside,join(f.path,'external'),process.platform==='win32'?'junction':'dir');f.remove();assert.equal(readFileSync(join(outside,'safe.txt'),'utf8'),'safe');
});
test('DB failure restores staged folders and task records',t=>{
 const f=fixture(t);f.store.db.exec("CREATE TRIGGER prevent_removal BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'injected failure'); END;");assert.throws(f.remove,/已保留/);assert.ok(f.store.project(f.pid));assert.ok(f.store.task(f.tid));assert.ok(existsSync(join(f.path,'keep.txt')));assert.ok(existsSync(f.workspace));assert.ok(existsSync(f.run));
});
test('Missing original directory still permits record and workspace cleanup',t=>{const f=fixture(t);rmSync(f.path,{recursive:true});assert.equal(f.plan().paths[0].exists,false);f.remove();assert.equal(f.store.task(f.tid),null);});
test('HTTP deletion requires admin and correct confirmation',async t=>{
 const f=fixture(t),member=f.store.addUser('Member','member','test-password-456');
 // Route fixture has no managed tasks, so no production data paths are touched.
 f.store.db.prepare('DELETE FROM events').run();f.store.db.prepare('DELETE FROM threads').run();f.store.db.prepare('DELETE FROM tasks').run();
 const app=createApp(f.store,f.runner,{dist:join(f.root,'none')}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api`;
 const request=(path,body,cookie='')=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});
 const login=async(username,password)=>(await request('/login',{username,password})).headers.get('set-cookie').split(';')[0];
 assert.equal((await request(`/admin/projects/${f.pid}/remove`,{})).status,401);const m=await login('member','test-password-456');assert.equal((await request(`/admin/projects/${f.pid}/remove`,{},m)).status,403);
 f.store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(id(),'ancestor','Registered ancestor',join(f.root,'projects'));
 const a=await login('admin','test-password-123'),plan=await (await request(`/admin/projects/${f.pid}/removal`,undefined,a)).json();assert.equal((await request(`/admin/projects/${f.pid}/remove`,{confirmCode:'wrong',fingerprint:plan.fingerprint},a)).status,409);assert.ok(existsSync(f.path));
 const result=await request(`/admin/projects/${f.pid}/remove`,{confirmCode:'example',fingerprint:plan.fingerprint},a);assert.equal(result.status,200);assert.equal(existsSync(f.path),false);assert.equal((await request(`/admin/projects/${f.pid}/remove`,{confirmCode:'example',fingerprint:plan.fingerprint},a)).status,404);
});
test('Preview activity covers original, older versions and pending builds',async t=>{
 const f=fixture(t);writeFileSync(join(f.path,'index.html'),'<html>test</html>');const preview=createProjectPreview();t.after(()=>preview.close());await preview.start(f.pid+':'+f.tid+':1',f.path);assert.equal(preview.hasProjectActivity(f.pid),true);assert.equal(preview.hasProjectActivity('other'),false);await preview.close();assert.equal(preview.hasProjectActivity(f.pid),false);
});

test('Deleting a child under registered TaskFlow root preserves parent, siblings and their records',t=>{
 const f=fixture(t),appRoot=f.options.appRoot,projectRoot=join(appRoot,'Projects'),target=join(projectRoot,'支援透過 LINE 回答任務問題與補充需求'),sibling=join(projectRoot,'另一個專案'),parentId=id(),siblingId=id();
 mkdirSync(target,{recursive:true});mkdirSync(sibling);writeFileSync(join(target,'target.txt'),'remove only this');writeFileSync(join(appRoot,'platform.txt'),'platform');writeFileSync(join(projectRoot,'shared.txt'),'shared');writeFileSync(join(sibling,'keep.txt'),'sibling');
 f.store.db.prepare('UPDATE projects SET path=? WHERE id=?').run(target,f.pid);f.store.setSetting('defaultProjectRoot',projectRoot);
 f.store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(parentId,'taskflow','TaskFlow',appRoot);f.store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(siblingId,'sibling','Sibling',sibling);
 const plan=f.plan();assert.equal(plan.paths[0].path,target);assert.equal(plan.paths.some(p=>p.path===appRoot||p.path===projectRoot||p.path===sibling),false);
 const result=f.remove();assert.deepEqual(result.pendingCleanup,[]);assert.equal(existsSync(target),false);
 assert.equal(readFileSync(join(appRoot,'platform.txt'),'utf8'),'platform');assert.equal(readFileSync(join(projectRoot,'shared.txt'),'utf8'),'shared');assert.equal(readFileSync(join(sibling,'keep.txt'),'utf8'),'sibling');assert.ok(f.store.project(parentId));assert.ok(f.store.project(siblingId));assert.equal(f.store.project(f.pid),undefined);
});
test('Deleting a shared path or parent containing a registered child is still blocked',t=>{
 const f=fixture(t),other=id();f.store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(other,'shared','Shared',f.path);assert.throws(f.remove,/共用|重疊/);assert.ok(existsSync(join(f.path,'keep.txt')));
 f.store.db.prepare('UPDATE projects SET path=? WHERE id=?').run(join(f.path,'nested'),other);assert.throws(f.remove,/包含|重疊/);assert.ok(f.store.project(f.pid));assert.ok(existsSync(join(f.path,'keep.txt')));
});
