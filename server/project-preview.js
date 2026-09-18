import express from 'express';
import {spawn} from 'node:child_process';
import {createServer as createNetProbe} from 'node:net';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,extname} from 'node:path';
import {HttpError} from './domain.js';
import {killTree} from './runner.js';
import {createStore} from './db.js';

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
export function detectWebProject(path) {
  let pkg;
  try {pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));}
  catch {return existsSync(join(path,'index.html'))?'static':null;}
  const deps={...pkg.dependencies,...pkg.devDependencies};
  const hasViteBuild=!!deps.vite&&!!pkg.scripts?.build;
  if(hasViteBuild&&resolveFullstackEntry(path,pkg))return 'fullstack';
  if(hasViteBuild)return 'vite';
  return null;
}
export function openFolder(path,{launch=spawn}={}) {
  if(!existsSync(path)||!statSync(path).isDirectory())throw new HttpError(404,'資料夾不存在');
  // This is an explicitly requested interactive window, not a background helper.
  // /n prevents Explorer from reusing a hidden window created by older versions.
  const child=launch(join(process.env.WINDIR||'C:\\Windows','explorer.exe'),['/n,',realpathSync(path)],{windowsHide:false,detached:true,stdio:'ignore',shell:false});
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
}
function runNpm(cwd,args) {
  const cli=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  if(!existsSync(cli))throw new HttpError(503,'找不到 npm，請安裝包含 npm 的 Node.js。');
  const env={...process.env};
  for(const key of ['INBOX_TOKEN','LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY'])delete env[key];
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{cwd,env,shell:false,windowsHide:true});
    let output='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;killTree(child);},180000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-3000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0&&!timedOut?resolve():reject(new HttpError(422,timedOut?'安裝或建置超過三分鐘，請檢查專案。':`網頁建置失敗：${output}`));});
  });
}
function getFreePort() {
  return new Promise((resolvePort,reject)=>{
    const probe=createNetProbe();
    probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolvePort(port));});
  });
}
function safeKeyFragment(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g,'_');
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
export function createProjectPreview({npm=runNpm}={}) {
  const running=new Map(),pending=new Map();
  async function startFullstack(key,path,pkg) {
    const serverFile=resolveFullstackEntry(path,pkg);
    if(!serverFile)throw new HttpError(422,'找不到可信任的 fullstack 啟動腳本。');
    if(!existsSync(join(path,'node_modules')))await npm(path,['install']);
    await npm(path,['run','build']);
    const port=await getFreePort();
    const previewDbPath=resolve('data/preview',safeKeyFragment(key),'taskflow.sqlite');
    const username='taskflow-preview',password=randomBytes(18).toString('base64url');
    const seedStore=createStore(previewDbPath);
    try{if(!seedStore.db.prepare('SELECT id FROM users LIMIT 1').get())seedStore.addUser('TaskFlow Preview',username,password,'admin');}
    finally{seedStore.close();}
    const env={...process.env};
    for(const k of ['INBOX_TOKEN','LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY'])delete env[k];
    env.PORT=String(port);env.HOST='127.0.0.1';env.TASKFLOW_DB_FILE=previewDbPath;
    const child=spawn(process.execPath,[serverFile],{cwd:path,env,shell:false,windowsHide:true});
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
      killTree(child);
      throw err;
    }finally{
      exitPromise.catch(()=>{});
    }
    startupSettled=true;
    const info={url,kind:'fullstack',pid:child.pid,cwd:path,credentials:{username,password}};
    running.set(key,{child,info});
    child.once('exit',()=>{if(running.get(key)?.child===child)running.delete(key);});
    return info;
  }
  async function start(key,path) {
    if(running.has(key))return running.get(key).info;
    if(pending.has(key))return pending.get(key);
    const job=(async()=>{
      const kind=detectWebProject(path);
      if(!kind)throw new HttpError(422,'目前支援 Vue／Vite 專案與純 HTML 網頁；此資料夾尚未找到可預覽的網頁。');
      if(kind==='fullstack'){
        const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
        return await startFullstack(key,path,pkg);
      }
      let root=path;
      if(kind==='vite'){
        if(!existsSync(join(path,'node_modules')))await npm(path,['install']);
        await npm(path,['run','build']);
        root=join(path,'dist');
      }
      if(!existsSync(join(root,'index.html')))throw new HttpError(422,'找不到網頁入口 dist/index.html，請確認建置輸出設定。');
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
      app.use(express.static(root,{dotfiles:'deny'}));
      app.get('/{*path}',(req,res)=>{if(req.accepts('html'))res.sendFile(join(root,'index.html'));else res.sendStatus(404);});
      const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
      const info={url:`http://127.0.0.1:${server.address().port}`,kind};
      running.set(key,{server,info});return info;
    })();
    pending.set(key,job);
    try{return await job;}finally{pending.delete(key);}
  }
  async function stop(key){
    if(pending.has(key))throw new HttpError(409,'網頁正在準備，請完成後再停止');
    const item=running.get(key);
    if(!item)return;
    running.delete(key);
    if(item.server){item.server.closeAllConnections();await new Promise(resolve=>item.server.close(resolve));}
    if(item.child){
      await new Promise(resolveStop=>{
        if(item.child.exitCode!==null||item.child.signalCode){resolveStop();return;}
        const timer=setTimeout(resolveStop,5000);
        item.child.once('exit',()=>{clearTimeout(timer);resolveStop();});
        killTree(item.child);
      });
    }
  }
  return {stopProject:async pid=>{const matches=key=>key===pid||key.startsWith(pid+':');if([...pending.keys()].some(matches))throw new HttpError(409,'網頁正在建置，請完成後再停止');await Promise.all([...running.keys()].filter(matches).map(stop));},hasProjectActivity:pid=>[...running.keys(),...pending.keys()].some(key=>key===pid||key.startsWith(pid+':')),start,stop,status:key=>running.get(key)?.info||null,close:async()=>{await Promise.allSettled([...pending.values()]);await Promise.all([...running.keys()].map(stop));}};
}
