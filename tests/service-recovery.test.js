import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {runServiceRecovery} from '../server/service-recovery.js';

test('Recovery reads a durable result on process exit without inherited output pipes',async()=>{
 let file;
 const result=await runServiceRecovery({spawnProcess:(command,args,options)=>{
  assert.equal(command,'powershell.exe');assert.ok(args.includes('-Restart'));assert.equal(options.stdio,'ignore');assert.equal(options.windowsHide,true);
  file=args.at(-1);
  return spawn(process.execPath,['--input-type=module','-e','import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],JSON.stringify({ok:true,url:"https://ready.example.com"}));',file],options);
 }});
 assert.equal(result.url,'https://ready.example.com');assert.equal(existsSync(file),false);
});

test('Read-only recovery selects CheckOnly and preserves active-work error for LINE',async()=>{
 await assert.rejects(runServiceRecovery({checkOnly:true,spawnProcess:(command,args,options)=>{
  assert.ok(args.includes('-CheckOnly'));assert.ok(!args.includes('-Restart'));
  return spawn(process.execPath,['--input-type=module','-e','import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],JSON.stringify({ok:false,error:"Active AI work found; service restart postponed."}));process.exitCode=1;',args.at(-1)],options);
 }}),error=>/Active AI work found/.test(error.stderr));
});
