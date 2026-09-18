import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {systemHealth,createSystemHealth,aggregateStatus,probeCliVersion,runnerCheck,projectsCheck,lineCheck,browserCheck,HEALTH_STATUSES} from '../server/system-health.js';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'tf-health-'));
  const store=createStore(join(dir,'health.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store};
}
function addProject(store,name,path){store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(id(),name,name,path);}
// Records every spawn so the read-only guarantee can be asserted, not assumed.
function cliStub(results){
  const calls=[];
  const execFileImpl=(file,args,options,callback)=>{calls.push({file,args,options});const outcome=results[file]??results.default;outcome instanceof Error?callback(outcome):callback(null,outcome,'');};
  return {calls,execFileImpl};
}
const browserOk=async()=>({available:true,provider:'playwright-mcp',cli:'claude',error:null});
const browserDown=async()=>({available:false,provider:null,cli:'claude',error:'尚未安裝 @playwright/mcp'});

function healthOptions({store,dir,cli,browserCapability=browserOk,env={}}){
  return {env:{CODEX_BIN:'codex-bin',CLAUDE_BIN:'claude-bin',...env},execFileImpl:cli.execFileImpl,browserCapability};
}

test('CLI available: both engines report ok and a fully healthy system aggregates to ok',async t=>{
  const {store,dir}=fixture(t);
  const workspace=join(dir,'project');mkdirSync(workspace);
  store.setSetting('runnerEnabled',true);
  store.setSetting('inboxLastSuccess','2026-01-01T00:00:00.000Z');
  addProject(store,'demo',workspace);
  const cli=cliStub({'codex-bin':'codex 1.2.3\n','claude-bin':'claude 2.0.0\n'});
  const report=await systemHealth(store,healthOptions({store,dir,cli,env:{INBOX_URL:'https://inbox.example.com',INBOX_TOKEN:'t'}}));
  assert.equal(report.checks.codex.status,'ok');
  assert.match(report.checks.codex.message,/Codex CLI 可使用/);
  assert.match(report.checks.codex.message,/codex 1\.2\.3/);
  assert.equal(report.checks.claude.status,'ok');
  assert.equal(report.checks.runner.message,'任務服務已啟用');
  assert.equal(report.status,'ok');
  assert.deepEqual(Object.keys(report.checks),['runner','codex','claude','browser','projects','line']);
  for(const check of Object.values(report.checks))assert.ok(HEALTH_STATUSES.includes(check.status));
  assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
});

test('CLI unavailable: the engine reports error, names the override variable, and drives the overall status to error',async t=>{
  const {store,dir}=fixture(t);
  const workspace=join(dir,'project');mkdirSync(workspace);
  store.setSetting('runnerEnabled',true);
  addProject(store,'demo',workspace);
  const cli=cliStub({'codex-bin':'codex 1.2.3\n','claude-bin':new Error('spawn claude-bin ENOENT')});
  const report=await systemHealth(store,healthOptions({store,dir,cli}));
  assert.equal(report.checks.codex.status,'ok');
  assert.equal(report.checks.claude.status,'error');
  assert.match(report.checks.claude.message,/Claude CLI 無法執行/);
  assert.match(report.checks.claude.message,/CLAUDE_BIN/);
  // One engine down must not be reported as the whole platform being down-but-fine:
  // the aggregate is error, while codex stays usable so the UI can still allow work.
  assert.equal(report.status,'error');
});

test('a CLI that cannot be spawned at all is reported, never thrown',async t=>{
  const {store}=fixture(t);
  const probe=await probeCliVersion('codex',{env:{CODEX_BIN:'codex-bin'},execFileImpl:()=>{throw new Error('EACCES');}});
  assert.deepEqual({available:probe.available,executable:probe.executable},{available:false,executable:'codex-bin'});
  assert.match(probe.error,/EACCES/);
  assert.ok(store);
});

test('Runner disabled is a warning, not an error, and the overall status follows',async t=>{
  const {store,dir}=fixture(t);
  const workspace=join(dir,'project');mkdirSync(workspace);
  addProject(store,'demo',workspace);
  assert.deepEqual(runnerCheck(store),{status:'warning',message:'任務服務未啟用，佇列中的任務不會自動執行'});
  const cli=cliStub({default:'v1\n'});
  const report=await systemHealth(store,healthOptions({store,dir,cli}));
  assert.equal(report.checks.runner.status,'warning');
  assert.equal(report.status,'warning');
});

test('Project missing is a warning naming the project, and reveals no filesystem path',async t=>{
  const {store,dir}=fixture(t);
  const present=join(dir,'present');mkdirSync(present);
  const absent=join(dir,'gone');
  addProject(store,'在的專案',present);
  addProject(store,'消失的專案',absent);
  const check=projectsCheck(store);
  assert.equal(check.status,'warning');
  assert.equal(check.message,'1 個專案路徑不存在：消失的專案');
  assert.ok(!check.message.includes(absent));
  assert.deepEqual(projectsCheck(store,{exists:()=>true}),{status:'ok',message:'2 個專案路徑正常'});
});

test('no projects at all is a warning rather than a silent ok',async t=>{
  const {store}=fixture(t);
  assert.deepEqual(projectsCheck(store),{status:'warning',message:'尚未建立任何專案'});
});

test('Browser unavailable is a warning carrying the capability error, and a thrown probe never breaks the report',async t=>{
  const {store,dir}=fixture(t);
  const workspace=join(dir,'project');mkdirSync(workspace);
  store.setSetting('runnerEnabled',true);
  addProject(store,'demo',workspace);
  const cli=cliStub({default:'v1\n'});
  const report=await systemHealth(store,healthOptions({store,dir,cli,browserCapability:browserDown}));
  assert.equal(report.checks.browser.status,'warning');
  assert.match(report.checks.browser.message,/@playwright\/mcp/);
  assert.equal(report.status,'warning');
  const thrown=await systemHealth(store,healthOptions({store,dir,cli,browserCapability:async()=>{throw new Error('probe crashed');}}));
  assert.equal(thrown.checks.browser.status,'warning');
  assert.match(thrown.checks.browser.message,/probe crashed/);
});

test('LINE state is read from existing integration settings only',async t=>{
  const {store}=fixture(t);
  assert.equal(lineCheck(store,{env:{}}).status,'unknown');
  const configured={INBOX_URL:'https://inbox.example.com',INBOX_TOKEN:'t'};
  assert.equal(lineCheck(store,{env:configured}).status,'unknown');
  store.setSetting('inboxLastSuccess','2026-01-01T00:00:00.000Z');
  assert.equal(lineCheck(store,{env:configured}).status,'ok');
  store.setSetting('inboxError','網路連線失敗');
  const failing=lineCheck(store,{env:configured});
  assert.equal(failing.status,'warning');
  assert.match(failing.message,/網路連線失敗/);
});

test('aggregate status takes the worst check: error beats warning beats unknown beats ok',()=>{
  assert.equal(aggregateStatus({a:{status:'ok'},b:{status:'ok'}}),'ok');
  assert.equal(aggregateStatus({a:{status:'ok'},b:{status:'unknown'}}),'unknown');
  assert.equal(aggregateStatus({a:{status:'unknown'},b:{status:'warning'}}),'warning');
  assert.equal(aggregateStatus({a:{status:'warning'},b:{status:'error'}}),'error');
  // An unrecognised status is never optimistically treated as ok.
  assert.equal(aggregateStatus({a:{status:'ok'},b:{status:'bogus'}}),'unknown');
  assert.equal(aggregateStatus({}),'ok');
  assert.equal(browserCheck({available:true,provider:'playwright-mcp'}).status,'ok');
});

test('the check is read-only: it only ever runs --version, and changes no stored state',async t=>{
  const {store,dir}=fixture(t);
  const workspace=join(dir,'project');mkdirSync(workspace);
  store.setSetting('runnerEnabled',true);
  addProject(store,'demo',workspace);
  const before=store.db.prepare('SELECT key,value FROM settings ORDER BY key').all();
  const cli=cliStub({default:'v1\n'});
  await systemHealth(store,healthOptions({store,dir,cli}));
  assert.equal(cli.calls.length,2);
  for(const call of cli.calls){
    assert.deepEqual(call.args,['--version']);
    assert.ok(call.options.timeout>0,'every CLI probe must be bounded by a timeout');
    // No shell: nothing in the resolved executable path can be interpreted as a command.
    assert.equal(call.options.shell,undefined);
  }
  assert.deepEqual(store.db.prepare('SELECT key,value FROM settings ORDER BY key').all(),before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
});

test('repeated polling reuses the cached report; a manual re-check cannot spawn continuously',async t=>{
  const {store,dir}=fixture(t);
  addProject(store,'demo',dir);
  let at=1_000_000;
  const cli=cliStub({default:'v1\n'});
  const health=createSystemHealth(store,{...healthOptions({store,dir,cli}),ttlMs:15000,minIntervalMs:3000,clock:()=>at});
  await health.get();
  assert.equal(cli.calls.length,2);
  at+=1000;await health.get();
  assert.equal(cli.calls.length,2,'a poll inside the TTL must not spawn a CLI again');
  // Manual 重新檢查 within the minimum interval is served from cache.
  await health.get({force:true});
  assert.equal(cli.calls.length,2);
  at+=2000;await health.get({force:true});
  assert.equal(cli.calls.length,4,'a manual re-check after the minimum interval runs the checks again');
  at+=20000;await health.get();
  assert.equal(cli.calls.length,6,'an expired cache is refreshed on the next read');
});

test('concurrent callers share one run instead of spawning one set of CLI probes each',async t=>{
  const {store,dir}=fixture(t);
  addProject(store,'demo',dir);
  const calls=[];
  const execFileImpl=(file,args,options,callback)=>{calls.push(file);setTimeout(()=>callback(null,'v1\n',''),5);};
  const health=createSystemHealth(store,{env:{CODEX_BIN:'codex-bin',CLAUDE_BIN:'claude-bin'},execFileImpl,browserCapability:browserOk});
  const [a,b,c]=await Promise.all([health.get(),health.get(),health.get()]);
  assert.equal(calls.length,2);
  assert.equal(a,b);assert.equal(b,c);
});
