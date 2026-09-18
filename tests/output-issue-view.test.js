import test from 'node:test';
import assert from 'node:assert/strict';
import {outputIssueView,outputIssueActions,missingFields,missingFieldLabels,fieldLabel} from '../src/output-issue-view.js';

// Phase 4 之前使用者看到的就是這串 Zod 訊息。Phase 5 的重點是：這些字不得再成為主要 UI。
const zodIssues=['questions：Required','artifacts：Required','passed：Required'];
const issue=(extra={})=>({id:'o1',phase:'execute',planVersion:1,message:'AI 回傳格式仍不完整\nquestions：Required',issues:[...zodIssues],...extra});
const task=({outputIssue,...rest}={})=>({id:'t1',status:'waiting_input',planVersion:1,outputIssue:issue(outputIssue),...rest});
const visibleText=view=>[view.title,view.lead,view.retainedTitle,...view.retained,view.noRerunNote,view.missingTitle,...view.missing,...view.actions.flatMap(a=>[a.label,a.note])].join('\n');

// --- 主要訊息 ------------------------------------------------------------------------
test('Output Issue 顯示規格指定的訊息與保留清單',()=>{
  const view=outputIssueView(task());
  assert.equal(view.title,'成果報告不完整');
  assert.equal(view.lead,'AI 已完成工作，但回傳的成果格式缺少必要資訊。');
  assert.equal(view.retainedTitle,'TaskFlow 已保留：');
  assert.deepEqual(view.retained,['原始 AI 回傳','已完成進度','工作副本','執行紀錄']);
  assert.equal(view.noRerunNote,'TaskFlow 不會因為報告格式問題重新執行已完成工作。');
});

test('沒有 outputIssue 的任務不顯示任何東西',()=>{
  assert.equal(outputIssueView({id:'t1',status:'running'}),null);
  assert.equal(outputIssueView(null),null);
  assert.equal(outputIssueView({outputIssue:null}),null);
});

// --- Zod 原始訊息只能出現在技術資訊 ----------------------------------------------------
test('Zod 原始訊息不得出現在主要 UI，只能放在技術資訊裡',()=>{
  const view=outputIssueView(task());
  const shown=visibleText(view);
  assert.doesNotMatch(shown,/Required/);
  assert.doesNotMatch(shown,/questions|artifacts|passed/);
  assert.doesNotMatch(shown,/schema/i);
  // 但技術資訊必須完整保留，Debug 能力不會因此消失。
  assert.equal(view.technical.title,'技術資訊');
  assert.deepEqual(view.technical.issues,zodIssues);
  assert.match(view.technical.message,/questions：Required/);
});

// --- 目前仍缺少 ----------------------------------------------------------------------
test('Recovery 失敗時顯示「目前仍缺少」，並翻成使用者看得懂的名稱',()=>{
  const view=outputIssueView(task({outputIssue:{recovery:{ok:false,reason:'原始輸出沒有可用的 summary',missing:['summary','evidence'],notes:[]}}}));
  assert.equal(view.missingTitle,'目前仍缺少：');
  assert.deepEqual(view.missing,['工作摘要','可確認的驗證證據']);
  assert.doesNotMatch(visibleText(view),/summary|evidence/);
});

test('沒有 recovery 結論時，改由建立問題當下的欄位推導，仍然翻成中文',()=>{
  assert.deepEqual(missingFields(issue()),['questions','artifacts','passed']);
  assert.deepEqual(missingFieldLabels(issue()),['待確認問題清單','產出檔案清單','驗收結果']);
});

test('recovery 的結論優先於建立當下的欄位，重複欄位只列一次',()=>{
  const value=issue({recovery:{ok:false,reason:'x',missing:['evidence','evidence'],notes:[]}});
  assert.deepEqual(missingFields(value),['evidence']);
});

test('不認得的欄位照原樣列出，不會悄悄少報一項',()=>{
  assert.equal(fieldLabel('somethingNew'),'somethingNew');
  assert.equal(fieldLabel('summary'),'工作摘要');
  assert.deepEqual(missingFields({issues:['根物件：Expected object']}),[],'根物件不是欄位名稱');
  assert.deepEqual(missingFields({}),[]);
  assert.deepEqual(missingFields(null),[]);
});

test('沒有可判定的缺少項目時不顯示空白清單',()=>{
  assert.deepEqual(outputIssueView({outputIssue:{id:'o1'}}).missing,[]);
});

// --- 可提供的操作 --------------------------------------------------------------------
test('可以重新執行 deterministic recovery 時才出現「重新整理成果報告」',()=>{
  const actions=outputIssueActions(task({outputIssue:{recoverable:true}}));
  assert.deepEqual(actions.map(a=>a.id),['recover','raw','replan']);
  assert.equal(actions[0].label,'重新整理成果報告');
  assert.match(actions[0].note,/不會再次執行工作/);
});

test('不能重新整理時不給注定失敗的按鈕，但原始回傳與重新規劃一定保留',()=>{
  for(const outputIssue of [{recoverable:false},{},{recovery:{ok:false,reason:'x',missing:['summary'],notes:[]}}]){
    const actions=outputIssueActions(task({outputIssue}));
    assert.deepEqual(actions.map(a=>a.id),['raw','replan']);
  }
});

test('重新規劃必須說清楚那是新計畫，不是單純格式修復',()=>{
  const replan=outputIssueActions(task()).find(a=>a.id==='replan');
  assert.equal(replan.label,'補充需求並重新規劃');
  assert.equal(replan.note,'重新規劃是新計畫，不是單純格式修復。');
});

test('查看原始回傳一直都在',()=>{
  const raw=outputIssueActions(task()).find(a=>a.id==='raw');
  assert.equal(raw.label,'查看原始回傳');
});
