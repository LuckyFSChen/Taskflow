import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveCliExecutable} from '../server/cli-executable.js';

test('respects explicit binary configuration and non-Windows command lookup',()=>{
  assert.equal(resolveCliExecutable('codex',{env:{CODEX_BIN:'custom-codex'},platform:'win32'}),'custom-codex');
  assert.equal(resolveCliExecutable('codex',{env:{},platform:'linux'}),'codex');
});
test('finds desktop Codex with missing background PATH and prefers PATH when present',()=>{
  const root=mkdtempSync(join(tmpdir(),'taskflow-cli-'));
  try{
    const bin=join(root,'OpenAI','Codex','bin');
    const old=join(bin,'old','codex.exe'),latest=join(bin,'latest','codex.exe');
    for(const [name,file] of [['old',old],['latest',latest]]){mkdirSync(join(bin,name),{recursive:true});writeFileSync(file,'fixture');}
    utimesSync(old,1000,1000);utimesSync(latest,2000,2000);
    assert.equal(resolveCliExecutable('codex',{env:{LOCALAPPDATA:root},platform:'win32'}),latest);
    assert.equal(resolveCliExecutable('codex',{env:{LOCALAPPDATA:root,Path:join(bin,'old')},platform:'win32'}),old);
    assert.equal(resolveCliExecutable('codex',{env:{},platform:'win32'}),'codex');
  }finally{rmSync(root,{recursive:true,force:true});}
});
