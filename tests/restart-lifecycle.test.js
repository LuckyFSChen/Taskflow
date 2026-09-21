// Restart／啟動腳本的 Port Ownership 保證。
//
// 兩件事必須守住，而且必須守在腳本裡，不是守在說明文件裡：
//   1. 啟動主服務之前先清掉繼承來的 runtime port 變數（這是事故的傳播路徑）。
//   2. 啟動失敗時，把「本輪啟動的那一個 PID」停掉——不是殺掉所有 node.exe，
//      也不是放著不管讓每次失敗都多留一個 server/index.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const root=resolve('.');
const read=name=>readFileSync(join(root,name),'utf8');

test('每一支會啟動主服務的腳本都先清掉繼承來的 runtime port',()=>{
  for(const script of ['Restart-TaskFlow.ps1','Start-TaskFlow.ps1','Open-TaskFlow.ps1','Start-Service-Guardian.ps1','scripts/Recover-TaskFlow.ps1']) {
    const text=read(script);
    assert.match(text,/TaskFlow-Ports\.ps1/,`${script} 必須沿用同一份 port 定義`);
    assert.match(text,/Reset-TaskFlowPortEnvironment/,`${script} 必須先清掉 runtime port 變數`);
  }
});

test('Restart 固定驗 4310，而且綁到別的 port 就直接失敗',()=>{
  const text=read('Restart-TaskFlow.ps1');
  assert.match(text,/\$taskUrl = "http:\/\/127\.0\.0\.1:\$TaskFlowMainPort"/);
  assert.match(text,/TaskFlow main server started on an unexpected port/);
  assert.match(text,/Get-TaskFlowLoggedPort/);
  // 健康檢查通過還不夠：4310 必須由本輪啟動的那一個程序持有。
  assert.match(text,/\$owner\.OwningProcess -eq \$server\.Id/);
  assert.match(text,/data\\server\.pid \(\$savedPid\) does not match/);
});

test('Restart 失敗時只停本輪啟動的 PID，絕不殺掉所有 node.exe',()=>{
  const text=read('Restart-TaskFlow.ps1');
  assert.match(text,/Stop-TaskFlowProcessById -ProcessId \$startedServer\.Id/);
  assert.doesNotMatch(text,/Stop-Process\s+-Name\s+node/i);
  assert.doesNotMatch(text,/taskkill[^\n]*\/IM/i);
  assert.doesNotMatch(text,/Get-Process\s+node[^\n]*\|\s*Stop-Process/i);
});

test('Restart 不去追隨機 port，也沒有從 server.log 解析出 port 就將就用',()=>{
  const text=read('Restart-TaskFlow.ps1');
  // server.log 只用來判斷「是不是綁錯 port」，不是用來決定健康檢查要打哪裡。
  const healthChecks=[...text.matchAll(/Invoke-RestMethod[\s\S]{0,120}?api\/health/g)];
  assert.ok(healthChecks.length>0);
  for(const match of healthChecks) assert.match(match[0],/\$taskUrl/);
});

test('「有幾個主服務」必須用陣列問，PowerShell 會把單一元素的回傳值拆開',()=>{
  // 實際踩過：`return @(...)` 只有一個元素時會被拆成單一物件，呼叫端的 .Count 變成
  // $null，於是「剛好一個主服務」被判成失敗，剛啟動好的服務又被清理掉。
  const helper=read('scripts/TaskFlow-Ports.ps1');
  assert.match(helper,/return ,\$found/,'Get-TaskFlowServerProcess 必須用 ,$found 保住陣列');
  const restart=read('Restart-TaskFlow.ps1');
  const assignments=[...restart.matchAll(/\$\w+ = [^\n]*Get-TaskFlowServerProcess[^\n]*/g)];
  assert.ok(assignments.length>0);
  for(const match of assignments) assert.match(match[0],/@\(Get-TaskFlowServerProcess/,'呼叫端也要用 @() 固定成陣列');
});

// 共用函式的實際行為。沒有 PowerShell 的環境（例如 Linux CI）直接跳過。
function powershell() {
  for(const candidate of process.platform==='win32'?['powershell.exe','pwsh']:['pwsh']) {
    try { execFileSync(candidate,['-NoProfile','-Command','exit 0'],{stdio:'ignore'}); return candidate; }
    catch { /* 換下一個 */ }
  }
  return null;
}

test('TaskFlow-Ports.ps1 認得出綁錯 port、認得出自己的主服務、清得掉 runtime 變數',t=>{
  const shell=powershell();
  if(!shell) { t.skip('這個環境沒有 PowerShell'); return; }

  const directory=mkdtempSync(join(tmpdir(),'taskflow-ports-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'wrong.log'),'TaskFlow: http://127.0.0.1:60215\n');
  writeFileSync(join(directory,'good.log'),'noise\nTaskFlow: http://127.0.0.1:4310\n');

  const script=join(directory,'probe.ps1');
  const resultFile=join(directory,'result.json');
  writeFileSync(script,[
    "param([string]$Root,[string]$Directory,[string]$ResultFile)",
    "$ErrorActionPreference='Stop'",
    ". (Join-Path $Root 'scripts/TaskFlow-Ports.ps1')",
    "$env:PORT='60215';$env:PREVIEW_PORT='60216';$env:TASKFLOW_SERVICE_API_PORT='60217'",
    "Reset-TaskFlowPortEnvironment",
    "$result=@{",
    "  mainPort=$TaskFlowMainPort",
    "  guardianPort=$TaskFlowGuardianPort",
    "  wrongLogPort=(Get-TaskFlowLoggedPort -LogPath (Join-Path $Directory 'wrong.log'))",
    "  goodLogPort=(Get-TaskFlowLoggedPort -LogPath (Join-Path $Directory 'good.log'))",
    "  missingLogPort=(Get-TaskFlowLoggedPort -LogPath (Join-Path $Directory 'missing.log'))",
    "  mainMatches=(Test-TaskFlowCommandLine -CommandLine 'node \"F:\\TaskFlow\\server\\index.js\"' -ExpectedPath 'F:\\TaskFlow\\server\\index.js')",
    "  worktreeMatches=(Test-TaskFlowCommandLine -CommandLine 'node F:\\TaskFlow\\data\\worktrees\\t1\\server\\index.js' -ExpectedPath 'F:\\TaskFlow\\server\\index.js')",
    "  inheritedPort=[string]$env:PORT",
    "  inheritedPreviewPort=[string]$env:PREVIEW_PORT",
    "  inheritedServicePort=[string]$env:TASKFLOW_SERVICE_API_PORT",
    "  pinnedPort=[string]$env:TASKFLOW_PORT",
    "  pinnedGuardianPort=[string]$env:TASKFLOW_GUARDIAN_PORT",
    "}",
    "$result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8",
  ].join('\r\n'),'utf8');

  execFileSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Root',root,'-Directory',directory,'-ResultFile',resultFile],{stdio:'ignore'});
  const result=JSON.parse(readFileSync(resultFile,'utf8').replace(/^\uFEFF/,''));

  assert.equal(result.mainPort,4310);
  assert.equal(result.guardianPort,4311);
  assert.equal(result.wrongLogPort,60215,'綁到 60215 必須看得出來');
  assert.equal(result.goodLogPort,4310);
  assert.equal(result.missingLogPort,null);
  assert.equal(result.mainMatches,true);
  assert.equal(result.worktreeMatches,false,'worktree runtime 不是主服務，不可以被當成主服務停掉');
  assert.equal(result.inheritedPort,'');
  assert.equal(result.inheritedPreviewPort,'');
  assert.equal(result.inheritedServicePort,'');
  assert.equal(result.pinnedPort,'4310');
  assert.equal(result.pinnedGuardianPort,'4311');
});
