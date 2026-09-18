import test from 'node:test';
import assert from 'node:assert/strict';
import {healthGroups,healthAlert,healthMark,healthStatusLabel,healthCheckLabel} from '../src/system-health-view.js';

const ok=message=>({status:'ok',message});
const healthy=()=>({status:'ok',checkedAt:'2026-01-01T00:00:00.000Z',checks:{
  runtime:ok('Node 24.20.0 可使用'),
  runner:ok('任務服務已啟用'),codex:ok('Codex CLI 可使用'),claude:ok('Claude CLI 可使用'),
  browser:ok('Browser MCP 可使用（playwright-mcp）'),projects:ok('2 個專案路徑正常'),line:ok('已連線')
}});
const flat=health=>healthGroups(health).flatMap(group=>group.items);
const find=(health,key)=>flat(health).find(item=>item.key===key);

// --- 分組與顯示 --------------------------------------------------------------------
test('分組順序固定：Runtime / AI Engines / Browser / Runner / Projects / LINE',()=>{
  const groups=healthGroups(healthy());
  assert.deepEqual(groups.map(g=>g.label),['Runtime','AI Engines','Browser','Runner','Projects','LINE']);
  assert.deepEqual(groups[0].items.map(i=>i.label),['Node']);
  assert.deepEqual(groups[1].items.map(i=>i.label),['Codex','Claude']);
  assert.deepEqual(groups[3].items.map(i=>i.label),['任務服務']);
});

test('每個項目帶出狀態、符號與後端訊息',()=>{
  const health=healthy();
  health.checks.claude={status:'error',message:'Claude CLI 無法執行'};
  health.checks.projects={status:'warning',message:'1 個專案路徑不存在：舊專案'};
  health.checks.line={status:'unknown',message:'尚未設定 LINE 連線'};
  assert.deepEqual(find(health,'codex'),{key:'codex',label:'Codex',status:'ok',mark:'✓',message:'Codex CLI 可使用'});
  assert.deepEqual(find(health,'claude'),{key:'claude',label:'Claude',status:'error',mark:'✗',message:'Claude CLI 無法執行'});
  assert.equal(find(health,'projects').mark,'⚠');
  assert.equal(find(health,'line').mark,'？');
});

test('沒有資料時不會顯示空白分組，也不會報錯',()=>{
  assert.deepEqual(healthGroups(null),[]);
  assert.deepEqual(healthGroups({}),[]);
  assert.deepEqual(healthGroups({checks:null}),[]);
  assert.deepEqual(healthGroups({checks:{codex:ok('可使用')}}).map(g=>g.label),['AI Engines']);
});

test('後端新增的檢查不會弄亂版面；缺少訊息時仍有可讀文字',()=>{
  const groups=healthGroups({checks:{codex:{status:'ok'},future:ok('未來的檢查')}});
  assert.deepEqual(groups.map(g=>g.label),['AI Engines']);
  assert.equal(groups[0].items[0].message,'Codex 尚未取得檢查結果');
});

test('不認得的狀態一律當成尚未確認，不會樂觀地顯示為正常',()=>{
  assert.equal(find({checks:{codex:{status:'ready',message:'x'}}},'codex').status,'unknown');
  assert.equal(healthMark('bogus'),'？');
  assert.equal(healthStatusLabel('bogus'),'尚未確認');
  assert.deepEqual([healthMark('ok'),healthMark('warning'),healthMark('error')],['✓','⚠','✗']);
  assert.deepEqual([healthStatusLabel('ok'),healthStatusLabel('warning'),healthStatusLabel('error')],['正常','需要注意','有問題']);
  assert.equal(healthCheckLabel('browser'),'Playwright MCP');
});

// --- 首頁提醒 ----------------------------------------------------------------------
test('只有 error 會觸發首頁提醒',()=>{
  assert.equal(healthAlert(healthy()),null);
  assert.equal(healthAlert({status:'warning',checks:{projects:{status:'warning',message:'路徑不存在'}}}),null);
  assert.equal(healthAlert({status:'unknown',checks:{}}),null);
  assert.equal(healthAlert(null),null);
});

test('首頁提醒只列出真的壞掉的項目，其餘正常的引擎不受影響',()=>{
  const alert=healthAlert({status:'error',checks:{
    codex:ok('Codex CLI 可使用'),
    claude:{status:'error',message:'Claude CLI 無法執行'},
    projects:{status:'warning',message:'1 個專案路徑不存在'}
  }});
  assert.equal(alert.title,'執行環境有問題');
  assert.equal(alert.action,'查看系統狀態');
  // Codex 正常、Claude 壞掉：提醒只提 Claude，不會宣稱整個 TaskFlow 不能用。
  assert.deepEqual(alert.messages,['Claude CLI 無法執行']);
});

test('兩個引擎同時壞掉時，兩項都會列出',()=>{
  const alert=healthAlert({status:'error',checks:{
    codex:{status:'error',message:'Codex CLI 無法執行'},
    claude:{status:'error',message:'Claude CLI 無法執行'}
  }});
  assert.deepEqual(alert.messages,['Codex CLI 無法執行','Claude CLI 無法執行']);
});

test('狀態是 error 但沒有任何項目是 error 時不會顯示空提醒',()=>{
  assert.equal(healthAlert({status:'error',checks:{}}),null);
  assert.equal(healthAlert({status:'error'}),null);
});
