import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {get} from 'node:http';
import {createProjectPreview,detectWebProject,resolveWebRoot} from '../server/project-preview.js';
import {createStore,id} from '../server/db.js';
import {createApp} from '../server/app.js';

// Preview db 路徑須與 server/project-preview.js 的 safeKeyFragment() 保持一致，
// 純為測試清理用，不影響實際實作邏輯。
const previewDbSlug=key=>key.replace(/[^a-zA-Z0-9_-]/g,'_');
const previewDbPathFor=key=>resolve('data/preview',previewDbSlug(key),'taskflow.sqlite');
// killTree() on Windows is fire-and-forget (taskkill runs async), so the OS can still hold a
// brief file lock on the fixture directory right after stop()/close() resolve; retry the cleanup.
const rmDirSafe=path=>rmSync(path,{recursive:true,force:true,maxRetries:5,retryDelay:200});
const fakeNpm=async(path,args)=>{if(args[0]==='install')mkdirSync(join(path,'node_modules'),{recursive:true});};
function writeFullstackFixture(root,serverSource) {
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'*'},devDependencies:{vite:'*'},scripts:{build:'vite build',start:'node server.js'}}));
  writeFileSync(join(root,'server.js'),serverSource);
}
const FULLSTACK_SERVER_OK=`
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const port=Number(process.env.PORT);
const host=process.env.HOST||'127.0.0.1';
if(process.env.TF_TEST_DUMP_PATH){
  writeFileSync(process.env.TF_TEST_DUMP_PATH,JSON.stringify({
    inboxToken:process.env.INBOX_TOKEN||null,
    lineSecret:process.env.LINE_CHANNEL_SECRET||null,
    lineToken:process.env.LINE_CHANNEL_ACCESS_TOKEN||null,
    openaiKey:process.env.OPENAI_API_KEY||null,
    codexKey:process.env.CODEX_API_KEY||null,
    anthropicKey:process.env.ANTHROPIC_API_KEY||null,
    dbFile:process.env.TASKFLOW_DB_FILE||null,
  }));
}
createServer((req,res)=>{
  const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/api/health'&&req.method==='GET')return send(200,{ok:true});
  if(req.url==='/api/login'&&req.method==='POST')return send(200,{ok:true,user:{username:'preview-test'}});
  if(req.url==='/api/state'&&req.method==='GET')return send(200,{state:'ok'});
  send(404,{error:'not found'});
}).listen(port,host);
`;
const FULLSTACK_SERVER_FAIL=`
process.stderr.write('FIXTURE_STARTUP_FAILURE: simulated crash\\n');
process.exit(1);
`;
const FULLSTACK_SERVER_HEALTH_NEVER_OK=`
import {createServer} from 'node:http';
const port=Number(process.env.PORT);
const host=process.env.HOST||'127.0.0.1';
createServer((req,res)=>{res.writeHead(500);res.end('nope');}).listen(port,host);
`;

test('Local web preview builds once, serves loopback only, stops and surfaces build failures',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-preview-'));let calls=[];
  const preview=createProjectPreview({npm:async(path,args)=>{calls.push(args);mkdirSync(join(path,'dist'),{recursive:true});writeFileSync(join(path,'dist/index.html'),'<h1>Preview proof</h1>');}});
  t.after(async()=>{await preview.close();rmSync(root,{recursive:true,force:true});});
  writeFileSync(join(root,'package.json'),JSON.stringify({devDependencies:{vite:'*'},scripts:{build:'vite build'}}));
  const [one,two]=await Promise.all([preview.start('project',root),preview.start('project',root)]);
  assert.equal(one.url,two.url);assert.match(one.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(calls,[['install'],['run','build']]);
  assert.match(await (await fetch(one.url)).text(),/Preview proof/);
  const wrongHost=await new Promise((resolve,reject)=>{get(one.url,{headers:{host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(wrongHost,403);
  assert.equal((await fetch(one.url+'/.env')).status,404);
  await preview.stop('project');assert.equal(preview.status('project'),null);
  await assert.rejects(fetch(one.url));
  const broken=createProjectPreview({npm:async()=>{throw Error('build failed');}});
  await assert.rejects(broken.start('broken',root),/build failed/);assert.equal(broken.status('broken'),null);await broken.close();
});

test('Project actions enforce login, membership and task ownership before opening or executing',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-preview-acl-')),store=createStore(join(root,'db.sqlite'));
  const admin=store.addUser('Admin','admin','test-password-admin','admin'),member=store.addUser('Member','member','test-password-member');
  const pid=id(),other=id(),tid=id();store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',root);store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(other,'other','Other',root);
  store.saveTask({id:tid,ownerId:admin.id,projectId:pid,status:'completed',priority:1,position:0,workspace:root,planVersion:1});
  let opens=0,starts=0;
  const server=createApp(store,{status:{}},{dist:join(root,'none'),folderOpener:async()=>opens++,previews:{status:()=>null,start:async()=>{starts++;return {url:'http://127.0.0.1:9999'};},stop:async()=>{}}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const post=(path,body={},cookie='')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body)});
  const login=async(username,password)=>(await post('/login',{username,password})).headers.get('set-cookie').split(';')[0];
  const a=await login('admin','test-password-admin'),m=await login('member','test-password-member');
  assert.equal((await post(`/projects/${pid}/open-folder`)).status,401);
  assert.equal((await post(`/projects/${pid}/preview`,{},m)).status,404);assert.equal(starts,0);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(member.id,pid);
  assert.equal((await post(`/projects/${pid}/preview`,{taskId:tid},m)).status,404);
  assert.equal((await post(`/projects/${other}/preview`,{taskId:tid},a)).status,404);
  assert.equal((await post(`/projects/${pid}/open-folder`,{},a)).status,200);assert.equal(opens,1);
  assert.equal((await post(`/projects/${pid}/preview`,{taskId:tid},a)).status,200);assert.equal(starts,1);
  store.saveThread({id:id(),taskId:tid,version:1,status:'running'});
  assert.equal((await post(`/projects/${pid}/open-folder`,{taskId:tid},a)).status,200);assert.equal(opens,2);
  assert.equal((await post(`/projects/${pid}/preview`,{taskId:tid},a)).status,409);
});

test('Pure static project (no package.json) is still served by the static preview server',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-preview-static-'));
  writeFileSync(join(root,'index.html'),'<h1>Static proof</h1>');
  const preview=createProjectPreview({npm:fakeNpm});
  t.after(async()=>{await preview.close();rmSync(root,{recursive:true,force:true});});
  const info=await preview.start('static-project',root);
  assert.equal(info.kind,'static');
  assert.match(await (await fetch(info.url)).text(),/Static proof/);
  assert.equal((await fetch(info.url+'/.env')).status,404);
});

test('Fullstack project boots its own application server with isolated port, DB, env and one-time credentials',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-preview-fullstack-'));
  writeFullstackFixture(root,FULLSTACK_SERVER_OK);
  const dumpPath=join(root,'env-dump.json');
  const key='fullstack-proj:fullstack-task:1';
  process.env.TF_TEST_DUMP_PATH=dumpPath;
  process.env.INBOX_TOKEN='secret-inbox-token';
  process.env.LINE_CHANNEL_SECRET='secret-line-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN='secret-line-token';
  process.env.OPENAI_API_KEY='secret-openai';
  process.env.CODEX_API_KEY='secret-codex';
  process.env.ANTHROPIC_API_KEY='secret-anthropic';
  const preview=createProjectPreview({npm:fakeNpm});
  t.after(async()=>{
    await preview.close();
    for(const k of ['TF_TEST_DUMP_PATH','INBOX_TOKEN','LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY'])delete process.env[k];
    rmDirSafe(root);
    rmDirSafe(join('data/preview',previewDbSlug(key)));
  });
  const info=await preview.start(key,root);
  assert.equal(info.kind,'fullstack');
  assert.match(info.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(info.url).port,'4310');
  assert.equal(info.cwd,root);
  assert.equal(typeof info.pid,'number');
  assert.equal(info.credentials.username,'taskflow-preview');
  assert.ok(info.credentials.password&&info.credentials.password.length>10);

  assert.equal((await fetch(info.url+'/api/health')).status,200);
  const loginRes=await fetch(info.url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(loginRes.status,200);
  assert.equal((await fetch(info.url+'/api/state')).status,200);

  const dbPath=previewDbPathFor(key);
  assert.ok(existsSync(dbPath));
  assert.notEqual(dbPath,resolve('data/taskflow.sqlite'));
  assert.match(dbPath,/[\\/]data[\\/]preview[\\/]/);

  const dump=JSON.parse(readFileSync(dumpPath,'utf8'));
  assert.equal(dump.inboxToken,null);
  assert.equal(dump.lineSecret,null);
  assert.equal(dump.lineToken,null);
  assert.equal(dump.openaiKey,null);
  assert.equal(dump.codexKey,null);
  assert.equal(dump.anthropicKey,null);
  assert.equal(dump.dbFile,dbPath);

  const info2=await preview.start(key+':second',root);
  t.after(async()=>{await preview.stop(key+':second');rmDirSafe(join('data/preview',previewDbSlug(key+':second')));});
  assert.notEqual(info2.credentials.password,info.credentials.password);

  await preview.stop(key);
  assert.equal(preview.status(key),null);
  await assert.rejects(fetch(info.url));
});

test('stopProject() tears down every fullstack preview child process for that project',async t=>{
  const rootA=mkdtempSync(join(tmpdir(),'tf-preview-fs-a-')),rootB=mkdtempSync(join(tmpdir(),'tf-preview-fs-b-'));
  writeFullstackFixture(rootA,FULLSTACK_SERVER_OK);writeFullstackFixture(rootB,FULLSTACK_SERVER_OK);
  const keyA='stopproj:taskA:1',keyB='stopproj:taskB:1';
  const preview=createProjectPreview({npm:fakeNpm});
  t.after(async()=>{
    await preview.close();
    rmDirSafe(rootA);rmDirSafe(rootB);
    rmDirSafe(join('data/preview',previewDbSlug(keyA)));
    rmDirSafe(join('data/preview',previewDbSlug(keyB)));
  });
  const [infoA,infoB]=await Promise.all([preview.start(keyA,rootA),preview.start(keyB,rootB)]);
  assert.equal((await fetch(infoA.url+'/api/health')).status,200);
  assert.equal((await fetch(infoB.url+'/api/health')).status,200);
  await preview.stopProject('stopproj');
  assert.equal(preview.status(keyA),null);assert.equal(preview.status(keyB),null);
  await assert.rejects(fetch(infoA.url));await assert.rejects(fetch(infoB.url));
});

test('Fullstack preview surfaces collected stderr when the application server exits before health check passes',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-preview-fs-fail-'));
  writeFullstackFixture(root,FULLSTACK_SERVER_FAIL);
  const key='failboot:task:1';
  const preview=createProjectPreview({npm:fakeNpm});
  t.after(async()=>{await preview.close();rmDirSafe(root);rmDirSafe(join('data/preview',previewDbSlug(key)));});
  await assert.rejects(preview.start(key,root),/FIXTURE_STARTUP_FAILURE: simulated crash/);
  assert.equal(preview.status(key),null);
});

test('Fullstack preview health check timeout rejects and kills the child instead of hanging forever',{timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-preview-fs-timeout-'));
  writeFullstackFixture(root,FULLSTACK_SERVER_HEALTH_NEVER_OK);
  const key='healthtimeout:task:1';
  const preview=createProjectPreview({npm:fakeNpm});
  t.after(async()=>{await preview.close();rmDirSafe(root);rmDirSafe(join('data/preview',previewDbSlug(key)));});
  await assert.rejects(preview.start(key,root),/健康檢查逾時/);
  assert.equal(preview.status(key),null);
});


// ---- monorepo：網頁不在版本庫根目錄 -----------------------------------------
// 真實案例：idv-web 的根目錄是 Cloudflare 部署層的 wrapper（沒有 vite、沒有 index.html），
// 實際前端在 frontend/。只看根目錄的話整個專案永遠拿不到 Preview，部署驗收也永遠停在
// 「此資料夾尚未找到可預覽的網頁」。

function monorepo(t,layout){
 const root=mkdtempSync(join(tmpdir(),'tf-monorepo-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const [rel,content] of Object.entries(layout)){
  const target=join(root,rel);
  mkdirSync(join(target,'..'),{recursive:true});
  writeFileSync(target,typeof content==='string'?content:JSON.stringify(content));
 }
 return root;
}
const vitePkg={name:'web',dependencies:{vite:'^6.0.0'},scripts:{build:'vite build'}};

test('A monorepo whose web app lives in a subdirectory is found, not reported as unsupported',t=>{
 const root=monorepo(t,{
  'package.json':{name:'deploy-wrapper',scripts:{build:'npm --prefix frontend run build'}},
  'frontend/package.json':vitePkg,
  'backend/package.json':{name:'api',dependencies:{express:'^5.0.0'}},
 });
 assert.equal(detectWebProject(root),'vite');
 assert.equal(resolveWebRoot(root).root,join(root,'frontend'));
});

test('The repository root still wins when it is itself a web project',t=>{
 const root=monorepo(t,{'package.json':vitePkg,'frontend/package.json':vitePkg});
 assert.deepEqual(resolveWebRoot(root),{root,kind:'vite'});
});

test('Two equally plausible subdirectories are reported as not found rather than guessed',t=>{
 const root=monorepo(t,{
  'package.json':{name:'wrapper'},
  'admin-portal/package.json':vitePkg,
  'storefront/package.json':vitePkg,
 });
 assert.equal(detectWebProject(root),null,'picking one of two arbitrary candidates would preview the wrong thing');
});

test('A conventional name breaks the tie when several subdirectories qualify',t=>{
 const root=monorepo(t,{
  'package.json':{name:'wrapper'},
  'frontend/package.json':vitePkg,
  'legacy-portal/package.json':vitePkg,
 });
 assert.equal(resolveWebRoot(root).root,join(root,'frontend'));
});

test('Build output and dependencies are never mistaken for the web app',t=>{
 const root=monorepo(t,{
  'package.json':{name:'wrapper'},
  'dist/index.html':'<!doctype html>',
  'node_modules/something/index.html':'<!doctype html>',
  'frontend/package.json':vitePkg,
 });
 assert.equal(resolveWebRoot(root).root,join(root,'frontend'));
});

test('A project with no web app anywhere is still reported as not found',t=>{
 const root=monorepo(t,{'package.json':{name:'cli-only'},'src/index.ts':'export {}'});
 assert.equal(detectWebProject(root),null);
});
