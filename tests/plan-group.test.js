// 方案群組的聚合、篩選與搜尋（src/plan-group.js）。
//
// 這些測試釘住三件最容易出錯、而且出錯了畫面還是「看起來正常」的事：
//   1. 沒有 planGroupId 的舊任務永遠不會被任何規則合併進某個方案。
//   2. 群組 header 的數字永遠是真的，而且不受目前 filter／搜尋影響。
//   3. 狀態優先序：只要有一個任務需要人處理，整個方案就要顯示「需要你處理」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_STATE_PRIORITY,
  UNGROUPED_ID,
  buildPlanGroups,
  filterCounts,
  groupBranch,
  groupSummary,
  taskMatchesFilter,
  taskMatchesQuery,
  taskQueueState,
} from '../src/plan-group.js';

let counter=0;
function task(overrides={}){
  counter+=1;
  return {
    id:`task-${counter}`,
    title:`任務 ${counter}`,
    status:'queued',
    projectName:'Demo',
    ownerName:'Owner',
    planGroupId:null,
    planGroupName:null,
    questions:[],
    threads:[],
    updated:'2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
const GROUP={id:'group-1',name:'結帳流程改版',projectId:'project-1',projectName:'Demo'};

test('任務狀態分類：失敗與「需要你處理」是兩個互斥的數字，已結束的任務不再待處理',()=>{
  assert.equal(taskQueueState(task({status:'completed'})),'completed');
  assert.equal(taskQueueState(task({status:'running'})),'running');
  assert.equal(taskQueueState(task({status:'planning'})),'running');
  assert.equal(taskQueueState(task({status:'queued'})),'queued');
  assert.equal(taskQueueState(task({status:'rate_limited'})),'queued');
  assert.equal(taskQueueState(task({status:'awaiting_approval',plan:{summary:'計畫'}})),'attention');
  assert.equal(taskQueueState(task({status:'waiting_input',questions:['要用哪個 API？']})),'attention');
  // failed 在 attentionCategory 之前判斷，否則同一個任務會同時被算進兩格。
  assert.equal(taskQueueState(task({status:'failed',error:'中斷'})),'failed');
  // 已取消／手動完成的任務即使殘留 pending 旗標，也不該再被算成待處理。
  assert.equal(taskQueueState(task({status:'cancelled',manualAction:{id:'m1',reason:'r'}})),'other');
  assert.equal(taskQueueState(task({status:'completed',outputIssue:{id:'o1'}})),'completed');
  assert.equal(taskQueueState(task({status:'paused'})),'other');
  assert.equal(taskQueueState(null),'other');
});

test('群組狀態優先序：4 completed + 1 running + 1 待核准 → 顯示「需要你處理」',()=>{
  const tasks=[
    ...Array.from({length:4},()=>task({status:'completed'})),
    task({status:'running'}),
    task({status:'awaiting_approval',plan:{summary:'計畫'}}),
  ];
  const summary=groupSummary(tasks);
  assert.equal(summary.total,6);
  assert.equal(summary.completed,4);
  assert.equal(summary.running,1);
  assert.equal(summary.attention,1);
  assert.equal(summary.queued,0);
  assert.equal(summary.failed,0);
  assert.equal(summary.state,'attention');
  assert.equal(summary.stateLabel,'需要你處理');
});

test('群組狀態優先序：Needs Attention > Failed > Running > Queued > Completed',()=>{
  const sample={
    attention:task({status:'awaiting_approval',plan:{summary:'計畫'}}),
    failed:task({status:'failed',error:'中斷'}),
    running:task({status:'running'}),
    queued:task({status:'queued'}),
    completed:task({status:'completed'}),
  };
  // 由高到低逐一拿掉最高優先的那一個，剩下的就應該晉升為群組狀態。
  for(let i=0;i<GROUP_STATE_PRIORITY.length;i+=1){
    const remaining=GROUP_STATE_PRIORITY.slice(i).map(key=>sample[key]);
    assert.equal(groupSummary(remaining).state,GROUP_STATE_PRIORITY[i]);
  }
  assert.equal(groupSummary([]).state,'idle');
  assert.equal(groupSummary([task({status:'cancelled'})]).state,'idle');
});

test('群組的 Git branch 只在整組一致時才顯示，否則寧可不顯示',()=>{
  assert.equal(groupBranch([task({git:{workingBranch:'taskflow/abc'}}),task({git:{workingBranch:'taskflow/abc'}}),task({})]),'taskflow/abc');
  assert.equal(groupBranch([task({git:{workingBranch:'taskflow/abc'}}),task({git:{workingBranch:'taskflow/def'}})]),null);
  assert.equal(groupBranch([task({}),task({git:null})]),null);
  assert.equal(groupBranch([]),null);
});

test('舊任務沒有 planGroupId：歸到「其他任務」，不會被任何規則併入同名同專案的方案',()=>{
  // 兩個舊任務的標題、專案、擁有者都跟方案裡的任務一模一樣——只有 planGroupId 不同。
  // 任何依標題或專案名稱的模糊比對都會在這裡把它們黏起來。
  const grouped=task({title:'結帳流程改版',planGroupId:GROUP.id,planGroupName:GROUP.name,status:'running'});
  const legacyA=task({title:'結帳流程改版',status:'queued'});
  const legacyB=task({title:'結帳流程改版',planGroupId:null,status:'completed'});
  const {groups}=buildPlanGroups([grouped,legacyA,legacyB],[GROUP],{});
  assert.equal(groups.length,2);
  assert.equal(groups[0].id,GROUP.id);
  assert.deepEqual(groups[0].tasks.map(t=>t.id),[grouped.id]);
  // 「其他任務」永遠排在最後，而且是 standalone，不是資料庫裡的方案。
  const other=groups[1];
  assert.equal(other.id,UNGROUPED_ID);
  assert.equal(other.standalone,true);
  assert.equal(other.name,'其他任務');
  assert.deepEqual(other.tasks.map(t=>t.id),[legacyA.id,legacyB.id]);
  assert.equal(other.summary.total,2);
});

test('完全沒有任何方案時，整個佇列就是一個「其他任務」群組',()=>{
  const tasks=[task({status:'running'}),task({status:'completed'})];
  const {groups,totalTaskCount,visibleTaskCount}=buildPlanGroups(tasks,[],{});
  assert.equal(groups.length,1);
  assert.equal(groups[0].id,UNGROUPED_ID);
  assert.equal(totalTaskCount,2);
  assert.equal(visibleTaskCount,2);
});

test('Filter 先作用在 task，再決定哪些 group 顯示；header 的數字不受篩選影響',()=>{
  const done=task({planGroupId:GROUP.id,status:'completed'});
  const running=task({planGroupId:GROUP.id,status:'running'});
  const attention=task({planGroupId:GROUP.id,status:'awaiting_approval',plan:{summary:'計畫'}});
  const otherQueued=task({status:'queued'});
  const tasks=[done,running,attention,otherQueued];

  const completedOnly=buildPlanGroups(tasks,[GROUP],{filter:'completed'});
  // 「其他任務」裡只有 queued，篩「已完成」後一個都不剩，整個群組就不顯示。
  assert.deepEqual(completedOnly.groups.map(g=>g.id),[GROUP.id]);
  assert.deepEqual(completedOnly.groups[0].tasks.map(t=>t.id),[done.id]);
  assert.equal(completedOnly.groups[0].visibleCount,1);
  // 關鍵：header 仍然是 3 個任務、1 個完成，不是「1/1 全部完成」。
  assert.equal(completedOnly.groups[0].summary.total,3);
  assert.equal(completedOnly.groups[0].summary.completed,1);
  assert.equal(completedOnly.groups[0].summary.state,'attention');
  assert.equal(completedOnly.filtered,true);

  assert.deepEqual(buildPlanGroups(tasks,[GROUP],{filter:'running'}).groups.map(g=>g.id),[GROUP.id]);
  assert.deepEqual(buildPlanGroups(tasks,[GROUP],{filter:'queued'}).groups.map(g=>g.id),[UNGROUPED_ID]);
  // 「待處理」包含執行失敗：失敗也要人去看。
  const failed=task({status:'failed',error:'中斷'});
  const withFailure=buildPlanGroups([...tasks,failed],[GROUP],{filter:'attention'});
  assert.deepEqual(withFailure.groups.map(g=>g.id),[GROUP.id,UNGROUPED_ID]);
  assert.deepEqual(withFailure.groups[1].tasks.map(t=>t.id),[failed.id]);
  assert.equal(buildPlanGroups(tasks,[GROUP],{filter:'all'}).filtered,false);
});

test('taskMatchesFilter 與 filterCounts 回報真實數量',()=>{
  const tasks=[
    task({status:'running'}),
    task({status:'queued'}),
    task({status:'completed'}),
    task({status:'failed',error:'中斷'}),
    task({status:'awaiting_approval',plan:{summary:'計畫'}}),
    task({status:'paused'}),
  ];
  assert.deepEqual(filterCounts(tasks),{all:6,running:1,attention:2,queued:1,completed:1});
  assert.equal(taskMatchesFilter(tasks[0],'all'),true);
  assert.equal(taskMatchesFilter(tasks[5],'queued'),false);
  assert.deepEqual(filterCounts([]),{all:0,running:0,attention:0,queued:0,completed:0});
});

test('搜尋命中群組內的任務：群組顯示、只留命中的任務，並標記 autoExpand',()=>{
  const hit=task({planGroupId:GROUP.id,title:'修好付款按鈕',status:'running'});
  const miss=task({planGroupId:GROUP.id,title:'整理文件',status:'queued'});
  const elsewhere=task({title:'別的東西',status:'queued'});
  const {groups,visibleTaskCount}=buildPlanGroups([hit,miss,elsewhere],[GROUP],{query:'付款'});
  assert.equal(groups.length,1);
  assert.deepEqual(groups[0].tasks.map(t=>t.id),[hit.id]);
  assert.equal(groups[0].autoExpand,true);
  assert.equal(groups[0].nameMatched,false);
  // header 仍然說這個方案有 2 個任務。
  assert.equal(groups[0].summary.total,2);
  assert.equal(visibleTaskCount,1);
});

test('搜尋命中方案名稱：整個方案的任務都算命中，且不必自動展開',()=>{
  const a=task({planGroupId:GROUP.id,title:'完全無關的標題',status:'running'});
  const b=task({planGroupId:GROUP.id,title:'也無關',status:'queued'});
  const {groups}=buildPlanGroups([a,b,task({title:'別的'})],[GROUP],{query:'結帳'});
  assert.equal(groups.length,1);
  assert.equal(groups[0].nameMatched,true);
  assert.equal(groups[0].autoExpand,false);
  assert.deepEqual(groups[0].tasks.map(t=>t.id),[a.id,b.id]);
});

test('搜尋同時套用 filter：兩個條件都要成立才留下',()=>{
  const hitRunning=task({planGroupId:GROUP.id,title:'付款流程',status:'running'});
  const hitDone=task({planGroupId:GROUP.id,title:'付款收據',status:'completed'});
  const {groups}=buildPlanGroups([hitRunning,hitDone],[GROUP],{query:'付款',filter:'running'});
  assert.deepEqual(groups[0].tasks.map(t=>t.id),[hitRunning.id]);
  assert.equal(buildPlanGroups([hitRunning,hitDone],[GROUP],{query:'付款',filter:'queued'}).groups.length,0);
});

test('搜尋比對標題、專案、成員與方案名稱，且不分大小寫',()=>{
  const t=task({title:'Fix Login',projectName:'Website',ownerName:'Amy',planGroupName:'登入改版'});
  for(const needle of ['fix','WEBSITE','amy','登入'])assert.equal(taskMatchesQuery(t,needle),true,needle);
  assert.equal(taskMatchesQuery(t,'不存在的字'),false);
  assert.equal(taskMatchesQuery(t,'   '),true);
  assert.equal(taskMatchesQuery(t),true);
});

test('方案沒有被 /api/state 帶回來時，沿用任務上的名稱，而不是拿標題去猜',()=>{
  const orphan=task({planGroupId:'missing-group',planGroupName:'備份還原的方案',title:'某個任務'});
  const {groups}=buildPlanGroups([orphan],[],{});
  assert.equal(groups[0].name,'備份還原的方案');
  const nameless=task({planGroupId:'missing-group-2',planGroupName:null,title:'某個任務'});
  assert.equal(buildPlanGroups([nameless],[],{}).groups[0].name,'未命名方案');
});

test('輸入是 null / undefined 時不會爆掉',()=>{
  assert.deepEqual(buildPlanGroups(undefined,undefined,undefined).groups,[]);
  assert.deepEqual(buildPlanGroups(null,null,{}).groups,[]);
  assert.equal(groupSummary(undefined).total,0);
});
