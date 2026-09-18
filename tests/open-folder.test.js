import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openFolder} from '../server/project-preview.js';
test('Open folder launches visible Explorer with literal paths and reports launch failures',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'TaskFlow 中文 & folder '));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let unref=false;
 await openFolder(dir,{launch:(exe,args,options)=>{assert.match(exe,/explorer\.exe$/);assert.deepEqual(args,['/n,',realpathSync(dir)]);assert.equal(options.windowsHide,false);assert.equal(options.shell,false);const child=new EventEmitter();child.unref=()=>{unref=true;};queueMicrotask(()=>child.emit('spawn'));return child;}});assert.equal(unref,true);
 await assert.rejects(openFolder(dir,{launch:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('launch failed')));return child;}}),/launch failed/);
 const file=join(dir,'file.txt');writeFileSync(file,'fixture');assert.throws(()=>openFolder(file),/不存在/);
});
