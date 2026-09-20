import express from 'express';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {existsSync,readdirSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,extname} from 'node:path';
import {HttpError} from './domain.js';
import {killTree} from './runner.js';
import {createStore} from './db.js';
import {registerPreview,unregisterPreview,waitForExit} from './process-lifecycle.js';
import {acceptanceEnvironment,cleanupAcceptanceContext,createAcceptanceContext} from './acceptance-auth.js';
import {childEnvironment,resolveNpmCli} from './npm-runner.js';
import {resolveRuntimeTopology,serviceDirectory,topologyPublic} from './runtime-topology.js';
import {allocatePort,createRuntimeManager,runtimePublic,waitForPortRelease} from './runtime-manager.js';
import {createRuntimePortManager,isPortBindCollision} from './runtime-port-manager.js';
import {RuntimeFailure} from './runtime-validation.js';

// acquire() 選中的候選 port 與這裡真正 spawn／listen 之間有一個檢查空檔，另一個獨立的 TaskFlow
// 行程理論上可能搶先 bind 到同一個 port（見 runtime-port-manager.js 的 isPortBindCollision 註解）。
const MAX_PORT_BIND_ATTEMPTS=5;

const KNOWN_SERVER_DEPS=['express','fastify','koa','hapi','restify'];
// Only a bare `node <relative-file>.js` start script is trusted enough to auto-spawn;
// anything with flags, env prefixes or shell operators (&&, |, ;, >) falls back to vite/static.
const SIMPLE_NODE_START=/^node\s+([\w.\-]+(?:\/[\w.\-]+)*\.js)$/;
function resolveFullstackEntry(path,pkg) {
  const deps={...pkg.dependencies,...pkg.devDependencies};
  const startScript=typeof pkg.scripts?.start==='string'?pkg.scripts.start.trim():null;
  if(!startScript)return null;
  const match=SIMPLE_NODE_START.exec(startScript);
  const serverFile=match?.[1];
  if(serverFile&&!isAbsolute(serverFile)&&!serverFile.split('/').includes('..')&&existsSync(join(path,serverFile))&&KNOWN_SERVER_DEPS.some(dep=>deps[dep]))return serverFile;
  return null;
}
function detectWebProjectHere(path) {
  let pkg;
  try {pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));}
  catch {return existsSync(join(path,'index.html'))?'static':null;}
  const deps={...pkg.dependencies,...pkg.devDependencies};
  const hasViteBuild=!!deps.vite&&!!pkg.scripts?.build;
  if(hasViteBuild&&resolveFullstackEntry(path,pkg))return 'fullstack';
  if(hasViteBuild)return 'vite';
  return null;
}
// 專案的網頁不一定在版本庫根目錄。monorepo 常見的形狀是根目錄放部署層或 workspace 設定，
// 實際的前端在 frontend/、web/、client/ 這類子目錄；只看根目錄的話這種專案完全拿不到 Preview，
// Browser Validation 也就永遠沒有可用的網址。
//
// 只往下找一層，而且不猜：根目錄本身是網頁專案就用根目錄；否則掃描第一層子目錄，剛好只有一個
// 子目錄是網頁專案時才採用它。多於一個時，只有在其中恰好一個命中慣用名稱時才採用——否則寧可
// 回報「找不到」，也不要挑錯一個目錄拿去預覽或驗收。
//
// 注意：這條路徑只負責**單一服務**專案。前後端分離的專案走 runtime-topology.js，
// 因為「只挑一個目錄」這件事本身就是那種專案 /api/* 拿到 SPA fallback 的根本原因。
const NESTED_SKIP=new Set(['node_modules','dist','build','out','coverage','tmp','temp','vendor','public','assets','docs','test','tests','__tests__','scripts','migrations']);
const NESTED_CONVENTIONAL=['frontend','web','client','app','ui','site','www'];
export function resolveWebRoot(path) {
  const here=detectWebProjectHere(path);
  if(here)return {root:path,kind:here};
  let entries;
  try {entries=readdirSync(path,{withFileTypes:true});}
  catch {return null;}
  const candidates=[];
  for(const entry of entries){
    if(!entry.isDirectory()||entry.name.startsWith('.')||NESTED_SKIP.has(entry.name))continue;
    const child=join(path,entry.name);
    const kind=detectWebProjectHere(child);
    if(kind)candidates.push({root:child,kind,name:entry.name});
  }
  if(candidates.length===1)return {root:candidates[0].root,kind:candidates[0].kind};
  if(candidates.length>1){
    const preferred=candidates.filter(candidate=>NESTED_CONVENTIONAL.includes(candidate.name));
    if(preferred.length===1)return {root:preferred[0].root,kind:preferred[0].kind};
  }
  return null;
}
export function detectWebProject(path) {
  // multi-service 專案也是網頁專案：browserEntry 那個 service 的 kind 就是它的 kind。
  // 少了這一句，deriveBrowserValidationRequirement() 會對前後端分離專案回「非網頁專案」，
  // Browser Validation 直接不被要求——比跑了失敗更糟。
  // 設定檔壞掉時不能讓「這是不是網頁專案」整個查不出來：那會讓專案列表與 Browser
  // Validation 判定一起失效。解析不了就退回既有的單一服務偵測，錯誤留到 start() 再報。
  try{
    const topology=resolveRuntimeTopology(path);
    if(topology){
      const entry=topology.services.find(service=>service.browserEntry);
      if(entry)return detectWebProjectHere(serviceDirectory(entry,path))||'vite';
    }
  }catch{/* 交給 start() 回報可讀的設定錯誤 */}
  return resolveWebRoot(path)?.kind||null;
}
export function openFolder(path,{launch=spawn}={}) {
  if(!existsSync(path)||!statSync(path).isDirectory())throw new HttpError(404,'資料夾不存在');
  // This is an explicitly requested interactive window, not a background helper.
  // /n prevents Explorer from reusing a hidden window created by older versions.
  const child=launch(join(process.env.WINDIR||'C:\\Windows','explorer.exe'),['/n,',realpathSync(path)],{windowsHide:false,detached:true,stdio:'ignore',shell:false});
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
}
// npm-cli 的定位與秘密剝除收斂到 npm-runner.js（那裡的註解本來就說「下次動 Preview 時
// 應該收斂過來」）。這裡保留自己的語意：建置失敗就丟 HttpError，不把輸出交給呼叫端判讀。
function runNpm(cwd,args) {
  const cli=resolveNpmCli();
  if(!cli)throw new HttpError(503,'找不到 npm，請安裝包含 npm 的 Node.js。');
  const env=childEnvironment(process.env);
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{cwd,env,shell:false,windowsHide:true});
    let output='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;killTree(child);},180000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-3000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0&&!timedOut?resolve():reject(new HttpError(422,timedOut?'安裝或建置超過三分鐘，請檢查專案。':`網頁建置失敗：${output}`));});
  });
}
function safeKeyFragment(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g,'_');
}
// topology 解析失敗（設定檔語法錯、id 重複、相依成環）不該讓整個 Preview 直接爆掉：
// 那些都是使用者改得了的設定問題，應該以可讀訊息回報。解析不出來就當作單一服務。
function safeTopology(path) {
  try {return resolveRuntimeTopology(path);}
  catch(error){throw new HttpError(422,`runtime 設定無法解析：${error.message}`);}
}
// Only /api/health responses shaped like TaskFlow's own {ok:true,service:'taskflow'} are held to
// that exact contract; any other 200 (a foreign fullstack project's generic health route) is accepted.
async function waitForHealth(url,timeoutMs) {
  const deadline=Date.now()+timeoutMs;
  let lastError='未收到任何回應';
  while(Date.now()<deadline){
    try{
      const res=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(2000)});
      if(res.status===200){
        let body=null;
        try{body=await res.json();}catch{}
        if(body&&typeof body==='object'&&'service' in body){
          if(body.ok===true&&body.service==='taskflow')return;
          lastError='/api/health 回應格式類似 TaskFlow 但內容不符';
        }else return;
      }else lastError=`/api/health 回傳 HTTP ${res.status}`;
    }catch(err){lastError=err.message;}
    await new Promise(r=>setTimeout(r,300));
  }
  throw new HttpError(422,`Preview 伺服器健康檢查逾時：${lastError}`);
}

// --- 前端靜態伺服器（含轉發） --------------------------------------------------
//
// Preview 的前端一律由 TaskFlow 自己的 express 提供，不 spawn `vite preview`。
// 理由是轉發：`/api/*` 必須確實打到**本次配到的** backend port。依賴專案自己的
// vite.config proxy 只會打到裡面寫死的 localhost:3001——那個 port 在 Preview 期間
// 根本沒有東西在聽，於是請求落回 SPA fallback，變成 200 text/html 的假陽性。
function matchesPrefix(path,prefix){
  if(prefix==='/')return true;
  const clean=prefix.endsWith('/')?prefix.slice(0,-1):prefix;
  return path===clean||path.startsWith(clean+'/');
}
export function createProxyMiddleware(prefixes,target){
  // proxyPaths 現在是 {path,kind} 的陣列（kind 只影響驗證方式，不影響轉發本身）；
  // 仍接受純字串，讓舊的呼叫端與測試不必一起改。
  const list=(prefixes||[]).map(entry=>typeof entry==='string'?entry:entry?.path).filter(prefix=>typeof prefix==='string'&&prefix.startsWith('/'));
  if(!list.length||!target)return (req,res,next)=>next();
  const upstream=new URL(target);
  return (req,res,next)=>{
    if(!list.some(prefix=>matchesPrefix(req.path,prefix)))return next();
    const headers={...req.headers,host:upstream.host};
    delete headers['accept-encoding']; // 不轉發壓縮協商：驗證要讀得懂 body，不需要為此解壓。
    const proxied=httpRequest({
      protocol:upstream.protocol,hostname:upstream.hostname,port:upstream.port,
      path:req.originalUrl,method:req.method,headers,
    },response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
    // 後端不在、連線被拒：回 502 而**不是**交給 SPA fallback。這正是整改要消滅的假 200。
    proxied.on('error',error=>{
      if(res.headersSent)return res.destroy();
      res.status(502).type('application/json').end(JSON.stringify({error:'upstream_unavailable',target:upstream.origin,detail:String(error?.message||error).slice(0,200)}));
    });
    req.pipe(proxied);
  };
}
// port 一律由呼叫端先向 TaskFlow Runtime Port Pool 租好再傳進來；不再自己 listen(0)
// 跟作業系統要一個隨機 port——那樣就繞過了 pool，變成又一個「TaskFlow 管的服務用了非 pool port」的洞。
function createStaticServer({root,kind,proxyPaths=[],proxyTarget=null,port}) {
  root=realpathSync(root);
  const app=express();
  app.use((req,res,next)=>{
    if(!/^127\.0\.0\.1:\d+$/.test(req.get('host')||''))return res.sendStatus(403);
    res.setHeader('Cache-Control','no-store');
    // Refuse hidden files and symlink escapes, including static-project previews.
    let candidate;
    try{const parts=decodeURIComponent(req.path).split('/');if(parts.some(p=>p.startsWith('.')||['node_modules','server','package.json','package-lock.json'].includes(p)))return res.sendStatus(404);candidate=resolve(root,'.'+decodeURIComponent(req.path));}catch{return res.sendStatus(400);}
    if(kind==='static'&&extname(candidate)&&!['.html','.css','.js','.mjs','.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.woff','.woff2','.ttf','.mp4','.webm'].includes(extname(candidate).toLowerCase()))return res.sendStatus(404);
    if(existsSync(candidate)){const rel=relative(root,realpathSync(candidate));if(rel.startsWith('..')||isAbsolute(rel))return res.sendStatus(403);}
    next();
  });
  // 轉發排在靜態與 SPA fallback 之前：被宣告為後端路徑的請求絕不可能拿到 index.html。
  if(proxyTarget)app.use(createProxyMiddleware(proxyPaths,proxyTarget));
  app.use(express.static(root,{dotfiles:'deny'}));
  app.get('/{*path}',(req,res)=>{if(req.accepts('html'))res.sendFile(join(root,'index.html'));else res.sendStatus(404);});
  return new Promise((resolveServer,reject)=>{const server=app.listen(port,'127.0.0.1',()=>resolveServer(server));server.once('error',reject);});
}

// registryPath：把記憶體裡的 running 表同時寫一份到磁碟。純粹是為了服務重新啟動之後
// 還認得出自己開過哪些 Preview 子程序——記憶體那份一重啟就沒了，子程序卻還活著。
//
// portManager：整個 Preview 模組只有這一個 TaskFlow Runtime Port Pool 實例——multi-service
// runtime（見 startTopologyRuntime）、單一程序 fullstack（startFullstack）、純靜態／vite
// 預覽（start() 尾端）全部共用同一份帳本，active lease 才能做到跨這些路徑全域唯一。
export function createProjectPreview({npm=runNpm,registryPath=resolve('data/preview/registry.json'),portManager=createRuntimePortManager(),onRuntimeEvent=()=>{},healthTimeoutMs=120000}={}) {
  const running=new Map(),pending=new Map();
  // 120 秒：後端的 dev script 常常包含 prisma generate／db push／seed 這類一次性準備工作，
  // 第一次啟動本來就會比較慢。逾時太短只會把「還在準備」誤報成「啟動失敗」。
  const manager=createRuntimeManager({registryPath,onEvent:onRuntimeEvent,healthTimeoutMs,portManager});

  async function startFullstack(key,path,pkg) {
    const serverFile=resolveFullstackEntry(path,pkg);
    if(!serverFile)throw new HttpError(422,'找不到可信任的 fullstack 啟動腳本。');
    if(!existsSync(join(path,'node_modules')))await npm(path,['install']);
    await npm(path,['run','build']);
    attempts: for(let attempt=1;attempt<=MAX_PORT_BIND_ATTEMPTS;attempt++){
      const port=await allocatePort(portManager,{taskId:key,serviceId:'app'});
      // 這個 lease 在 spawn 成功、bindPid() 之前都還沒有 PID 撐著；下面任何一步失敗都要放回 pool。
      let bound=false;
      try{
        const previewDbPath=resolve('data/preview',safeKeyFragment(key),'taskflow.sqlite');
        // 驗收身份由 AcceptanceContext 產生，Preview 與 Deployment Validator 共用同一份。
        // 兩邊各自產生帳密，就是 /api/login 永遠 401 的成因。
        const acceptance=createAcceptanceContext({projectPath:path,key});
        // 每一次啟動都把驗收帳號**重設**成這一輪的密碼。之前只在「資料庫完全沒有使用者」時
        // 才寫入，而 Preview 資料庫是跨次保留的——第二次之後 validator 手上的新密碼
        // 與資料庫裡的舊雜湊永遠對不起來，登入必定 401。
        try{
          const seedStore=createStore(previewDbPath);
          try{seedStore.upsertUser('TaskFlow Preview',acceptance.username,acceptance.password,'admin');acceptance.injection.database=true;}
          finally{seedStore.close();}
        }catch(error){acceptance.injection.error=String(error?.message||error).slice(0,200);}
        const env={...process.env};
        for(const k of ['INBOX_TOKEN','LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY'])delete env[k];
        env.PORT=String(port);env.HOST='127.0.0.1';env.TASKFLOW_DB_FILE=previewDbPath;
        // 這個 Preview 只有一個程序，PORT 就是它自己的 port；語意化別名一併提供，
        // 讓專案不必再從 PORT 反推「這是前端還是後端」（計畫書第八章）。
        env.PREVIEW_PORT=String(port);env.PREVIEW_URL=`http://127.0.0.1:${port}`;
        // 非 TaskFlow 結構的專案讀不到上面那個資料庫，但可以在啟動時看見這組環境變數，
        // 自己建立同樣的暫時帳號（README 的 Acceptance Bootstrap 約定）。
        Object.assign(env,acceptanceEnvironment(acceptance));
        acceptance.injection.environment=true;
        const child=spawn(process.execPath,[serverFile],{cwd:path,env,shell:false,windowsHide:true});
        portManager.bindPid(port,child.pid);
        bound=true;
        let stderr='';
        child.stderr?.on('data',d=>{stderr=(stderr+d).slice(-3000);});
        let startupSettled=false;
        const exitPromise=new Promise((_,reject)=>{
          child.once('error',err=>{if(!startupSettled){startupSettled=true;reject(new HttpError(500,`啟動 Preview 伺服器失敗：${err.message}`));}});
          child.once('exit',code=>{if(!startupSettled){startupSettled=true;reject(new HttpError(422,`Preview 伺服器提前結束（code ${code}）：${stderr||'(無 stderr 輸出)'}`));}});
        });
        const url=`http://127.0.0.1:${port}`;
        try{
          await Promise.race([exitPromise,waitForHealth(url,20000)]);
        }catch(err){
          // Wait for the child to actually exit before rejecting, so a failed/timed-out startup
          // never leaves an orphaned process still holding its cwd (and this fixture's temp dir) open.
          await new Promise(resolveKill=>{
            if(child.exitCode!==null||child.signalCode){resolveKill();return;}
            const timer=setTimeout(resolveKill,5000);
            child.once('exit',()=>{clearTimeout(timer);resolveKill();});
            killTree(child);
          });
          // 確認 PID 真的消失、port 真的釋放，才把 lease 放回 pool——順序不能反過來。
          if(await waitForExit(child.pid,{timeoutMs:5000})&&await waitForPortRelease(port))portManager.release(port);
          // acquire() 選中的候選 port 與這裡真正 spawn 之間有檢查空檔，另一個獨立的 TaskFlow
          // 行程可能搶先 bind 到同一個 port；真的撞上時租一個新的再試，而不是當成專案本身的啟動失敗。
          if(attempt<MAX_PORT_BIND_ATTEMPTS&&isPortBindCollision(stderr))continue attempts;
          throw err;
        }finally{
          exitPromise.catch(()=>{});
        }
        startupSettled=true;
        // credentials 是既有呼叫端（runner.js 的 Browser Validation prompt）用的舊形狀，
        // 值直接取自同一個 AcceptanceContext——不是另外產生的第二組。
        const info={url,kind:'fullstack',pid:child.pid,port,cwd:path,acceptance,credentials:{username:acceptance.username,password:acceptance.password},previewDbPath};
        running.set(key,{child,info});
        registerPreview(registryPath,{key,pid:child.pid,url,kind:'fullstack',cwd:path});
        child.once('exit',()=>{if(running.get(key)?.child===child)running.delete(key);unregisterPreview(registryPath,key);});
        return info;
      }catch(error){
        if(!bound)portManager.release(port);
        throw error;
      }
    }
    throw new HttpError(503,'TaskFlow runtime port pool 連續多次都撞上其他行程正在搶用的 port，請稍後再試。');
  }

  // Multi-Service Preview：依 topology 啟動整組服務，前端由 TaskFlow 自管並轉發到後端。
  async function startTopologyRuntime(key,path,topology) {
    const startManaged=async(service,{port,peers})=>{
      const dir=serviceDirectory(service,path);
      const kind=detectWebProjectHere(dir);
      const root=kind==='static'?dir:join(dir,'dist');
      if(!existsSync(join(root,'index.html')))throw new RuntimeFailure('service_start_failed',`service ${service.id} 找不到網頁入口 ${relative(path,join(root,'index.html'))}，請確認建置輸出設定。`);
      // 轉發目標：本次實際配到的後端 URL。相依裡沒有後端時就不開轉發，行為與單一服務一致。
      const backend=peers.find(peer=>service.dependsOn.includes(peer.id)&&peer.url)||peers.find(peer=>peer.type==='backend');
      const server=await createStaticServer({root,kind:kind||'vite',proxyPaths:service.proxyPaths||['/api'],proxyTarget:backend?.url||null,port});
      const url=`http://127.0.0.1:${server.address().port}`;
      return {url,stop:async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));}};
    };
    const runtime=await manager.start(key,topology,{
      npm,
      startManaged,
      env:{PREVIEW_URL:'',PREVIEW_PORT:''},
    });
    const entry=runtime.services.find(state=>state.browserEntry)||runtime.services.at(-1);
    const info={
      url:entry?.url||null,
      kind:'multi-service',
      pid:null,
      cwd:path,
      topology,
      runtime:runtimePublic(runtime),
      topologyPublic:topologyPublic(topology),
      services:runtimePublic(runtime).services,
      acceptance:null,
      credentials:null,
    };
    running.set(key,{runtime:true,info});
    return info;
  }

  async function start(key,path) {
    if(running.has(key)){
      const item=running.get(key);
      // multi-service：每次 start 都重新核對指紋，stale 的服務自己重啟，READY 的沿用。
      if(item.runtime)return await startTopologyRuntime(key,path,item.info.topology);
      return item.info;
    }
    if(pending.has(key))return pending.get(key);
    const job=(async()=>{
      const topology=safeTopology(path);
      if(topology)return await startTopologyRuntime(key,path,topology);
      const resolved=resolveWebRoot(path);
      if(!resolved)throw new HttpError(422,'目前支援 Vue／Vite 專案與純 HTML 網頁；此資料夾與其第一層子目錄都沒有找到可預覽的網頁。若這是前後端分離或 monorepo 專案，請以 taskflow.runtime.json 明確宣告 runtime services。');
      const {root:projectRoot,kind}=resolved;
      if(kind==='fullstack'){
        const pkg=JSON.parse(readFileSync(join(projectRoot,'package.json'),'utf8'));
        return await startFullstack(key,projectRoot,pkg);
      }
      let root=projectRoot;
      if(kind==='vite'){
        if(!existsSync(join(projectRoot,'node_modules')))await npm(projectRoot,['install']);
        await npm(projectRoot,['run','build']);
        root=join(projectRoot,'dist');
      }
      if(!existsSync(join(root,'index.html')))throw new HttpError(422,'找不到網頁入口 dist/index.html，請確認建置輸出設定。');
      for(let attempt=1;attempt<=MAX_PORT_BIND_ATTEMPTS;attempt++){
        const port=await allocatePort(portManager,{taskId:key,serviceId:'preview'});
        let server;
        try{server=await createStaticServer({root,kind,port});}
        catch(error){
          portManager.release(port);
          // acquire() 選中的候選 port 與這裡真正 listen 之間有檢查空檔，另一個獨立的 TaskFlow
          // 行程可能搶先 bind 到同一個 port；真的撞上時租一個新的再試。
          if(attempt<MAX_PORT_BIND_ATTEMPTS&&(error?.code==='EADDRINUSE'||isPortBindCollision(error?.message)))continue;
          throw error;
        }
        portManager.bindPid(port,null);
        const info={url:`http://127.0.0.1:${server.address().port}`,kind,port};
        running.set(key,{server,info});return info;
      }
      throw new HttpError(503,'TaskFlow runtime port pool 連續多次都撞上其他行程正在搶用的 port，請稍後再試。');
    })();
    pending.set(key,job);
    try{return await job;}finally{pending.delete(key);}
  }
  function clearAcceptance(info){
    const acceptance=info?.acceptance;
    if(!acceptance)return;
    if(acceptance.injection?.database&&info.previewDbPath){
      try{
        const store=createStore(info.previewDbPath);
        try{store.removeAcceptanceUser(acceptance.username);}finally{store.close();}
      }catch{/* 清不掉就留著：下一次啟動一律重設密碼，不會因此卡住驗收 */}
    }
    cleanupAcceptanceContext(acceptance);
    if(info.credentials)info.credentials={username:acceptance.username,password:null};
  }
  async function stop(key){
    if(pending.has(key))throw new HttpError(409,'網頁正在準備，請完成後再停止');
    const item=running.get(key);
    if(!item)return {stopped:false,reason:'not_running'};
    running.delete(key);
    // Multi-Service：交給 Process Lifecycle Manager 反向關閉，逐一確認 PID 消失且 port 釋放。
    if(item.runtime){
      const outcome=await manager.stop(key);
      return {stopped:true,pid:null,verified:outcome.verified!==false,services:outcome.services};
    }
    if(item.server){item.server.closeAllConnections();await new Promise(resolve=>item.server.close(resolve));}
    if(!item.child){
      unregisterPreview(registryPath,key);
      // 單一服務靜態／vite 預覽沒有子程序，express 的 close() callback 已經確認關閉，
      // 這裡仍照既有原則再向作業系統確認一次「port 真的不再 Listen」才 release，不用猜的。
      if(item.info?.port!=null&&await waitForPortRelease(item.info.port))portManager.release(item.info.port);
      return {stopped:true,pid:null,verified:true};
    }
    await new Promise(resolveStop=>{
      if(item.child.exitCode!==null||item.child.signalCode){resolveStop();return;}
      const timer=setTimeout(resolveStop,5000);
      item.child.once('exit',()=>{clearTimeout(timer);resolveStop();});
      killTree(item.child);
    });
    // killTree() 在 Windows 上是射後不理，子程序的 exit 事件也只在「它是我們的子程序」時才可靠。
    // 這裡再向作業系統確認一次 PID 真的不見了；沒消失就照實回報 verified:false，不假裝停好了。
    const verified=await waitForExit(item.info?.pid,{timeoutMs:5000});
    // PID 沒真的消失就不 release：port 可能還被它聽著，放回 pool 只會製造下一個 runtime
    // 搶到同一個 port 的 race condition，交給日後的 reconcile() 依 PID 再判斷一次。
    if(verified&&item.info?.port!=null&&await waitForPortRelease(item.info.port))portManager.release(item.info.port);
    unregisterPreview(registryPath,key);
    // 一次性驗收身份到這裡為止：把帳號與工作階段從 Preview 資料庫刪掉，再把記憶體裡的
    // 祕密抹掉。留著等下一次「反正會重設」不算隔離——Preview 資料庫在磁碟上是留著的。
    clearAcceptance(item.info);
    return {stopped:true,pid:item.info?.pid??null,verified};
  }
  return {stopProject:async pid=>{const matches=key=>key===pid||key.startsWith(pid+':');if([...pending.keys()].some(matches))throw new HttpError(409,'網頁正在建置，請完成後再停止');await Promise.all([...running.keys()].filter(matches).map(stop));},hasProjectActivity:pid=>[...running.keys(),...pending.keys()].some(key=>key===pid||key.startsWith(pid+':')),start,stop,status:key=>running.get(key)?.info||null,runtime:key=>manager.get(key),close:async()=>{await Promise.allSettled([...pending.values()]);await Promise.all([...running.keys()].map(stop));}};
}
