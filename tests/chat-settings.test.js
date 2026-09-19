// 後台 Chat 設定 API：授權、驗證、持久化，以及「不影響 Task Runner」。
//
// 走真正的 HTTP：授權與 Zod 驗證都發生在 Express 這一層，直接呼叫函式測不到。
// Health 是注入的假資料，測試不會去執行任何 CLI。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,hash} from '../server/db.js';
import {createApp} from '../server/app.js';
import {resolveChatConfig} from '../server/chat-provider.js';

const HEALTH={
  codex:{available:true,version:'codex-cli 1.2.3',error:null},
  claude:{available:false,version:null,error:'Claude Code CLI 無法執行。請確認已安裝並完成登入，或以 CLAUDE_BIN 指定執行檔路徑。'}
};

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'tf-chat-settings-'));
  const store=createStore(join(root,'db.sqlite'));
  const admin=store.addUser('Admin','admin','test-password-admin','admin');
  const member=store.addUser('Member','member','test-password-member');
  for(const [user,token] of [[admin,'admin-session'],[member,'member-session']])
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),user.id,Date.now()+60000);
  const app=createApp(store,{status:{}},{dist:join(root,'missing-dist'),chatHealth:{get:async()=>HEALTH}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(method,body,token='admin-session')=>fetch(base+'/api/admin/chat-settings',{
    method,
    headers:{...(token?{cookie:`tf_session=${token}`}:{}),'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  return {store,call};
}

test('只有管理者能讀寫 Chat 設定', async t => {
  const f=await fixture(t);
  assert.equal((await f.call('GET',undefined,'member-session')).status,403);
  assert.equal((await f.call('POST',{provider:'claude'},'member-session')).status,403);
  assert.equal((await f.call('GET',undefined,null)).status,401);
  assert.equal((await f.call('GET')).status,200);
  // 被擋下來的請求不可以留下任何痕跡。
  assert.equal(f.store.setting('chatProvider',null),null);
});

test('GET 回傳目前設定、兩家模型、建議值與 CLI 可用狀態', async t => {
  const f=await fixture(t);
  const data=await (await f.call('GET')).json();
  assert.equal(data.provider,'codex');
  assert.deepEqual(Object.keys(data.models).sort(),['claude','codex']);
  assert.deepEqual(data.providers,HEALTH);
  assert.equal(data.recommended.claude,'claude-sonnet-5');
  assert.equal(data.sources.provider,'default');
});

test('儲存後立刻生效：寫進 settings，下一次解析就是新的 Provider', async t => {
  const f=await fixture(t);
  const saved=await (await f.call('POST',{provider:'claude',models:{codex:'gpt-6-astra',claude:'claude-sonnet-5'}})).json();
  assert.equal(saved.provider,'claude');
  assert.equal(saved.models.claude,'claude-sonnet-5');
  assert.equal(f.store.setting('chatProvider'),'claude');
  // 下一個 Chat job 會呼叫 resolveChatConfig()，不需要重新啟動服務。
  const config=resolveChatConfig(f.store,{env:{}});
  assert.equal(config.provider,'claude');
  assert.equal(config.model,'claude-sonnet-5');
  assert.equal((await (await f.call('GET')).json()).provider,'claude');
});

test('PUT 與 POST 等價；模型留白代表回到 CLI 預設', async t => {
  const f=await fixture(t);
  await f.call('POST',{provider:'codex',models:{codex:'gpt-6-astra'}});
  const cleared=await (await f.call('PUT',{provider:'codex',models:{codex:''}})).json();
  assert.equal(cleared.models.codex,'');
  assert.equal(resolveChatConfig(f.store,{env:{LINE_GPT_MODEL:'gpt-6-astra'}}).sources.codex,'legacy');
});

test('不合法的輸入一律 400，而且不會寫進設定', async t => {
  const f=await fixture(t);
  await f.call('POST',{provider:'claude',models:{claude:'claude-sonnet-5'}});
  for(const body of [
    {provider:'gemini'},
    {provider:'claude',models:{claude:'--dangerously-skip-permissions'}},
    {provider:'claude',models:{claude:'a'.repeat(200)}},
    {provider:'claude',models:{claude:'claude-sonnet-5',extra:'x'}},
    {provider:'claude',command:'rm -rf /'},
    {provider:'claude',models:{claude:{$ne:null}}},
    {}
  ]){
    const response=await f.call('POST',body);
    assert.equal(response.status,400,JSON.stringify(body));
    assert.match((await response.json()).error,/格式不正確/);
  }
  // 設定維持在上一個成功的值。
  assert.equal(f.store.setting('chatProvider'),'claude');
  assert.equal(f.store.setting('chatModelClaude'),'claude-sonnet-5');
});

test('切換 Chat 不會動到 Task Runner 的任何設定', async t => {
  const f=await fixture(t);
  f.store.setSetting('runnerEnabled',true);
  f.store.setSetting('runnerMaxConcurrent',4);
  await f.call('POST',{provider:'claude',models:{claude:'claude-sonnet-5'}});
  assert.equal(f.store.setting('runnerEnabled'),true);
  assert.equal(f.store.setting('runnerMaxConcurrent'),4);
  // Chat 只碰自己的三個 key。
  const keys=f.store.db.prepare('SELECT key FROM settings ORDER BY key').all().map(row=>row.key);
  assert.deepEqual(keys,['chatModelClaude','chatProvider','runnerEnabled','runnerMaxConcurrent']);
});
