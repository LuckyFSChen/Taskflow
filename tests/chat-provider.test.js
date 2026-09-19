// Chat Provider：設定解析、CLI 參數、輸出解析、錯誤分類，以及「絕不靜默 fallback」。
//
// 這裡不會真的執行 Codex 或 Claude：spawn 是注入的，所以每一個斷言都是對
// 「TaskFlow 實際會下什麼指令、實際怎麼判讀結果」的檢查，不是對某一台機器的檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createLineChatWorker} from '../server/line-chat.js';
import {
  ChatProviderError,buildChatArguments,chatFailureMessage,chatProviderHealth,
  createChatProviderHealth,resolveChatConfig,runChat,sanitizeModel,sanitizeProvider,updateChatSettings
} from '../server/chat-provider.js';

const BINS={CODEX_BIN:'codex-test-bin',CLAUDE_BIN:'claude-test-bin'};
const fakeStore=(values={})=>({
  values,
  setting:(key,fallback=null)=>values[key]??fallback,
  setSetting(key,value){values[key]=value;},
  transaction:fn=>fn()
});

// 一個受控的子程序：不設 pid，所以失敗路徑上的 killTree() 不會真的去殺任何東西。
function fakeChild({stdout=[],stderr=[],code=0,spawnError=null,silent=false}={}){
  const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdin={end(){},on(){}};
  setImmediate(()=>{
    if(spawnError){child.emit('error',spawnError);return;}
    if(silent)return;
    for(const line of stdout)child.stdout.emit('data',Buffer.from(line+'\n'));
    for(const line of stderr)child.stderr.emit('data',Buffer.from(line+'\n'));
    child.emit('close',code);
  });
  return child;
}
function recorder(script){
  const calls=[];
  return {calls,spawnProcess:(executable,args,options)=>{calls.push({executable,args,options});return fakeChild(script);}};
}
const codexSays=text=>[JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})];
const claudeSays=text=>[
  JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}),
  JSON.stringify({type:'result',subtype:'success',is_error:false,result:text,session_id:'s1'})
];

// --- 一、設定解析 -------------------------------------------------------------------
test('沒有任何設定時預設 Codex，兩家模型都交給 CLI 預設值', () => {
  const config=resolveChatConfig(null,{env:{}});
  assert.equal(config.provider,'codex');
  assert.equal(config.model,'');
  assert.deepEqual(config.models,{codex:'',claude:''});
  assert.deepEqual(config.sources,{provider:'default',codex:'cli',claude:'cli'});
});

test('Provider 優先序：DB 覆蓋環境變數，環境變數覆蓋預設值', () => {
  assert.equal(resolveChatConfig(null,{env:{CHAT_PROVIDER:'claude'}}).provider,'claude');
  assert.equal(resolveChatConfig(fakeStore({chatProvider:'claude'}),{env:{}}).sources.provider,'db');
  assert.equal(resolveChatConfig(fakeStore({chatProvider:'codex'}),{env:{CHAT_PROVIDER:'claude'}}).provider,'codex');
});

test('未知的 Provider 一律忽略，不會寫進設定也不會被使用', () => {
  assert.equal(resolveChatConfig(fakeStore({chatProvider:'gemini'}),{env:{}}).provider,'codex');
  assert.equal(resolveChatConfig(fakeStore({chatProvider:'gemini'}),{env:{CHAT_PROVIDER:'claude'}}).provider,'claude');
  assert.equal(resolveChatConfig(null,{env:{CHAT_PROVIDER:'llama'}}).provider,'codex');
  assert.equal(sanitizeProvider('CLAUDE'),'claude');
  assert.equal(sanitizeProvider('gemini'),'');
});

test('Codex 模型優先序：DB → CHAT_MODEL_CODEX → 舊的 LINE_GPT_MODEL → CLI 預設', () => {
  const env={CHAT_MODEL_CODEX:'env-model',LINE_GPT_MODEL:'gpt-6-astra'};
  assert.deepEqual(
    [resolveChatConfig(fakeStore({chatModelCodex:'db-model'}),{env}).models.codex,resolveChatConfig(fakeStore({chatModelCodex:'db-model'}),{env}).sources.codex],
    ['db-model','db']);
  assert.equal(resolveChatConfig(null,{env}).models.codex,'env-model');
  const legacy=resolveChatConfig(null,{env:{LINE_GPT_MODEL:'gpt-6-astra'}});
  assert.equal(legacy.models.codex,'gpt-6-astra');
  assert.equal(legacy.sources.codex,'legacy');
  assert.equal(resolveChatConfig(null,{env:{}}).models.codex,'');
});

test('Claude 模型優先序：DB → CHAT_MODEL_CLAUDE → CLI 預設；不吃 LINE_GPT_MODEL', () => {
  assert.equal(resolveChatConfig(fakeStore({chatModelClaude:'db-claude'}),{env:{CHAT_MODEL_CLAUDE:'env-claude'}}).models.claude,'db-claude');
  assert.equal(resolveChatConfig(null,{env:{CHAT_MODEL_CLAUDE:'env-claude'}}).models.claude,'env-claude');
  assert.equal(resolveChatConfig(null,{env:{LINE_GPT_MODEL:'gpt-6-astra'}}).models.claude,'');
});

test('兩家模型分開儲存：切換 Provider 不會蓋掉另一家上次的設定', () => {
  const store=fakeStore();
  updateChatSettings(store,{provider:'codex',models:{codex:'gpt-6-astra',claude:'claude-sonnet-5'}},{env:{}});
  assert.equal(resolveChatConfig(store,{env:{}}).model,'gpt-6-astra');
  updateChatSettings(store,{provider:'claude'},{env:{}});
  const switched=resolveChatConfig(store,{env:{}});
  assert.equal(switched.model,'claude-sonnet-5');
  assert.deepEqual(switched.models,{codex:'gpt-6-astra',claude:'claude-sonnet-5'});
  updateChatSettings(store,{provider:'codex'},{env:{}});
  assert.equal(resolveChatConfig(store,{env:{}}).model,'gpt-6-astra');
});

test('模型名稱是 CLI 參數，所以只接受白名單字元且不得以 - 開頭', () => {
  assert.equal(sanitizeModel('claude-sonnet-5'),'claude-sonnet-5');
  assert.equal(sanitizeModel('  gpt-6-astra  '),'gpt-6-astra');
  assert.equal(sanitizeModel('--dangerously-skip-permissions'),'');
  assert.equal(sanitizeModel('-p'),'');
  assert.equal(sanitizeModel('model name with spaces'),'');
  assert.equal(sanitizeModel('a'.repeat(200)),'');
  assert.equal(sanitizeModel(null),'');
  // 環境變數同樣要過這一關：壞值一律當作沒設定，不會流進 spawn()。
  assert.equal(resolveChatConfig(null,{env:{CHAT_MODEL_CLAUDE:'--flag'}}).models.claude,'');
});

// --- 二、CLI 參數 -------------------------------------------------------------------
test('Codex Chat 維持既有的唯讀沙箱與停用清單', () => {
  const args=buildChatArguments({provider:'codex',model:'gpt-6-astra',cwd:'/tmp/chat'});
  assert.equal(args[0],'exec');
  assert.equal(args.at(-1),'-');
  for(const flag of ['--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--json'])assert.ok(args.includes(flag),flag);
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  for(const setting of ['approval_policy="never"','project_doc_max_bytes=0','web_search="disabled"'])assert.ok(args.includes(setting),setting);
  for(const feature of ['shell_tool','apps','plugins','browser_use','computer_use','image_generation'])
    assert.ok(args.some((value,index)=>args[index-1]==='--disable'&&value===feature),feature);
  assert.equal(args[args.indexOf('--model')+1],'gpt-6-astra');
  assert.ok(!buildChatArguments({provider:'codex',cwd:'/tmp/chat'}).includes('--model'));
});

test('Claude Chat 是純文字沙箱：無工具、無 MCP、不讀個人設定、不可寫入', () => {
  const args=buildChatArguments({provider:'claude',model:'claude-sonnet-5',cwd:'/tmp/chat'});
  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('--output-format')+1],'stream-json');
  assert.equal(args[args.indexOf('--permission-mode')+1],'plan');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
  assert.equal(args[args.indexOf('--setting-sources')+1],'');
  const disallowed=args[args.indexOf('--disallowedTools')+1].split(',');
  for(const tool of ['Bash','Write','Edit','Read','Glob','Grep','WebFetch','WebSearch','Task','ReadMcpResource'])
    assert.ok(disallowed.includes(tool),tool);
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.includes('--add-dir'));
  assert.equal(args[args.indexOf('--model')+1],'claude-sonnet-5');
  assert.match(args[args.indexOf('--append-system-prompt')+1],/不要使用任何工具/);
  assert.ok(!buildChatArguments({provider:'claude',cwd:'/tmp/chat'}).includes('--model'));
});

// --- 三、實際執行 -------------------------------------------------------------------
test('Codex Chat：執行檔、模型與輸出解析', async () => {
  const {calls,spawnProcess}=recorder({stdout:codexSays('你好，我能幫你釐清需求。')});
  const result=await runChat({provider:'codex',model:'gpt-6-astra',text:'你好',spawnProcess,env:BINS});
  assert.deepEqual(result,{provider:'codex',model:'gpt-6-astra',text:'你好，我能幫你釐清需求。'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].executable,'codex-test-bin');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model')+1],'gpt-6-astra');
  assert.equal(calls[0].options.shell,false);
});

test('Claude Chat：執行檔、模型與 stream-json 解析', async () => {
  const {calls,spawnProcess}=recorder({stdout:claudeSays('這是 Claude 的回覆。')});
  const result=await runChat({provider:'claude',model:'claude-sonnet-5',text:'你好',spawnProcess,env:BINS});
  assert.deepEqual(result,{provider:'claude',model:'claude-sonnet-5',text:'這是 Claude 的回覆。'});
  assert.equal(calls[0].executable,'claude-test-bin');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model')+1],'claude-sonnet-5');
});

test('Chat 子程序拿不到任何 token／secret／API key', async () => {
  const {calls,spawnProcess}=recorder({stdout:claudeSays('好的')});
  await runChat({provider:'claude',text:'你好',spawnProcess,env:{...BINS,INBOX_TOKEN:'s1',LINE_CHANNEL_ACCESS_TOKEN:'s2',ANTHROPIC_API_KEY:'s3',SOME_PASSWORD:'s4',SAFE_VALUE:'keep'}});
  const childEnv=calls[0].options.env;
  for(const key of ['INBOX_TOKEN','LINE_CHANNEL_ACCESS_TOKEN','ANTHROPIC_API_KEY','SOME_PASSWORD'])assert.equal(childEnv[key],undefined,key);
  assert.equal(childEnv.SAFE_VALUE,'keep');
});

test('錯誤分類：登入、模型、啟動失敗、空回覆、逾時各自有自己的代碼', async () => {
  const auth=recorder({code:1,stderr:['Invalid API key · Please run /login']});
  await assert.rejects(runChat({provider:'claude',text:'x',spawnProcess:auth.spawnProcess,env:BINS}),error=>error.code==='AUTH_REQUIRED');

  const model=recorder({code:1,stderr:['Model "nope-5" is not a recognized model id.']});
  await assert.rejects(runChat({provider:'claude',model:'nope-5',text:'x',spawnProcess:model.spawnProcess,env:BINS}),error=>error.code==='MODEL_UNAVAILABLE');

  const missing=recorder({spawnError:Object.assign(new Error('spawn claude-test-bin ENOENT'),{code:'ENOENT'})});
  await assert.rejects(runChat({provider:'claude',text:'x',spawnProcess:missing.spawnProcess,env:BINS}),error=>error.code==='PROVIDER_UNAVAILABLE');

  const empty=recorder({code:0,stdout:[]});
  await assert.rejects(runChat({provider:'codex',text:'x',spawnProcess:empty.spawnProcess,env:BINS}),error=>error.code==='INVALID_OUTPUT');

  const failed=recorder({code:3,stderr:['boom']});
  await assert.rejects(runChat({provider:'codex',text:'x',spawnProcess:failed.spawnProcess,env:BINS}),error=>error.code==='PROCESS_FAILED');

  const hang=recorder({silent:true});
  await assert.rejects(runChat({provider:'claude',text:'x',spawnProcess:hang.spawnProcess,env:BINS,timeoutMs:20}),error=>error.code==='TIMEOUT');
});

test('Provider 失敗時絕不改用另一家 CLI', async () => {
  const {calls,spawnProcess}=recorder({code:1,stderr:['Please run /login']});
  await assert.rejects(runChat({provider:'claude',text:'x',spawnProcess,env:BINS}));
  assert.equal(calls.length,1);
  assert.equal(calls[0].executable,'claude-test-bin');
  assert.ok(!calls.some(call=>String(call.executable).includes('codex')));
});

// --- 四、對使用者顯示的訊息 ---------------------------------------------------------
test('LINE 錯誤訊息依 Provider 分辨，且不外洩 CLI 原始輸出，也不再叫 GPT', () => {
  const leaky=new ChatProviderError('AUTH_REQUIRED','claude authentication required',{detail:'token=super-secret C:/Users/me/.claude'});
  const claude=chatFailureMessage({provider:'claude'},leaky);
  assert.match(claude,/Claude/);
  assert.match(claude,/Claude Code CLI 的登入狀態/);
  assert.ok(!claude.includes('super-secret'));
  assert.ok(!/GPT/.test(claude));
  assert.match(chatFailureMessage({provider:'codex'},leaky),/Codex CLI 的登入狀態/);
  assert.match(chatFailureMessage({provider:'claude'},new ChatProviderError('MODEL_UNAVAILABLE','x')),/模型無法使用/);
  assert.match(chatFailureMessage({provider:'codex'},new ChatProviderError('TIMEOUT','x')),/逾時/);
  // 認不出 Provider 時用 Provider-neutral 的說法。
  const neutral=chatFailureMessage({provider:'unknown'},new Error('boom'));
  assert.match(neutral,/^AI 暫時無法回覆/);
  assert.ok(!/GPT/.test(neutral));
});

// --- 五、Health check ---------------------------------------------------------------
test('Health check 只問 --version，並明確回報哪一個 CLI 不可用', async () => {
  const seen=[];
  const execFileImpl=(executable,args,options,callback)=>{
    seen.push({executable,args});
    if(String(executable).includes('claude'))return callback(new Error('not found'));
    callback(null,'codex-cli 1.2.3\n','');
  };
  const health=await chatProviderHealth({env:BINS,execFileImpl});
  assert.deepEqual(seen.map(call=>call.args),[['--version'],['--version']]);
  assert.equal(health.codex.available,true);
  assert.equal(health.codex.version,'codex-cli 1.2.3');
  assert.equal(health.codex.error,null);
  assert.equal(health.claude.available,false);
  assert.match(health.claude.error,/Claude Code CLI 無法執行/);
  assert.match(health.claude.error,/CLAUDE_BIN/);
});

test('Health check 有快取：連續詢問不會變成 CLI 程序風暴', async () => {
  let runs=0;
  const execFileImpl=(executable,args,options,callback)=>{runs++;callback(null,'v1','');};
  const provider=createChatProviderHealth({env:BINS,execFileImpl});
  await Promise.all([provider.get(),provider.get(),provider.get()]);
  await provider.get();
  assert.equal(runs,2); // 兩個 CLI 各問一次，其餘都來自快取
});

// --- 六、Runtime 切換 ---------------------------------------------------------------
function chatFixture(t){
  const dir=mkdtempSync(join(tmpdir(),'tf-chat-provider-'));
  const store=createStore(join(dir,'db.sqlite'));
  const user=store.addUser('Test','test','test-password-123'),lineId='U'+'c'.repeat(32);
  store.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,user.id);
  const ask=text=>store.db.prepare('INSERT INTO line_chats(event_id,user_id,line_id,prompt,created,binding_id) VALUES (?,?,?,?,?,?)')
    .run(id(),user.id,lineId,text,Date.now(),store.lineLink(lineId).id);
  const last=()=>store.db.prepare('SELECT message FROM outbox ORDER BY rowid DESC LIMIT 1').get().message;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,ask,last};
}

test('改設定後下一則訊息就生效，不需要重新啟動服務', async t => {
  const f=chatFixture(t),seen=[];
  const worker=createLineChatWorker(f.store,{intervalMs:3600000,log:()=>{},generate:async({config})=>{seen.push({provider:config.provider,model:config.model});return {provider:config.provider,model:config.model,text:'回覆'};}});
  t.after(()=>worker.stop());
  f.ask('第一則');await worker.tick();
  updateChatSettings(f.store,{provider:'claude',models:{claude:'claude-sonnet-5'}},{env:{}});
  f.ask('第二則');await worker.tick();
  assert.deepEqual(seen,[{provider:'codex',model:''},{provider:'claude',model:'claude-sonnet-5'}]);
});

test('執行中的對話用原本的設定跑完，切換只影響下一則', async t => {
  const f=chatFixture(t),seen=[],releases=[];
  const worker=createLineChatWorker(f.store,{intervalMs:3600000,log:()=>{},generate:({config})=>{seen.push(config.provider);return new Promise(resolve=>{releases.push(()=>resolve('回覆'));});}});
  t.after(()=>worker.stop());
  f.ask('進行中');
  // job 開始時就把設定定住了；下面這一行在它跑完之前把 Provider 換掉。
  const running=worker.tick();
  updateChatSettings(f.store,{provider:'claude'},{env:{}});
  releases[0]();await running;
  assert.deepEqual(seen,['codex']);
  f.ask('下一則');
  const next=worker.tick();
  releases[1]();await next;
  assert.deepEqual(seen,['codex','claude']);
});

test('Provider 失敗時 LINE 收到該 Provider 的訊息，而不是換一家回答', async t => {
  const f=chatFixture(t);
  updateChatSettings(f.store,{provider:'claude'},{env:{}});
  const worker=createLineChatWorker(f.store,{intervalMs:3600000,log:()=>{},generate:async()=>{throw new ChatProviderError('AUTH_REQUIRED','claude authentication required',{detail:'raw cli output'});}});
  t.after(()=>worker.stop());
  f.ask('你好');await worker.tick();
  const reply=f.last();
  assert.match(reply,/Claude Code CLI 的登入狀態/);
  assert.ok(!reply.includes('raw cli output'));
  assert.ok(!/GPT|Codex/.test(reply));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM line_chats WHERE status='failed'").get().n,1);
});
