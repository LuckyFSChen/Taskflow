import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {processLine} from '../server/line.js';
import {taskInput} from '../server/domain.js';
import {taskEngineDefaults,resolveEngines,autoModeSummary,engineLabel,TASK_TYPES,AI_MODES,AUTO,CUSTOM} from '../src/task-defaults.js';

// --- 預設安排 ------------------------------------------------------------------------
test('程式開發與研究文件各自沿用既有的引擎安排',()=>{
  assert.deepEqual(taskEngineDefaults('code'),{planner:'claude',executor:'codex',reviewer:'claude'});
  assert.deepEqual(taskEngineDefaults('research'),{planner:'claude',executor:'claude',reviewer:'codex'});
});

test('未知的任務類型當成程式開發處理，不會回傳空值',()=>{
  for(const type of [undefined,null,'','something-else'])
    assert.deepEqual(taskEngineDefaults(type),{planner:'claude',executor:'codex',reviewer:'claude'});
});

test('表單選項與後端接受的值一致',()=>{
  assert.deepEqual(TASK_TYPES.map(t=>t.value),['code','research']);
  assert.deepEqual(AI_MODES.map(m=>m.value),[AUTO,CUSTOM]);
  assert.equal(AI_MODES[0].label,'自動選擇（推薦）','自動選擇必須是第一個，也就是預設');
  // 三個引擎值都必須通過既有的 taskInput 驗證：UX 改造不得送出後端不認得的值。
  for(const type of ['code','research']){
    const parsed=taskInput.parse({title:'測試任務',description:'測試需求內容',projectId:'0f9b7d6e-8f4a-4b1e-9c2d-1a2b3c4d5e6f',type,...taskEngineDefaults(type)});
    assert.deepEqual({planner:parsed.planner,executor:parsed.executor,reviewer:parsed.reviewer},taskEngineDefaults(type));
  }
});

// --- 送出時真正採用的引擎 --------------------------------------------------------------
test('自動模式一律採用該類型的預設，忽略表單裡殘留的自訂值',()=>{
  const form={aiMode:AUTO,type:'research',planner:'codex',executor:'codex',reviewer:'codex'};
  assert.deepEqual(resolveEngines(form),{planner:'claude',executor:'claude',reviewer:'codex'});
});

test('自訂模式沿用使用者的選擇',()=>{
  const form={aiMode:CUSTOM,type:'code',planner:'codex',executor:'claude',reviewer:'codex'};
  assert.deepEqual(resolveEngines(form),{planner:'codex',executor:'claude',reviewer:'codex'});
});

test('自訂模式缺漏的欄位退回預設，不送出空值',()=>{
  assert.deepEqual(resolveEngines({aiMode:CUSTOM,type:'research',executor:'codex'}),{planner:'claude',executor:'codex',reviewer:'codex'});
  assert.deepEqual(resolveEngines({aiMode:CUSTOM,type:'code'}),taskEngineDefaults('code'));
  assert.deepEqual(resolveEngines({}),taskEngineDefaults('code'));
});

// --- 自動模式的說明文字 ----------------------------------------------------------------
test('自動模式說明用角色與模型名稱，不出現 Planner／Executor／Reviewer',()=>{
  const summary=autoModeSummary('code');
  assert.equal(summary,'規劃 Claude Code · 執行 Codex · 驗證 Claude Code');
  assert.doesNotMatch(summary,/Planner|Executor|Reviewer/i);
  assert.equal(autoModeSummary('research'),'規劃 Claude Code · 執行 Claude Code · 驗證 Codex');
  assert.equal(engineLabel('codex'),'Codex');
  assert.equal(engineLabel('unknown'),'unknown','不認得的引擎照原樣顯示，不隱藏');
});

// --- 與既有 LINE 建立流程釘在一起 --------------------------------------------------------
// 這組預設不是新發明的，而是系統既有的安排。下面實際跑一次 LINE 的建立任務流程，
// 拿真正建出來的任務去比對前端的預設；兩邊只要有一邊改了就會失敗。
function lineFixture(t){
  const root=mkdtempSync(join(tmpdir(),'task-defaults-')),s=createStore(join(root,'db.sqlite'));
  const user=s.addUser('Member','member','fixture-password'),pid=id();
  mkdirSync(join(root,'project'));
  s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','測試專案',join(root,'project'));
  s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(user.id,pid);
  const lineId='U'+'b'.repeat(32);
  s.db.prepare('UPDATE users SET line_id=? WHERE id=?').run(lineId,user.id);
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
  const send=(value,postback=true,eventId=id())=>processLine(s,{webhookEventId:eventId,type:postback?'postback':'message',source:{type:'user',userId:lineId},...(postback?{postback:{data:value}}:{message:{type:'text',text:value}})});
  const flow=()=>JSON.parse(s.db.prepare('SELECT data FROM line_flows WHERE user_id=?').get(user.id).data);
  return {s,pid,send,flow};
}

for(const type of ['code','research']){
  test(`前端預設與既有 LINE 建立流程一致（${type}）`,t=>{
    const f=lineFixture(t);
    f.send('tf:new');
    const nonce=f.flow().id;
    f.send(`tf:project:${nonce}:${f.pid}`);
    f.send(`tf:type:${nonce}:${type}`);
    f.send('一致性測試任務',false);
    f.send('確認前端與 LINE 使用同一組引擎安排。',false);
    f.send(`tf:submit:${nonce}`);
    const created=f.s.tasks()[0];
    assert.equal(created.type,type);
    assert.deepEqual(
      {planner:created.planner,executor:created.executor,reviewer:created.reviewer},
      taskEngineDefaults(type),
      '前端的自動安排必須與 LINE 建立任務流程相同；有一邊改了就要一起改。'
    );
  });
}
