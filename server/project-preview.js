import express from 'express';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,extname} from 'node:path';
import {HttpError} from './domain.js';
import {killTree} from './runner.js';

export function detectWebProject(path) {
  try {
    const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
    if((pkg.dependencies?.vite||pkg.devDependencies?.vite)&&pkg.scripts?.build)return 'vite';
    return null;
  } catch {return existsSync(join(path,'index.html'))?'static':null;}
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
export function createProjectPreview({npm=runNpm}={}) {
  const running=new Map(),pending=new Map();
  async function start(key,path) {
    if(running.has(key))return running.get(key).info;
    if(pending.has(key))return pending.get(key);
    const job=(async()=>{
      const kind=detectWebProject(path);
      if(!kind)throw new HttpError(422,'目前支援 Vue／Vite 專案與純 HTML 網頁；此資料夾尚未找到可預覽的網頁。');
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
  async function stop(key){if(pending.has(key))throw new HttpError(409,'網頁正在準備，請完成後再停止');const item=running.get(key);if(item){running.delete(key);item.server.closeAllConnections();await new Promise(resolve=>item.server.close(resolve));}}
  return {stopProject:async pid=>{const matches=key=>key===pid||key.startsWith(pid+':');if([...pending.keys()].some(matches))throw new HttpError(409,'網頁正在建置，請完成後再停止');await Promise.all([...running.keys()].filter(matches).map(stop));},hasProjectActivity:pid=>[...running.keys(),...pending.keys()].some(key=>key===pid||key.startsWith(pid+':')),start,stop,status:key=>running.get(key)?.info||null,close:async()=>{await Promise.allSettled([...pending.values()]);await Promise.all([...running.keys()].map(stop));}};
}
