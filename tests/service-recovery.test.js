import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {runServiceRecovery} from '../server/service-recovery.js';

test('Recovery reads a durable result on process exit without inherited output pipes',async()=>{
 let file;
 const result=await runServiceRecovery({spawnProcess:(command,args,options)=>{
  assert.equal(command,'powershell.exe');assert.ok(args.includes('-Restart'));assert.deepEqual(options.stdio.slice(0,2),['ignore','ignore']);assert.equal(typeof options.stdio[2],'number');assert.equal(options.windowsHide,true);
  file=args.at(-1);
  return spawn(process.execPath,['--input-type=module','-e','import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],JSON.stringify({ok:true,url:"https://ready.example.com"}));',file],options);
 }});
 assert.equal(result.url,'https://ready.example.com');assert.equal(existsSync(file),false);
});

test('Recovery preserves errors raised before a result file can be written',async()=>{
 let file;
 await assert.rejects(runServiceRecovery({spawnProcess:(command,args,options)=>{
  file=args.at(-1);
  return spawn(process.execPath,['-e','console.error("ParserError: Unexpected token");process.exitCode=1'],options);
 }}),error=>/code 1/.test(error.message)&&/ParserError: Unexpected token/.test(error.stderr));
 assert.equal(existsSync(file),false);
});

test('Recovery scripts retain UTF-8 BOM for Windows PowerShell decoding',()=>{
 for(const script of ['scripts/Recover-TaskFlow.ps1','scripts/TaskFlow-Ports.ps1']){
  assert.deepEqual([...readFileSync(script).subarray(0,3)],[0xef,0xbb,0xbf],script);
 }
});

test('Windows PowerShell parses the recovery scripts without executing a restart',{skip:process.platform!=='win32'},()=>{
 execFileSync('powershell.exe',['-NoProfile','-Command',
  "$ErrorActionPreference='Stop'; foreach($script in @('scripts/Recover-TaskFlow.ps1','scripts/TaskFlow-Ports.ps1')) { $tokens=$null; $parseErrors=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $script),[ref]$tokens,[ref]$parseErrors); if($parseErrors.Count) { throw ($parseErrors | Out-String) } }"
 ],{windowsHide:true});
});

test('Read-only recovery selects CheckOnly and preserves active-work error for LINE',async()=>{
 await assert.rejects(runServiceRecovery({checkOnly:true,spawnProcess:(command,args,options)=>{
  assert.ok(args.includes('-CheckOnly'));assert.ok(!args.includes('-Restart'));
  return spawn(process.execPath,['--input-type=module','-e','import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],JSON.stringify({ok:false,error:"Active AI work found; service restart postponed."}));process.exitCode=1;',args.at(-1)],options);
 }}),error=>/Active AI work found/.test(error.stderr));
});

// 部署重啟（網頁核准）與 LINE 的「重啟服務」走同一支腳本，差別只在要不要先建置：
// 合併進 main 的原始碼不會自己變成 dist/，不重建的話重啟完網頁還是舊的。
test('Deployment restart asks the script to build first; plain recovery never does',async()=>{
 const capture=[];
 const fakeRecovery=args=>spawn(process.execPath,['--input-type=module','-e','import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],JSON.stringify({ok:true,url:"https://ready.example.com"}));',args.at(-1)],{stdio:'ignore'});

 await runServiceRecovery({build:true,spawnProcess:(command,args)=>{capture.push(args);return fakeRecovery(args);}});
 const withBuild=capture[0];
 assert.ok(withBuild.includes('-Build'));
 assert.ok(withBuild.includes('-Restart'));
 // 結果檔案一定是最後一個參數；-Build 不可以擠掉它
 assert.equal(withBuild.at(-2),'-ResultFile');

 await runServiceRecovery({spawnProcess:(command,args)=>{capture.push(args);return fakeRecovery(args);}});
 assert.equal(capture[1].includes('-Build'),false);
});
