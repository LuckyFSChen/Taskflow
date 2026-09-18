import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {processLine} from '../server/line.js';
import {projectName} from '../server/line-projects.js';
import {validMessages} from '../cloud-inbox/line-menu.js';

test('LINE creates a named folder and project only after confirmation; replay, expiry and root changes cannot duplicate it',t=>{
  const root=mkdtempSync(join(tmpdir(),'tf-line-project-')),s=createStore(join(root,'db.sqlite'));
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
  const u=s.addUser('Admin','admin','fixture-password','admin'),lineId='U'+'b'.repeat(32);
  s.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,u.id);
  const send=(value,postback=true,eventId=id())=>processLine(s,{webhookEventId:eventId,type:postback?'postback':'message',source:{type:'user',userId:lineId},...(postback?{postback:{data:value}}:{message:{type:'text',text:value}})});
  const last=()=>JSON.parse(s.db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').get().payload)[0];
  const flow=()=>JSON.parse(s.db.prepare('SELECT data FROM line_flows WHERE user_id=?').get(u.id).data);
  send('tf:create-project');assert.match(last().text,/預設專案存放位置/);
  const base=join(root,'projects');mkdirSync(base);s.setSetting('defaultProjectRoot',base);
  send('tf:create-project');send('我的網站',false);const nonce=flow().id;
  assert.equal(existsSync(join(base,'我的網站')),false);
  const eventId=id();send(`tf:confirm-project:${nonce}`,true,eventId);send(`tf:confirm-project:${nonce}`,true,eventId);send(`tf:confirm-project:${nonce}`);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM projects').get().n,1);assert.equal(existsSync(join(base,'我的網站')),true);
  assert.match(last().text,/失效/);
  send('tf:create-project');send('我的網站',false);assert.match(last().text,/同名/);
  mkdirSync(join(base,'existing'));writeFileSync(join(base,'existing','keep.txt'),'preserved');send('existing',false);assert.match(last().text,/同名/);assert.equal(readFileSync(join(base,'existing','keep.txt'),'utf8'),'preserved');
  send('新位置',false);const changed=flow().id;const other=join(root,'other');mkdirSync(other);s.setSetting('defaultProjectRoot',other);send(`tf:confirm-project:${changed}`);assert.match(last().text,/位置已變更/);assert.equal(existsSync(join(other,'新位置')),false);
  send('tf:create-project');send('過期專案',false);const expired=flow().id;s.db.prepare('UPDATE line_flows SET expires=0').run();send(`tf:confirm-project:${expired}`);assert.match(last().text,/失效/);
  send('tf:create-project');send('取消專案',false);send('tf:cancel');assert.equal(existsSync(join(other,'取消專案')),false);
  s.db.prepare('UPDATE users SET role=? WHERE id=?').run('member',u.id);send('tf:create-project');assert.match(last().text,/管理者/);
  for(const row of s.db.prepare('SELECT payload FROM outbox').all())assert.equal(validMessages(JSON.parse(row.payload)),true);
});
test('Project names reject Windows reserved names and path traversal while accepting Chinese',()=>{
  for(const value of ['../escape','..','x/y','x\\y','CON','nul.txt','LPT1','COM¹','name.','x:y','a\nname'])assert.throws(()=>projectName(value));
  assert.equal(projectName(' 我的網站 '),'我的網站');
});
