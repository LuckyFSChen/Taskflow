// Preview 執行期與部署驗收的整合驗證：帳密真的送進子程序、validator 用的是同一組、
// 停止之後身份真的消失。單元測試證明得了每一段，證明不了這條資料流沒有斷。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectPreview} from '../server/project-preview.js';
import {createStore,passwordMatches} from '../server/db.js';
import {validateDeployment} from '../server/deployment-validation.js';
import {isAlive} from '../server/process-lifecycle.js';

const previewDbSlug=key=>key.replace(/[^a-zA-Z0-9_-]/g,'_');
const previewDbPathFor=key=>resolve('data/preview',previewDbSlug(key),'taskflow.sqlite');
const rmDirSafe=path=>rmSync(path,{recursive:true,force:true,maxRetries:5,retryDelay:200});
const fakeNpm=async(path,args)=>{if(args[0]==='install')mkdirSync(join(path,'node_modules'),{recursive:true});};

function writeFixture(root,serverSource) {
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',dependencies:{express:'*'},devDependencies:{vite:'*'},scripts:{build:'vite build',start:'node server.js'}}));
  writeFileSync(join(root,'server.js'),serverSource);
}

// 一個真的需要登入的專案：帳密**只**從 TaskFlow 注入的環境變數來，沒有任何寫死的測試帳密，
// 也沒有讀取專案自己的 .env。這正是計畫書第七章的 Acceptance Bootstrap 約定。
const AUTH_SERVER=`
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
const port=Number(process.env.PORT),host=process.env.HOST||'127.0.0.1';
const acceptance=process.env.TASKFLOW_ACCEPTANCE_MODE==='1'?{
  username:process.env.TASKFLOW_ACCEPTANCE_USERNAME,
  password:process.env.TASKFLOW_ACCEPTANCE_PASSWORD,
}:null;
const sessions=new Set();
createServer((req,res)=>{
  const send=(code,body,headers={})=>{res.writeHead(code,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));};
  if(req.url==='/api/health')return send(200,{ok:true,service:'taskflow'});
  if(req.url==='/api/acceptance-env')return send(200,{mode:process.env.TASKFLOW_ACCEPTANCE_MODE||null,username:acceptance?.username||null,hasPassword:!!acceptance?.password});
  if(req.url==='/api/login'&&req.method==='POST'){
    let raw='';req.on('data',c=>{raw+=c;});
    req.on('end',()=>{
      let body={};try{body=JSON.parse(raw||'{}');}catch{}
      if(!acceptance||!body.username||!body.password)return send(401,{error:'Invalid credentials'});
      if(body.username!==acceptance.username||body.password!==acceptance.password)return send(401,{error:'Invalid credentials'});
      const token=randomBytes(8).toString('hex');sessions.add(token);
      send(200,{user:{username:body.username}},{'Set-Cookie':'tf_session='+token+'; Path=/; HttpOnly'});
    });
    return;
  }
  if(req.url==='/api/state'){
    const token=(req.headers.cookie||'').split('tf_session=')[1];
    if(!token||!sessions.has(token))return send(401,{error:'unauthorized'});
    return send(200,{user:{username:acceptance.username},tasks:[]});
  }
  send(404,{error:'not found'});
}).listen(port,host);
`;

async function startFixture(t,key) {
  const root=mkdtempSync(join(tmpdir(),'tf-acceptance-'));
  writeFixture(root,AUTH_SERVER);
  const preview=createProjectPreview({npm:fakeNpm});
  t.after(async()=>{await preview.close();rmDirSafe(root);rmDirSafe(join('data/preview',previewDbSlug(key)));});
  return {root,preview};
}

test('Preview 子程序真的收到 TASKFLOW_ACCEPTANCE_*，不是只存在父行程',async t=>{
  const key='acceptance-env:task:1';
  const {root,preview}=await startFixture(t,key);
  const info=await preview.start(key,root);

  const seen=await (await fetch(info.url+'/api/acceptance-env')).json();
  assert.equal(seen.mode,'1');
  assert.equal(seen.username,info.acceptance.username);
  assert.equal(seen.hasPassword,true);
  assert.equal(info.acceptance.injection.environment,true);
  await preview.stop(key);
});

test('完整驗收：health → login → state 全部通過，用的是 Preview 注入的同一組身份',async t=>{
  const key='acceptance-e2e:task:1';
  const {root,preview}=await startFixture(t,key);
  const info=await preview.start(key,root);

  const report=await validateDeployment({url:info.url,acceptance:info.acceptance});
  assert.equal(report.passed,true,JSON.stringify(report.checks));
  assert.equal(report.authentication.passed,true);
  assert.equal(report.authentication.sessionType,'cookie');
  assert.equal(report.apiState.passed,true);
  assert.equal(report.state,'PASSED');
  await preview.stop(key);
});

// 這是這次修正的回歸測試：同一個 key 第二次啟動時，Preview 資料庫已經存在而且裡面有使用者。
// 修正前的寫法只在「完全沒有使用者」時才寫入帳密，所以第二次之後 /api/login 必定 401。
test('同一個 key 重複啟動，第二次的驗收帳密一樣登得進去（401 回歸測試）',async t=>{
  const key='acceptance-reseed:task:1';
  const {root,preview}=await startFixture(t,key);

  const first=await preview.start(key,root);
  const firstPassword=first.acceptance.password;
  const firstReport=await validateDeployment({url:first.url,acceptance:first.acceptance});
  assert.equal(firstReport.passed,true);
  await preview.stop(key);

  const second=await preview.start(key,root);
  assert.notEqual(second.acceptance.password,firstPassword); // 每次都是新的一次性密碼
  assert.ok(existsSync(previewDbPathFor(key)));              // 而且資料庫是同一個、留在磁碟上的
  const secondReport=await validateDeployment({url:second.url,acceptance:second.acceptance});
  assert.equal(secondReport.passed,true,JSON.stringify(secondReport.checks));
  assert.equal(secondReport.authentication.status,200);
  await preview.stop(key);
});

test('Test 7：登入失敗也一樣要把 Preview 停掉並確認 PID 消失',async t=>{
  const key='acceptance-cleanup:task:1';
  const {root,preview}=await startFixture(t,key);
  const info=await preview.start(key,root);

  // 把注入的密碼換掉，模擬「帳密不被接受」：驗收必須失敗，但 Preview 仍然要停乾淨。
  const broken={...info.acceptance,password:'not-the-injected-password'};
  const report=await validateDeployment({url:info.url,acceptance:broken});
  assert.equal(report.passed,false);
  assert.equal(report.authentication.failureCode,'authentication_failed');

  const outcome=await preview.stop(key);
  assert.equal(outcome.stopped,true);
  assert.equal(outcome.verified,true);
  assert.equal(isAlive(info.pid),false);
});

test('Test 10：驗收帳號只存在暫時的 Preview 資料庫，停止後連那裡也不留',async t=>{
  const key='acceptance-isolation:task:1';
  const {root,preview}=await startFixture(t,key);
  const info=await preview.start(key,root);
  const dbPath=previewDbPathFor(key);

  // 隔離：驗收帳號只可能出現在 data/preview 底下這個暫時資料庫，不是正式資料庫。
  assert.equal(info.previewDbPath,dbPath);
  assert.match(dbPath,/[\\/]data[\\/]preview[\\/]/);
  assert.notEqual(dbPath,resolve('data/taskflow.sqlite'));
  assert.equal(info.acceptance.injection.database,true);

  const password=info.acceptance.password;
  await preview.stop(key);

  // 停止之後才讀檔：Preview 子程序還活著時資料庫是它的，不該從外面插手。
  assert.equal(usernamesIn(dbPath).includes('taskflow-preview'),false); // 驗收身份已清除
  assert.equal(info.acceptance.password,null);   // 記憶體裡的祕密也抹掉
  assert.equal(info.credentials.password,null);
  assert.ok(password&&password.length>10);
});

function usernamesIn(path) {
  const db=new DatabaseSync(path);
  try{return db.prepare('SELECT username FROM users').all().map(row=>row.username);}
  finally{db.close();}
}

test('Test 8（落地版）：驗收產生的任何結果都不得夾帶 password 或 cookie 值',async t=>{
  const key='acceptance-masking:task:1';
  const {root,preview}=await startFixture(t,key);
  const info=await preview.start(key,root);
  const password=info.acceptance.password;

  const report=await validateDeployment({url:info.url,acceptance:info.acceptance});
  const serialized=JSON.stringify(report);
  assert.ok(!serialized.includes(password));
  assert.ok(!serialized.includes(info.acceptance.session.cookie||'__no_cookie__'));
  await preview.stop(key);
});

// 這一段直接驗資料庫層：401 的根因就在這裡——舊寫法只在「完全沒有使用者」時才寫入帳密。
test('upsertUser 每次都把驗收帳號的密碼換成這一輪的那一組',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tf-acceptance-db-'));
  t.after(()=>rmDirSafe(dir));
  const store=createStore(join(dir,'preview.sqlite'));
  t.after(()=>store.close());

  store.addUser('既有使用者','someone-else','first-password-123');
  store.upsertUser('TaskFlow Preview','taskflow-preview','first-acceptance-pw');
  const first=store.db.prepare('SELECT password FROM users WHERE username=?').get('taskflow-preview').password;

  // 資料庫裡已經有使用者了——舊寫法到這裡就不再寫入，validator 手上的新密碼永遠對不上。
  store.upsertUser('TaskFlow Preview','taskflow-preview','second-acceptance-pw');
  const second=store.db.prepare('SELECT password FROM users WHERE username=?').get('taskflow-preview').password;
  assert.notEqual(second,first);
  assert.equal(passwordMatches('second-acceptance-pw',second),true);
  assert.equal(passwordMatches('first-acceptance-pw',second),false);
  // 別人的帳號不受影響
  assert.equal(passwordMatches('first-password-123',store.db.prepare('SELECT password FROM users WHERE username=?').get('someone-else').password),true);

  store.removeAcceptanceUser('taskflow-preview');
  assert.equal(store.db.prepare('SELECT 1 FROM users WHERE username=?').get('taskflow-preview'),undefined);
  assert.ok(store.db.prepare('SELECT 1 FROM users WHERE username=?').get('someone-else'));
});
