// Deterministic, read-only system health. Every check either reads state TaskFlow
// already owns or asks a tool to print its version — no LLM is ever consulted, no
// command that modifies the system is run, nothing is installed, no login is
// attempted and no setting is written. CLI discovery is delegated to
// resolveCliExecutable() and Browser MCP to checkClaudeBrowserCapability(); this
// file deliberately re-implements neither, so a fix there fixes health too.
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {resolveCliExecutable} from './cli-executable.js';
import {checkClaudeBrowserCapability} from './browser-capability.js';

export const HEALTH_STATUSES=['ok','warning','error','unknown'];
// 'unknown' ranks below 'warning': not knowing (e.g. LINE never configured) is not
// itself a fault, but it must still stop the whole report from claiming 'ok'.
const SEVERITY={ok:0,unknown:1,warning:2,error:3};

export function aggregateStatus(checks){
  let worst='ok';
  for(const check of Object.values(checks||{})){
    const status=HEALTH_STATUSES.includes(check?.status)?check.status:'unknown';
    if(SEVERITY[status]>SEVERITY[worst])worst=status;
  }
  return worst;
}

// `--version` is the only argument ever passed: it prints and exits, so it cannot
// log in, install, or change configuration. No shell is involved, so nothing in the
// resolved path can be interpreted as a command.
export function probeCliVersion(engine,{env=process.env,execFileImpl=execFile,timeoutMs=10000}={}){
  const executable=resolveCliExecutable(engine,{env});
  return new Promise(resolve=>{
    try{
      execFileImpl(executable,['--version'],{timeout:timeoutMs,windowsHide:true},(error,stdout)=>{
        if(error)return resolve({executable,available:false,version:null,error:String(error.message||error).slice(0,300)});
        resolve({executable,available:true,version:String(stdout||'').trim().split('\n')[0].slice(0,120)||null,error:null});
      });
    }catch(error){resolve({executable,available:false,version:null,error:String(error.message||error).slice(0,300)});}
  });
}

export function engineCheck(engine,probe,label){
  if(probe?.available)return {status:'ok',message:probe.version?`${label} 可使用（${probe.version}）`:`${label} 可使用`};
  const variable=engine==='codex'?'CODEX_BIN':'CLAUDE_BIN';
  return {status:'error',message:`${label} 無法執行。請確認已安裝並完成登入，或以 ${variable} 指定執行檔路徑。`};
}

// package.json 的 engines 要求 Node 24 以上（node:sqlite 等功能需要）。這裡只讀取
// 目前 process 的版本字串，不執行任何指令，也不嘗試安裝或切換版本。
export function runtimeCheck({version=process.versions.node,required=24}={}){
  const major=Number.parseInt(String(version||'').split('.')[0],10);
  if(!Number.isFinite(major))return {status:'unknown',message:'無法判斷目前的 Node 版本'};
  return major>=required
    ?{status:'ok',message:`Node ${version} 可使用`}
    :{status:'error',message:`Node ${version} 過舊：TaskFlow 需要 Node ${required} 以上，請升級後重新啟動服務。`};
}

export function runnerCheck(store){
  return store.setting('runnerEnabled',false)
    ?{status:'ok',message:'任務服務已啟用'}
    :{status:'warning',message:'任務服務未啟用，佇列中的任務不會自動執行'};
}

export function browserCheck(capability){
  if(capability?.available)return {status:'ok',message:`Browser MCP 可使用（${capability.provider||'playwright-mcp'}）`};
  return {status:'warning',message:String(capability?.error||'Browser MCP 無法使用').slice(0,300)};
}

// Only project names are reported, never the paths themselves — this endpoint is
// readable by every signed-in member, not just administrators.
export function projectsCheck(store,{exists=existsSync}={}){
  const projects=store.db.prepare('SELECT id,name,path FROM projects').all();
  if(!projects.length)return {status:'warning',message:'尚未建立任何專案'};
  const missing=projects.filter(p=>!exists(p.path));
  if(!missing.length)return {status:'ok',message:`${projects.length} 個專案路徑正常`};
  return {status:'warning',message:`${missing.length} 個專案路徑不存在：${missing.map(p=>p.name).join('、')}`};
}

// Reuses the same integration state /api/state already reports; health never opens a
// connection of its own to LINE.
export function lineCheck(store,{env=process.env}={}){
  if(!(env.INBOX_URL&&env.INBOX_TOKEN))return {status:'unknown',message:'尚未設定 LINE 連線（INBOX_URL／INBOX_TOKEN）'};
  const error=store.setting('inboxError');
  if(error)return {status:'warning',message:`LINE 同步異常：${String(error).slice(0,200)}`};
  const lastSync=store.setting('inboxLastSuccess');
  if(!lastSync)return {status:'unknown',message:'已設定 LINE，但尚未完成第一次同步'};
  return {status:'ok',message:`已連線（最後同步 ${lastSync}）`};
}

export async function systemHealth(store,{env=process.env,execFileImpl,timeoutMs,browserCapability=checkClaudeBrowserCapability,exists=existsSync,clock=Date.now,nodeVersion=process.versions.node}={}){
  const [codex,claude,browser]=await Promise.all([
    probeCliVersion('codex',{env,execFileImpl,timeoutMs}),
    probeCliVersion('claude',{env,execFileImpl,timeoutMs}),
    (async()=>browserCapability({env}))().catch(error=>({available:false,provider:null,error:String(error.message||error)}))
  ]);
  const checks={
    runtime:runtimeCheck({version:nodeVersion}),
    runner:runnerCheck(store),
    codex:engineCheck('codex',codex,'Codex CLI'),
    claude:engineCheck('claude',claude,'Claude CLI'),
    browser:browserCheck(browser),
    projects:projectsCheck(store,{exists}),
    line:lineCheck(store,{env})
  };
  return {status:aggregateStatus(checks),checkedAt:new Date(clock()).toISOString(),checks};
}

// A health check spawns CLI processes, so callers must never be able to turn polling
// into a process storm: results are cached, a manual re-check still cannot run more
// often than minIntervalMs, and concurrent callers share one in-flight run.
export function createSystemHealth(store,options={}){
  const ttlMs=options.ttlMs??15000,minIntervalMs=options.minIntervalMs??3000,clock=options.clock||Date.now;
  let cached=null,inflight=null;
  return {
    async get({force=false}={}){
      const age=cached?clock()-cached.at:Infinity;
      if(age<(force?minIntervalMs:ttlMs))return cached.value;
      if(inflight)return inflight;
      inflight=systemHealth(store,options).then(value=>{cached={at:clock(),value};return value;});
      try{return await inflight;}finally{inflight=null;}
    },
    reset(){cached=null;}
  };
}
