// TaskFlow-owned Browser MCP integration: capability detection, an inline
// (project-scoped, single-purpose) MCP server definition for Playwright, and
// evidence parsing for Claude Code's stream-json tool_use events. This file
// never touches the user's own `claude mcp add` configuration — the MCP
// server is always passed inline via --mcp-config/--strict-mcp-config so a
// TaskFlow-spawned Claude process exposes exactly one MCP server (Playwright)
// and nothing else the user may have configured personally.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {resolveCliExecutable} from './cli-executable.js';

const require_=createRequire(import.meta.url);

// Frontend/UI keywords (bilingual) used to decide whether a web-project task
// actually touches something a browser can prove, vs. a backend-only change
// inside the same repository.
const UI_KEYWORDS=/\b(vue|react|component|html|css|javascript|typescript ui|ui\b|button|modal|dialog|form|navigation|route|routing|frontend|front-end|responsive|login page|dashboard|table|drag|drop|dropdown|menu|sidebar|layout|render|dom\b|click|screen|page)\b|前端|介面|使用者介面|按鈕|彈窗|對話框|表單|導覽|導航|路由|頁面|畫面|元件|組件|互動|下拉|選單|側邊欄|版面|渲染|點擊|登入畫面|儀表板|拖曳|響應式/i;

export function deriveBrowserValidationRequirement({webKind,title='',description='',plan=null}={}){
  if(!webKind)return {required:false,reason:'非網頁專案，不需要 Browser 驗證。'};
  const text=[title,description,JSON.stringify(plan||{})].join('\n');
  if(UI_KEYWORDS.test(text))return {required:true,reason:'網頁專案且需求涉及前端／UI／互動，需實際 Browser 驗證。'};
  return {required:false,reason:'網頁專案但需求未涉及前端 UI／互動，預設不需要 Browser 驗證。'};
}

export function resolvePlaywrightMcpEntry(){
  // The package's exports map only exposes "." and "./package.json", not "./cli.js" — resolve
  // the package root via package.json (which module resolution allows) and derive the CLI path
  // directly on disk rather than going through exports enforcement for a subpath it hides.
  try{const pkgPath=require_.resolve('@playwright/mcp/package.json');const cliPath=join(dirname(pkgPath),'cli.js');return existsSync(cliPath)?cliPath:null;}catch{return null;}
}

export function resolveBrowserExecutable({env=process.env}={}){
  if(env.TASKFLOW_BROWSER_EXECUTABLE&&existsSync(env.TASKFLOW_BROWSER_EXECUTABLE))return env.TASKFLOW_BROWSER_EXECUTABLE;
  if(env.PLAYWRIGHT_BROWSERS_PATH){const candidate=join(env.PLAYWRIGHT_BROWSERS_PATH,'chromium');if(existsSync(candidate))return candidate;}
  return null;
}

// The curated, minimal set of Playwright MCP tools TaskFlow allows without a
// prompt. Categorised (not a single hardcoded tool name) so future Playwright
// MCP releases that rename or add tools degrade gracefully — see
// categorizeBrowserTool below, which drives evidence collection by category
// rather than by exact tool name.
export function browserAllowedTools(){
  return ['browser_navigate','browser_navigate_back','browser_click','browser_type','browser_fill_form','browser_select_option','browser_press_key','browser_hover','browser_wait_for','browser_snapshot','browser_console_messages','browser_network_requests','browser_take_screenshot','browser_evaluate','browser_resize','browser_tabs','browser_handle_dialog','browser_close'].map(name=>`mcp__playwright__${name}`);
}

export function browserMcpServerSpec({previewUrl,outputDir,noSandbox=process.platform!=='win32'&&typeof process.getuid==='function'&&process.getuid()===0,entry=resolvePlaywrightMcpEntry(),executable=resolveBrowserExecutable()}={}){
  if(!entry)return null;
  const args=[entry,'--headless','--isolated'];
  if(noSandbox)args.push('--no-sandbox');
  if(executable)args.push('--executable-path',executable);
  if(outputDir)args.push('--output-dir',outputDir);
  // Restrict the browser to the TaskFlow preview origin only — never a general internet agent.
  if(previewUrl){try{args.push('--allowed-origins',new URL(previewUrl).origin);}catch{/* invalid preview URL: no origin restriction possible, caller already validated */}}
  return {command:process.execPath,args};
}

export function browserMcpConfig(spec){
  return {mcpServers:{playwright:{command:spec.command,args:spec.args}}};
}

export function isBrowserToolName(name){
  return typeof name==='string'&&name.startsWith('mcp__playwright__');
}

export function categorizeBrowserTool(name){
  const suffix=String(name||'').replace('mcp__playwright__browser_','');
  if(/navigate|tabs|close|resize/.test(suffix))return 'navigate';
  if(/click|type|fill|select|press|hover|drag|wait_for|handle_dialog/.test(suffix))return 'interact';
  if(/console/.test(suffix))return 'console';
  if(/network/.test(suffix))return 'network';
  if(/screenshot|snapshot/.test(suffix))return 'inspect';
  return 'other';
}

export function defaultBrowserValidation(){
  return {required:false,status:'not_required',executed:false,passed:null,toolUsed:false,toolCallCount:0,url:null,checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null};
}

// The deterministic guard described in the spec: what the AI *claims* in its
// structured output never overrides what the stream-json transcript actually
// shows. If TaskFlow did not observe a real mcp__playwright__* tool_use event,
// the result is forced to blocked/failed regardless of the AI's narration.
export function reconcileBrowserValidation(claimed,evidence,requirement){
  if(!requirement?.required)return defaultBrowserValidation();
  const base=claimed&&typeof claimed==='object'?{...claimed}:defaultBrowserValidation();
  const toolCallCount=evidence?.toolCallCount||0,toolUsed=toolCallCount>0;
  const merged={...base,required:true,toolUsed,toolCallCount,url:base.url||requirement.previewUrl||null};
  if(!toolUsed)return {...merged,executed:false,passed:false,status:'blocked',error:merged.error||'未偵測到 Browser MCP 工具呼叫（如 mcp__playwright__browser_navigate），不能證明已實際使用瀏覽器驗證。'};
  if(!merged.executed)return {...merged,passed:false,status:merged.status==='blocked'?'blocked':'failed'};
  return {...merged,status:merged.passed?'passed':(merged.status==='blocked'?'blocked':'failed')};
}

function probeMcpServer(spec,{timeoutMs=8000,spawnProcess=spawn}={}){
  return new Promise(resolve=>{
    let settled=false,buf='',stderr='';
    let child;
    try{child=spawnProcess(spec.command,spec.args,{stdio:['pipe','pipe','pipe']});}
    catch(e){resolve({ok:false,error:`無法啟動 Browser MCP：${e.message}`});return;}
    const done=value=>{if(settled)return;settled=true;clearTimeout(timer);try{child.kill();}catch{}resolve(value);};
    const timer=setTimeout(()=>done({ok:false,error:'Browser MCP 伺服器逾時未回應初始化請求'}),timeoutMs);
    child.stdout?.on('data',chunk=>{
      buf+=chunk.toString();const lines=buf.split('\n');buf=lines.pop()||'';
      for(const line of lines){
        if(!line.trim())continue;
        try{const msg=JSON.parse(line);if(msg.id===1)return done(msg.result?{ok:true,serverInfo:msg.result.serverInfo||null}:{ok:false,error:'Browser MCP 初始化回應格式錯誤'});}catch{/* ignore non-JSON-RPC noise on stdout */}
      }
    });
    child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-2000);});
    child.on('error',e=>done({ok:false,error:`無法啟動 Browser MCP：${e.message}`}));
    child.on('close',code=>done({ok:false,error:stderr||`Browser MCP 已結束（結束碼 ${code}）`}));
    child.stdin.on('error',()=>{});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'taskflow-preflight',version:'1'}}})+'\n');
  });
}

let cached=null;
export async function checkClaudeBrowserCapability({env=process.env,execFileImpl,spawnProcess,cache=true,cliExecutable=resolveCliExecutable('claude',{env})}={}){
  if(cache&&cached&&Date.now()-cached.at<60000)return cached.value;
  const value=await computeCapability({env,execFileImpl,spawnProcess,cliExecutable});
  cached={at:Date.now(),value};
  return value;
}

async function computeCapability({env,execFileImpl,spawnProcess,cliExecutable}){
  const {execFile}=await import('node:child_process');
  const run=execFileImpl||execFile;
  const cliOk=await new Promise(resolve=>{
    try{run(cliExecutable,['--version'],{timeout:10000},(error)=>resolve(!error));}
    catch{resolve(false);}
  });
  if(!cliOk)return {available:false,provider:null,cli:cliExecutable,error:'找不到可執行的 Claude Code CLI（claude --version 失敗）。'};
  const entry=resolvePlaywrightMcpEntry();
  if(!entry)return {available:false,provider:null,cli:cliExecutable,error:'尚未安裝 @playwright/mcp；請先執行安裝步驟（見 docs/BROWSER-VALIDATION.md）。'};
  const spec=browserMcpServerSpec({entry});
  const probe=await probeMcpServer(spec,{spawnProcess});
  if(!probe.ok)return {available:false,provider:null,cli:cliExecutable,error:probe.error||'Playwright MCP unavailable'};
  return {available:true,provider:'playwright-mcp',cli:cliExecutable,error:null,serverInfo:probe.serverInfo};
}

export function resetBrowserCapabilityCache(){cached=null;}
