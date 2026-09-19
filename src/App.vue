<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,reactive,watch,nextTick} from 'vue';
import {useRoute} from 'vue-router';
import {Activity,ArrowDown,ArrowUp,ArrowUpRight,Bell,Check,CheckCheck,ChevronRight,Clock3,FileText,Folder,GitBranch,GripVertical,Inbox,LayoutDashboard,ListTodo,LoaderCircle,LogOut,MessageSquare,MoreHorizontal,Pause,Play,Plus,Search,Settings2,ShieldCheck,Square,Terminal,Workflow,X,ExternalLink,AlertCircle,Download,Users,Radio} from 'lucide-vue-next';
import {useTaskStore,api} from './store';
import {attentionItems} from './attention.js';
import {healthAlert} from './system-health-view.js';
import {AI_MODES,AUTO,CUSTOM,autoModeSummary,resolveEngines,taskEngineDefaults} from './task-defaults.js';
// Task Detail 的資訊分層集中在 src/task-detail-view.js：分頁、待處理清單與
// 進度推導都在那裡，Template 只負責畫出來。沒有任何既有能力被移除。
import {DETAIL_TABS,DEFAULT_TAB,pendingActions,pendingBanner,progressSteps,progressSummary,browserValidations,validationEvidence,publishState,technicalFacts,threadTechnical,threadEvents,taskRuns,runTitle,attemptLabel} from './task-detail-view.js';
// 任務佇列：方案群組化。分組依據只有 task.planGroupId，聚合邏輯全部集中在
// src/plan-group.js（與 attention.js 同一個模式），Template 只負責畫出來。
import {buildPlanGroups} from './plan-group.js';
import TaskPlanGroup from './components/task-queue/TaskPlanGroup.vue';
import TaskQueueItem from './components/task-queue/TaskQueueItem.vue';
import TaskQueueToolbar from './components/task-queue/TaskQueueToolbar.vue';
// 平台設定改成五個分頁；內容在 components/settings/ 底下。原本掛在這裡的
// DirectoryPicker／LineLinks／NotificationManager／SystemHealth／ProjectActions／
// ProjectRemoval 全部都還在，只是移到對應分頁裡，沒有任何設定被拿掉。
import SettingsPage from './components/settings/SettingsPage.vue';
import ExecutionApproval from './ExecutionApproval.vue';
import ValidationSkip from './ValidationSkip.vue';
import ManualAction from './ManualAction.vue';
// Git 守門（未提交修改／分支狀態）的人工確認區塊：以前這個情況只會顯示「需要處理」，
// 沒有任何可以按的動作，任務因此永久卡住。
import GitIssue from './GitIssue.vue';
// 部署與驗收：合併、衝突預檢、清理、rollback 的後端能力早就存在（server/git-review.js），
// 但前端從來沒有呼叫過，使用者因此每次都要自己開 PowerShell 下 git merge。
import Completion from './Completion.vue';
import {shouldLoadReview} from './completion-view.js';
import OutputIssue from './OutputIssue.vue';
// 首次設定精靈：要不要出現由後端算出的設定狀態決定（server/onboarding.js），
// 不用「第一次登入」推測；四個步驟全部沿用既有功能。
import OnboardingWizard from './OnboardingWizard.vue';
import {shouldShowOnboarding} from './onboarding-view.js';
const removalCleanup=ref<string[]>([]);
const store=useTaskStore(),route=useRoute();
// 精靈只在後端說「還沒設定過」時自動開啟；使用者按過「稍後設定」之後，
// 只會由平台設定裡的按鈕手動開啟，不會再自己跳出來。
const wizardOpen=ref(false);
watch(()=>shouldShowOnboarding({user:store.user,onboarding:store.onboarding}),show=>{if(show)wizardOpen.value=true;});
function wizardCreateTask(mode:string){
  newTask.aiMode=mode;
  newTask.projectId=store.user.role==='admin'?'__new__':store.projects[0]?.id||'';
  showNew.value=true;
}
const login=reactive({username:'admin',password:''});const loginError=ref(''),initializing=ref(true),busy=ref(false),toast=ref(''),query=ref(''),filter=ref('all');
const showNew=ref(false),selected=ref<any>(null),tab=ref(DEFAULT_TAB),answer=ref(''),files=ref<any[]>([]),users=ref<any[]>([]);
const detailTabs=DETAIL_TABS;
// 「需要你處理」在詳情頁要一次列出所有同時成立的事情，不像列表只取一個分類。
const detailPending=computed(()=>pendingActions(selected.value));
const detailBanner=computed(()=>pendingBanner(selected.value));
const detailProgress=computed(()=>progressSteps(selected.value));
const detailProgressSummary=computed(()=>progressSummary(selected.value));
const detailEvidence=computed(()=>validationEvidence(selected.value));
const detailBrowser=computed(()=>browserValidations(selected.value));
const detailPublish=computed(()=>publishState(selected.value));
const detailFacts=computed(()=>technicalFacts(selected.value));
// Run／Attempt：由 server/run-attempt.js 純運算算好，這裡只挑要顯示的欄位，
// 不重新定義狀態機（見 task-detail-view.js）。
const detailRuns=computed(()=>taskRuns(selected.value));
// 建立任務表單：預設走「自動選擇」，使用者不必理解 Planner／Executor／Reviewer。
// 三個引擎欄位仍然存在（送出的仍是既有 API 欄位），只是自動模式時由任務類型決定。
// planGroupChoice 只是表單狀態：''＝獨立任務、'__new__'＝建立新方案、其餘是既有方案的 id。
// 送出時才轉成後端真正認得的 planGroupId／planGroupName。
const newTask=reactive({title:'',description:'',projectId:'',type:'code',priority:1,aiMode:AUTO,planner:'claude',executor:'codex',reviewer:'claude',planGroupChoice:'',planGroupName:''});
const showAdvanced=ref(false);
// 方案屬於單一專案，所以只列出目前選到的專案底下的方案；換專案就把選擇清掉，
// 避免把任務送進別的專案的方案（後端也會擋，但不該讓使用者按了才發現）。
const projectPlanGroups=computed(()=>(store.planGroups||[]).filter((g:any)=>g.projectId===newTask.projectId));
watch(()=>newTask.projectId,()=>{newTask.planGroupChoice='';newTask.planGroupName='';});
const suggestedEngines=computed(()=>autoModeSummary(newTask.type));
function applyAutoEngines(){const engines=taskEngineDefaults(newTask.type);newTask.planner=engines.planner;newTask.executor=engines.executor;newTask.reviewer=engines.reviewer;}
// 自動模式跟著任務類型走；自訂模式不覆蓋使用者自己挑的引擎，改用建議文字提示。
watch(()=>newTask.type,()=>{if(newTask.aiMode===AUTO)applyAutoEngines();});
watch(()=>newTask.aiMode,mode=>{if(mode===AUTO)applyAutoEngines();else showAdvanced.value=true;});
const statuses:Record<string,string>={planning:'等待規劃',awaiting_approval:'待審核',queued:'排隊中',running:'執行中',waiting_input:'等待回答',waiting_user_action:'需要你的協助',waiting_git_confirmation:'需要確認 Git 修改',paused:'已暫停',completed:'已完成',repair_planning:'分析修正方案',awaiting_repair_approval:'待審核修正方案',rate_limited:'等待額度恢復',failed:'需要處理',cancelled:'已取消'};
const browserStatuses:Record<string,string>={not_required:'不需要',pending:'待執行',running:'執行中',passed:'通過',failed:'未通過',blocked:'受阻（未驗證）'};
const priorities=['低','一般','高','緊急'];
const nav=[{path:'/',label:'工作總覽',icon:LayoutDashboard},{path:'/attention',label:'待我處理',icon:Inbox},{path:'/tasks',label:'任務佇列',icon:ListTodo},{path:'/threads',label:'角色工作階段',icon:GitBranch},{path:'/settings',label:'平台設定',icon:Settings2}];
const currentNav=computed(()=>nav.find(n=>n.path===route.path)||nav[0]);
// 任務佇列：先用 filter 篩 task，再決定哪些方案群組要顯示；搜尋命中群組內的任務時
// 該群組會自動展開。群組 header 上的數字一律以「群組內所有任務」為母體，不受篩選影響。
const queueView=computed(()=>buildPlanGroups(store.tasks,store.planGroups,{filter:filter.value,query:query.value}));
// 預設全部展開：升級後既有任務都沒有 planGroupId，全部落在「其他任務」，
// 若預設收合，使用者打開佇列會看到一片空白。收合狀態只記在前端，不寫進任何設定。
const collapsedGroups=ref<Set<string>>(new Set());
const groupExpanded=(group:any)=>!collapsedGroups.value.has(group.id);
function toggleGroup(group:any){
  const next=new Set(collapsedGroups.value);
  if(groupExpanded(group))next.add(group.id);else next.delete(group.id);
  collapsedGroups.value=next;
}
// 搜尋命中群組內的任務時（buildPlanGroups 會把該群組標成 autoExpand），
// 就算使用者先前把它收起來也要自動展開，否則會看到一個「有結果但空的」群組。
// 展開之後仍然可以再點 header 收起來——這不是強制展開。
// 只在搜尋字串本身改變時處理，不跟著三秒輪詢跑：否則使用者在搜尋結果裡手動收起的
// 群組會在下一次輪詢被強制打開。
watch(query,value=>{
  if(!value||!collapsedGroups.value.size)return;
  const next=new Set(collapsedGroups.value);
  for(const group of queueView.value.groups)if(group.autoExpand)next.delete(group.id);
  collapsedGroups.value=next;
});
const allExpanded=computed(()=>queueView.value.groups.every(group=>groupExpanded(group)));
function toggleAllGroups(){
  collapsedGroups.value=allExpanded.value?new Set(queueView.value.groups.map(group=>group.id)):new Set();
}
const recentTasks=computed(()=>[...store.tasks].sort((a,b)=>Date.parse(b.updated)-Date.parse(a.updated)).slice(0,6));
// 待我處理：分類邏輯集中在 src/attention.js，頁面與側欄共用同一份結果。
const attention=computed(()=>attentionItems(store.tasks));
// 首頁只在執行環境真的壞掉（error）時提醒，並且不停用任何功能：其他引擎仍可能可用。
const healthWarning=computed(()=>healthAlert(store.health));
const activeThreads=computed(()=>store.tasks.flatMap(t=>t.threads.map((th:any)=>({...th,task:t}))));
const completed=computed(()=>store.tasks.filter(t=>t.status==='completed').length);
const time=(value:string)=>value?new Intl.DateTimeFormat('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'—';
const duration=(th:any)=>`${Math.max(0,Math.round(((th.finished?new Date(th.finished).getTime():Date.now())-new Date(th.started).getTime())/60000))} 分鐘`;
const percent=(t:any)=>t.status==='completed'?100:t.totalSteps?Math.round(t.completedSteps/t.totalSteps*100):0;
// 標題列的狀態一律沿用後端算好的 displayStatus（server/task-status.js 的優先序：
// cancelled／completed 永遠贏過待處理項目），避免出現「任務已取消卻寫著待我處理」，
// 也避免 Git 被擋住時只顯示「等待規劃」。
const statusLabel=(t:any)=>t.status==='completed'&&t.manualCompletion?'手動完成':statuses[t.displayStatus||t.status]||statuses[t.status]||t.status;
let interval:ReturnType<typeof setInterval>,toastTimer:ReturnType<typeof setTimeout>;
function notify(message:string){toast.value=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.value='',6000);}
async function run(fn:()=>Promise<any>){if(busy.value)return;busy.value=true;try{await fn();await store.refresh();if(selected.value)await loadTask(selected.value.id);}catch(e:any){notify(e.message);}finally{busy.value=false;}}
async function projectRemoved(projectId:string,pendingCleanup:string[]=[]){removalCleanup.value=pendingCleanup;if(selected.value?.projectId===projectId)selected.value=null;if(newTask.projectId===projectId)newTask.projectId='__new__';users.value=await api('/admin/users');notify(pendingCleanup.length?'專案已移除，部分磁碟檔案尚待清理':'專案及磁碟檔案已移除');}
async function signIn(){loginError.value='';try{await api('/login',login);login.password='';await store.refresh();void store.loadHealth();}catch(e:any){loginError.value=e.message;}}
async function loadTask(id:string){selected.value=await api('/tasks/'+id);}
// 成果報告不完整的三個操作。recoverOutput 只呼叫 deterministic recovery 的 endpoint，
// 它不會（也不能）要求任何引擎重新執行工作。
const outputRaw=ref<any>(null),outputRecovery=ref<any>(null);
// 部署與驗收的 Git 現況。/git/review 會實際執行 git 指令（讀 commit、讀正式分支狀態），
// 所以絕不能放進三秒一次的 /state 輪詢——只在開啟任務、完成合併或使用者按重新讀取時取一次。
const gitReview=ref<any>(null),reviewLoading=ref(false),reviewLoadedFor=ref<string|null>(null);
async function loadReview(){
  if(!selected.value||!shouldLoadReview(selected.value)){gitReview.value=null;return;}
  const taskId=selected.value.id;
  // 先記下「這個任務已經試著讀過了」，失敗也算：否則下面的 watch 會在每次失敗後立刻重試，
  // 變成一邊跳錯誤訊息一邊不停跑 git 指令。要重試請按「重新讀取 Git 狀態」。
  reviewLoadedFor.value=taskId;
  reviewLoading.value=true;
  try{const review=await api(`/tasks/${taskId}/git/review`);if(selected.value?.id===taskId)gitReview.value=review;}
  catch(e:any){gitReview.value=null;notify(e.message);}
  finally{reviewLoading.value=false;}
}
// 測試比對只是「開始」：整套測試要跑好幾分鐘，結果由既有的三秒輪詢帶回來（completionTest 欄位）。
async function completionTest(){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/test`,{});notify('已開始測試比對；整套測試可能需要數分鐘，結果會自動更新。');});
}
// 合併後在正式分支重測：分支比對通過不代表合併後也通過。
async function completionTestMain(){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/test-main`,{});notify('已開始合併後重測；結果會自動更新。');});
}
// 推送遠端：唯一會影響本機以外的動作，所以一律由使用者明確按下，預設不在流程裡。
async function completionPush(){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/push`,{});notify('已推送至遠端。');});
  await loadReview();
}
// 一次核准：只建立狀態機並記錄核准，實際推進由後端固定間隔的 tick 負責。
// 重啟階段會殺掉那個行程，所以狀態存在任務資料裡，新的行程開機後會自己接著跑。
async function completionApprove(options:{testMain:boolean;restart:boolean;validate:boolean;push:boolean;cleanup:boolean}){
  if(!selected.value)return;
  const taskId=selected.value.id,artifactVersion=selected.value.artifactVersion;
  await run(async()=>{await api(`/tasks/${taskId}/completion/approve`,{artifactVersion,options});notify('已核准部署流程；每個階段的進度會自動更新。');});
  await loadReview();
}
async function completionRetry(completionId:string){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/retry`,{completionId});notify('已從失敗的階段重新開始；已完成的階段不會重做。');});
  await loadReview();
}
async function completionCancel(completionId:string){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/cancel`,{completionId});notify('已停止部署流程；已完成的階段保留不變。');});
  await loadReview();
}
// 部署驗收：建立 Preview、驗 API、停掉它並確認 PID 消失。同樣只送出「開始」。
async function completionValidate(){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/validate`,{});notify('已開始部署驗收；建立 Preview 與建置需要一點時間，結果會自動更新。');});
}
// 重新啟動正式 TaskFlow：這裡只送出核准，實際動手的是獨立的守護程式（主 server 不能自己殺自己）。
// 重啟期間這個頁面可能短暫連不上，狀態由既有輪詢帶回來（completionRestart 欄位）。
async function completionRestart(){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/completion/restart`,{});notify('已核准重新啟動；守護程式會先建置再重啟，期間網頁可能短暫中斷。');});
}
// 合併與撤銷都走既有 endpoint；成敗都重讀一次 Git 現況，畫面才不會停在舊狀態。
async function completionMerge(options:{cleanup:boolean}){
  if(!selected.value)return;
  const taskId=selected.value.id,artifactVersion=selected.value.artifactVersion;
  await run(async()=>{await api(`/tasks/${taskId}/git/decision`,{decision:'merge',artifactVersion,cleanup:options.cleanup});notify('已合併至正式分支');});
  await loadReview();
}
async function completionRollback(mergeCommit:string){
  if(!selected.value)return;
  const taskId=selected.value.id;
  await run(async()=>{await api(`/tasks/${taskId}/git/rollback`,{mergeCommit});notify('已撤銷合併；歷史完整保留，未刪除任何 commit');});
  await loadReview();
}
async function openTask(t:any){tab.value=DEFAULT_TAB;answer.value='';files.value=[];outputRaw.value=null;outputRecovery.value=null;gitReview.value=null;reviewLoadedFor.value=null;await run(()=>loadTask(t.id));await loadReview();}
// 任務有可能在詳情開著的時候才跑完；輪詢只讀 /state，不碰 /git/review，所以這裡補讀一次。
// 條件包含任務 id，換任務時會重新判斷；同一個任務只會自動讀一次。
watch(()=>selected.value&&shouldLoadReview(selected.value)&&reviewLoadedFor.value!==selected.value.id,need=>{if(need)void loadReview();});
async function recoverOutput(){
  if(!selected.value)return;
  const taskId=selected.value.id,issueId=selected.value.outputIssue?.id;
  outputRecovery.value=null;
  await run(async()=>{
    const result=await api(`/tasks/${taskId}/output/recover`,{issueId});
    outputRecovery.value=result.recovery;outputRaw.value=null;
    notify(result.recovery?.ok?'成果報告已重新整理，沒有重新執行任何工作':'重新整理成果報告未成功；成果報告問題與已完成進度都保留');
  });
}
async function loadOriginalOutput(){
  if(!selected.value)return;
  outputRaw.value=null;
  try{outputRaw.value=await api(`/tasks/${selected.value.id}/output/original`);}catch(e:any){notify(e.message);}
}
// 指名 .revise-input：概覽裡還有 manual action／修正方案的表單，抓「第一個 textarea」會跳錯地方。
function focusRevise(){tab.value='overview';void nextTick(()=>{const field=document.querySelector<HTMLTextAreaElement>('.drawer .revise-input');field?.scrollIntoView({block:'center'});field?.focus();});}
async function action(name:string){if(!selected.value)return;await run(async()=>{await api(`/tasks/${selected.value.id}/action`,{action:name,artifactVersion:selected.value.artifactVersion});notify(name==='publish-approve'?'此版成果已核准；尚未對外發布':'任務狀態已更新');});}
// 明確列出送出的欄位：aiMode 只是表單狀態，不屬於 Task Schema，不送到後端。
async function create(){await run(async()=>{const newGroup=newTask.planGroupChoice==='__new__';const t=await api('/tasks',{title:newTask.title,description:newTask.description,type:newTask.type,priority:newTask.priority,...resolveEngines(newTask),projectId:newTask.projectId==='__new__'?undefined:newTask.projectId,createProject:newTask.projectId==='__new__',
  // 方案：只送明確的 id（既有方案）或名稱（新方案）。兩者都沒有就是獨立任務。
  planGroupId:newGroup||!newTask.planGroupChoice?undefined:newTask.planGroupChoice,planGroupName:newGroup?newTask.planGroupName.trim():undefined});showNew.value=false;newTask.title='';newTask.description='';newTask.planGroupChoice='';newTask.planGroupName='';selected.value=await api('/tasks/'+t.id);tab.value='overview';notify('任務已建立');});}
async function setTaskStatus(t:any,event:Event){const select=event.target as HTMLSelectElement;const status=select.value;select.value=t.status;await run(async()=>{await api(`/tasks/${t.id}/status`,{status,expectedStatus:t.status});notify(status==='completed'?'任務已手動完成':'任務狀態已更新');});}
async function setPriority(t:any,event:Event){await run(()=>api(`/tasks/${t.id}/priority`,{priority:Number((event.target as HTMLSelectElement).value)}));}
async function reorder(t:any,direction:number){const list=store.tasks.filter(x=>x.priority===t.priority&&(store.user.role==='admin'||x.ownerId===store.user.id));const i=list.findIndex(x=>x.id===t.id),next=i+direction;if(next<0||next>=list.length)return;[list[i],list[next]]=[list[next],list[i]];await run(()=>api('/reorder',{ids:list.map(x=>x.id)}));}
const dragging=ref<string|null>(null);
const overlay=computed(()=>showNew.value?'new':selected.value?'detail':'none');let previousFocus:HTMLElement|null=null;
watch(overlay,async(value,old)=>{if(old==='none')previousFocus=document.activeElement as HTMLElement;await nextTick();if(value==='none'){previousFocus?.focus();return;}const container=document.querySelector(value==='new'?'.modal':'.drawer');(container?.querySelector('[autofocus],button,input,select,textarea,a[href]') as HTMLElement)?.focus();});
function keyboard(event:KeyboardEvent){if(overlay.value==='none')return;if(event.key==='Escape'){if(showNew.value)showNew.value=false;else selected.value=null;return;}if(event.key!=='Tab')return;const container=document.querySelector(overlay.value==='new'?'.modal':'.drawer');const nodes=Array.from(container?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary')||[]).filter(el=>el.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
async function drop(target:any){const source=store.tasks.find(t=>t.id===dragging.value);dragging.value=null;if(!source||source.id===target.id)return;if(source.priority!==target.priority){notify('拖曳可調整相同優先級的任務；跨級請使用優先級選單。');return;}const list=store.tasks.filter(t=>t.priority===target.priority);const moved=list.splice(list.findIndex(t=>t.id===source.id),1)[0];list.splice(list.findIndex(t=>t.id===target.id),0,moved);await run(()=>api('/reorder',{ids:list.map(t=>t.id)}));}
watch(()=>newTask.type,type=>{newTask.executor=type==='research'?'claude':'codex';newTask.reviewer=type==='research'?'codex':'claude';});
watch(()=>route.path,async p=>{filter.value='all';query.value='';if(p==='/settings'&&store.user)void store.loadHealth();if(p==='/settings'&&store.user?.role==='admin')try{users.value=await api('/admin/users');}catch(e:any){notify(e.message);}});
watch(tab,async v=>{if(v==='results'&&selected.value)try{files.value=(await api(`/tasks/${selected.value.id}/artifacts`)).files;}catch(e:any){notify(e.message);}});
onMounted(async()=>{document.addEventListener('keydown',keyboard);try{await store.refresh();if(route.path==='/settings'&&store.user?.role==='admin')users.value=await api('/admin/users');}catch{}finally{initializing.value=false;}if(store.user)void store.loadHealth();
  // 每 3 秒的輪詢只讀取 /state；系統狀態不在其中，才不會持續 spawn CLI。
  interval=setInterval(async()=>{if(!store.user||busy.value)return;try{await store.refresh();if(selected.value)await loadTask(selected.value.id);}catch{}},3000);
  const context=(document as any).modelContext;if(context?.registerTool)Promise.resolve(context.registerTool({name:'start_task_creation',description:'Open the task creation form. Does not submit or execute a task.',inputSchema:{type:'object',properties:{},additionalProperties:false},execute:()=>{if(!store.user)throw new Error('Sign in first');newTask.projectId=store.user.role==='admin'?'__new__':store.projects[0]?.id||'';showNew.value=true;return {opened:true};}})).catch(()=>{});
});
onUnmounted(()=>{clearInterval(interval);clearTimeout(toastTimer);document.removeEventListener('keydown',keyboard);});
</script>

<template>
  <div v-if="removalCleanup.length" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="磁碟清理未完成"><h2>部分磁碟檔案尚未刪除</h2><p>專案紀錄已移除，但下列檔案仍被占用。請關閉占用程式後清理這些資料夾；不要視為磁碟清理已完成。</p><ul><li v-for="path in removalCleanup" :key="path" style="overflow-wrap:anywhere">{{path}}</li></ul><button class="secondary" @click="removalCleanup=[]">我知道了</button></section></div>
  <OnboardingWizard v-if="wizardOpen && store.user?.role==='admin'" @close="wizardOpen=false" @create-task="wizardCreateTask"/>
  <div v-if="initializing" class="loading-screen"><LoaderCircle class="spin"/> 正在連接本地工作台</div>
  <main v-else-if="!store.user" class="login-screen">
    <div class="login-brand"><div class="brand-icon"><Workflow :size="28"/></div><h1>TaskFlow<span>LOCAL WORKSPACE</span></h1><p>從一個想法，到可驗證的成果。</p><div class="login-line"><span>需求</span><ChevronRight/><span>分工</span><ChevronRight/><span>驗證</span></div></div>
    <form class="login-card" @submit.prevent="signIn"><span class="eyebrow">YOUR WORKSPACE</span><h2>登入工作台</h2><p class="muted">掌握任務、角色與每一步進展。</p><label>帳號<input v-model="login.username" autocomplete="username" required></label><label>密碼<input v-model="login.password" type="password" autocomplete="current-password" required></label><p v-if="loginError" class="error-text" role="alert">{{loginError}}</p><button class="primary">登入 <ArrowUpRight :size="18"/></button><small>首次登入資訊：本機 data/first-login.txt</small></form>
  </main>
  <div v-else class="app-shell">
    <aside class="sidebar"><a class="brand" href="/"><div class="brand-icon"><Workflow :size="22"/></div><div>TaskFlow<small>LOCAL WORKSPACE</small></div></a><div class="workspace-tag"><span class="workspace-avatar">T</span><div>AI 協作空間<small>Windows 本地工作台</small></div></div><div class="nav-label">工作空間</div><nav><RouterLink v-for="n in nav" :key="n.path" :to="n.path" :class="{active:route.path===n.path}"><component :is="n.icon" :size="19"/>{{n.label}}<span v-if="n.path==='/tasks'" class="nav-count">{{store.tasks.length}}</span><span v-if="n.path==='/attention'&&attention.length" class="nav-count attention" :aria-label="`待我處理 ${attention.length} 件`">{{attention.length}}</span></RouterLink></nav><div class="sidebar-bottom"><div class="runner-mini"><Radio :size="17"/><div>{{store.runner.enabled?'任務服務已啟用':'任務服務已暫停'}}<small>{{store.runner.busy?'正在處理任務':store.runner.enabled?'等待下一筆工作':'前往設定啟用 AI 執行'}}</small></div></div><div class="profile"><span class="avatar">{{store.user.name.slice(0,1)}}</span><div>{{store.user.name}}<small>{{store.user.role==='admin'?'工作空間管理者':'工作空間成員'}}</small></div><button class="icon-button" title="登出" @click="run(async()=>{await api('/logout',{});store.user=null;selected=null;})"><LogOut :size="17"/></button></div></div></aside>
    <div class="main-shell"><header class="topbar"><div class="breadcrumb">工作空間 <ChevronRight :size="14"/> <strong>{{currentNav.label}}</strong></div><div class="topbar-right"><span class="connection" :class="{offline:store.offline}"><i/>{{store.offline?'連線中斷':'本地已連線'}}</span><button class="icon-button" title="查看待我處理" @click="$router.push('/attention')"><Bell :size="19"/><span v-if="attention.length" class="notification-dot"/></button><span class="avatar small">{{store.user.name.slice(0,1)}}</span></div></header>
    <main class="content" :class="{'content-settings':route.path==='/settings'}">
      <div v-if="store.offline" class="notice warning"><AlertCircle :size="18"/>無法連接本機服務。目前顯示最後讀取的資料，恢復連線後會更新。</div>
      <div class="page-heading"><div><span class="eyebrow">{{route.path==='/settings'?'WORKSPACE SETTINGS':route.path==='/threads'?'AGENT ACTIVITY':route.path==='/attention'?'NEEDS YOUR ATTENTION':'MISSION CONTROL'}}</span><h1>{{currentNav.label}}</h1><p>{{route.path==='/'?'讓想法持續推進，每一步都有跡可循。':route.path==='/attention'?'這裡只顯示目前需要你做決定或操作的任務。':route.path==='/tasks'?'安排下一步工作，讓重要的任務先開始。':route.path==='/threads'?'每個角色專注自己的工作，所有進展集中於此。':'管理成員、專案與本機執行服務。'}}</p></div><button v-if="route.path!=='/settings'" class="primary" @click="showNew=true;newTask.projectId=store.user.role==='admin'?'__new__':store.projects[0]?.id||''"><Plus :size="18"/>發布任務</button></div>
      <template v-if="route.path==='/'">
        <div v-if="healthWarning" class="notice error health-alert"><i class="health-mark">✗</i><div class="grow"><strong>{{healthWarning.title}}</strong><p v-for="line in healthWarning.messages" :key="line">{{line}}</p></div><RouterLink to="/settings" class="secondary compact">{{healthWarning.action}}</RouterLink></div>
        <section class="metrics"><div class="metric"><span>進行中的任務 <Activity :size="18"/></span><strong>{{store.tasks.filter(t=>['running','queued','planning'].includes(t.status)).length.toString().padStart(2,'0')}}</strong><small>{{store.runner.busy?'AI 正在工作':'等待下一次派工'}}</small></div><div class="metric"><span>需要你的決定 <MessageSquare :size="18"/></span><strong class="amber">{{attention.length.toString().padStart(2,'0')}}</strong><small>審核、問題與異常</small></div><div class="metric"><span>已完成任務 <CheckCheck :size="18"/></span><strong>{{completed.toString().padStart(2,'0')}}</strong><small>含驗證完成與手動完成</small></div><div class="metric"><span>工作階段 <GitBranch :size="18"/></span><strong>{{activeThreads.length.toString().padStart(2,'0')}}</strong><small>{{activeThreads.filter(t=>t.status==='running').length}} 個正在執行</small></div></section>
        <section v-if="!store.projects.length" class="onboarding"><div class="onboarding-icon"><Folder :size="30"/></div><div><span class="eyebrow">FIRST STEP</span><h2>為第一個任務準備工作空間</h2><p>{{store.user.role==='admin'?'新增一個本機專案，就能發布需求、審核計畫並追蹤 AI 工作。':'請管理者為你分配專案，接著就能建立第一個任務。'}}</p></div><RouterLink v-if="store.user.role==='admin'" to="/settings" class="secondary">設定專案 <ArrowUpRight :size="17"/></RouterLink></section>
        <div class="overview-grid"><section class="panel"><div class="section-heading"><h2>任務動態 <span class="count">{{store.tasks.length}}</span></h2><RouterLink to="/tasks">所有任務 <ArrowUpRight :size="16"/></RouterLink></div><div v-if="!store.tasks.length" class="empty"><div class="empty-icon"><ListTodo :size="30"/></div><h3>下一個成果，從這裡開始</h3><p>描述你想完成的事情，AI 會先整理計畫，<br>經你審核後才開始執行。</p><button class="secondary" @click="showNew=true;newTask.projectId=store.user.role==='admin'?'__new__':store.projects[0]?.id||''"><Plus :size="16"/>建立第一個任務</button></div><button v-for="t in recentTasks" :key="t.id" class="activity-row" @click="openTask(t)"><span class="task-symbol"><FileText v-if="t.type==='research'" :size="19"/><Terminal v-else :size="19"/></span><div class="grow"><strong>{{t.title}}</strong><small>{{t.projectName}} · {{t.ownerName}}</small><small v-if="t.status==='rate_limited'">預計重試：{{time(t.retryAt)}}</small></div><span class="badge" :class="t.displayStatus||t.status">{{statusLabel(t)}}</span><ChevronRight :size="16"/></button></section>
        <div class="right-stack"><section class="panel attention-panel"><div class="section-heading"><h2>需要你的處理 <span class="count">{{attention.length}}</span></h2><RouterLink v-if="attention.length" to="/attention">查看全部 <ArrowUpRight :size="16"/></RouterLink></div><div v-if="!attention.length" class="quiet"><ShieldCheck :size="28"/><h3>目前沒有需要你處理的事項。</h3><p>需要審核、補充或本機操作時，會集中顯示在這裡。</p></div><template v-else><p class="attention-lead">目前有 {{attention.length}} 個任務等待你的決定或操作。</p><button v-for="item in attention.slice(0,4)" :key="item.task.id" class="attention-item" @click="openTask(item.task)"><strong>{{item.task.title}}</strong><span>{{item.category.title}} <ArrowUpRight :size="15"/></span></button></template></section><section class="panel connections"><h2>服務連線</h2><div><span><Terminal :size="17"/> AI 執行服務</span><span class="badge" :class="store.runner.enabled?'completed':'paused'">{{store.runner.enabled?'已啟用':'已暫停'}}</span></div><div><span><Activity :size="17"/> Browser MCP（Playwright）</span><span class="badge" :class="store.integrations.browser?.available?'completed':'paused'">{{store.integrations.browser?.available?'MCP 已連線':'未就緒'}}</span></div><p v-if="store.integrations.browser?.available" class="subtle">MCP 連線正常，不代表每次任務都已實際完成瀏覽器驗證；請於任務詳情查看個別 Browser 驗證結果。</p><p v-if="!store.integrations.browser?.available&&store.integrations.browser?.error" class="error-text">{{store.integrations.browser.error}}</p><div><span><MessageSquare :size="17"/> LINE 收件匣</span><span class="badge" :class="store.integrations.lastSync&&!store.integrations.error?'completed':'paused'">{{store.integrations.lastSync&&!store.integrations.error?'已連線':store.integrations.lineConfigured?'待同步':'未設定'}}</span></div><div><span>LINE 通知</span><span class="badge" :class="store.integrations.notificationError?'failed':'completed'">{{store.integrations.notificationError?'傳送失敗':store.integrations.pendingNotifications?'等待傳送':'無待送通知'}}</span></div><p v-if="store.integrations.notificationError" class="error-text">{{store.integrations.notificationError}} · {{store.integrations.pendingNotifications}} 則尚未送出。收件連線正常不代表通知已送達。</p><p>本機關機後，AI 工作暫停；雲端收件需完成連線設定。</p></section></div></div>
      </template>
      <template v-else-if="route.path==='/attention'">
        <section v-if="!attention.length" class="panel empty"><div class="empty-icon"><ShieldCheck :size="30"/></div><h3>目前沒有需要你處理的事項。</h3><p>需要確認計畫、回答問題或在本機操作時，<br>任務會自動出現在這裡。</p><RouterLink to="/tasks" class="secondary">查看任務佇列 <ArrowUpRight :size="16"/></RouterLink></section>
        <div v-else class="attention-list"><article v-for="item in attention" :key="item.task.id" class="panel attention-card" :class="item.category.type"><div class="attention-card-head"><span class="attention-project"><Folder :size="15"/>{{item.task.projectName}}</span><small>最後更新 {{time(item.task.updated)}}</small></div><h3>{{item.task.title}}</h3><p class="attention-kind"><AlertCircle :size="16"/>{{item.category.title}}</p><p class="attention-reason">{{item.category.reason||item.category.description}}</p><div class="attention-card-foot"><button class="primary compact" :disabled="busy" @click="openTask(item.task)">{{item.category.action}} <ArrowUpRight :size="16"/></button><small>{{item.task.ownerName}}</small></div></article></div>
      </template>
      <template v-else-if="route.path==='/tasks'">
        <TaskQueueToolbar
          :filter="filter"
          :query="query"
          :tasks="store.tasks"
          :all-expanded="allExpanded"
          @update:filter="filter=$event"
          @update:query="query=$event"
          @toggle-all="toggleAllGroups"
        />
        <div class="queue-note"><GripVertical :size="16"/>任務依方案群組；拖曳可調整同優先級的派工順序，正在執行的工作不會被中斷。</div>
        <section v-if="!queueView.groups.length" class="panel empty">
          <div class="empty-icon"><ListTodo :size="30"/></div>
          <h3>{{store.tasks.length?'沒有符合條件的任務':'任務佇列還是空的'}}</h3>
          <p>{{store.tasks.length?'換個篩選條件或清除搜尋，就能看到其他方案。':'發布任務後，可以在這裡安排順序和追蹤進展。'}}</p>
        </section>
        <div v-else class="plan-group-list">
          <TaskPlanGroup
            v-for="group in queueView.groups"
            :key="group.id"
            :group="group"
            :expanded="groupExpanded(group)"
            @toggle="toggleGroup(group)"
          >
            <div class="task-table-head"><span>任務 / 專案</span><span>狀態</span><span>子任務進度</span><span>優先級</span><span>排序</span></div>
            <TaskQueueItem
              v-for="t in group.tasks"
              :key="t.id"
              :task="t"
              :busy="busy"
              :status-label="statusLabel(t)"
              :priorities="priorities"
              :dragging="dragging===t.id"
              @open="openTask(t)"
              @status="setTaskStatus(t,$event)"
              @priority="setPriority(t,$event)"
              @reorder="reorder(t,$event)"
              @dragstart="dragging=t.id"
              @drop="drop(t)"
            />
          </TaskPlanGroup>
        </div>
      </template>
      <template v-else-if="route.path==='/threads'">
        <div class="notice"><GitBranch :size="18"/>各角色保有獨立的工作紀錄；第一版依任務優先序逐一執行，避免共用檔案互相覆寫。</div><section v-if="!activeThreads.length" class="panel empty"><GitBranch :size="32"/><h3>尚未建立工作階段</h3><p>啟用 AI 服務並發布任務後，角色會出現在這裡。</p></section><div class="thread-grid"><button v-for="th in [...activeThreads].reverse()" :key="th.id" class="thread-card" @click="openTask(th.task);tab='technical'"><div class="thread-card-top"><span class="engine-mark">{{th.engine==='codex'?'C':'A'}}</span><span class="badge" :class="th.displayStatus||th.status">{{th.statusLabel||statuses[th.status]||th.status}}</span></div><h3>{{th.role}}</h3><p>{{th.task.title}}</p><div class="thread-meta"><span>{{th.engine==='codex'?'Codex':'Claude Code'}}</span><span><Clock3 :size="14"/>{{duration(th)}}</span></div><div class="thread-summary">{{th.summary||th.error||'等待引擎回傳工作結果'}}</div></button></div>
      </template>
      <template v-else-if="route.path==='/settings'">
        <SettingsPage
          :busy="busy"
          :users="users"
          :run="run"
          :notify="notify"
          @open-wizard="wizardOpen=true"
          @project-removed="projectRemoved"
          @reload-users="run(async()=>{users=await api('/admin/users');})"
        />
      </template>
      <footer class="page-footer"><span>TaskFlow / 本地優先，進度透明</span><span>每 3 秒同步 · {{store.projects.length}} 個專案</span></footer>
    </main></div>
  </div>
  <div v-if="showNew" class="modal-backdrop" @click.self="showNew=false"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><header><div><span class="eyebrow">NEW TASK</span><h2 id="create-title">你想完成什麼？</h2></div><button class="icon-button" title="關閉" @click="showNew=false"><X/></button></header><form @submit.prevent="create"><label>任務標題<input v-model="newTask.title" placeholder="用一句話描述預期成果" minlength="2" maxlength="140" required autofocus></label><div class="form-grid"><label>所屬專案<select v-model="newTask.projectId" required><option v-if="store.user.role==='admin'" value="__new__">依任務標題建立新專案（預設）</option><option disabled value="">選擇專案</option><option v-for="p in store.projects" :key="p.id" :value="p.id">{{p.name}}</option></select></label><label>任務類型<select v-model="newTask.type"><option value="code">程式開發</option><option value="research">研究與文件</option></select></label></div><p v-if="newTask.projectId==='__new__'" class="subtle">送出時在 {{store.defaultProjectRoot||'尚未設定的預設位置'}} 建立新專案。名稱使用任務標題；特殊字元會轉換，同名時加上編號。</p>
      <!-- 方案：任務佇列的分組依據。不填就是獨立任務，TaskFlow 不會依標題把它塞進任何方案。 -->
      <label>方案（選填）<select v-model="newTask.planGroupChoice"><option value="">獨立任務，不歸入方案</option><option v-for="g in projectPlanGroups" :key="g.id" :value="g.id">{{g.name}}</option><option value="__new__">建立新方案…</option></select></label>
      <label v-if="newTask.planGroupChoice==='__new__'">新方案名稱<input v-model="newTask.planGroupName" placeholder="例如：結帳流程改版" minlength="2" maxlength="80" required></label>
      <p v-if="newTask.planGroupChoice" class="subtle">同一個方案的任務會在任務佇列裡收在一起，方案的完成度由這些任務的真實狀態算出來。</p><label>需求與驗收期待<textarea v-model="newTask.description" rows="5" minlength="5" maxlength="16000" placeholder="描述背景、需要完成的事情、限制與如何確認成功。也可以貼上參考連結。" required/></label><div class="ai-mode"><span class="field-label">AI 模式</span><div class="choice-row"><label v-for="mode in AI_MODES" :key="mode.value" class="choice"><input v-model="newTask.aiMode" type="radio" name="ai-mode" :value="mode.value">{{mode.label}}</label></div><p class="subtle">{{newTask.aiMode===AUTO?`TaskFlow 會依任務類型自動安排規劃、執行與驗證模型：${suggestedEngines}`:`此類型的建議安排：${suggestedEngines}。可在下方進階設定調整。`}}</p></div>
      <button type="button" class="advanced-toggle" :aria-expanded="showAdvanced" @click="showAdvanced=!showAdvanced"><ChevronRight :size="16" :class="{open:showAdvanced}"/>進階設定</button>
      <div v-if="showAdvanced" class="form-grid advanced-panel"><label>優先級<select v-model="newTask.priority"><option v-for="(p,i) in priorities" :key="i" :value="i">{{p}}</option></select></label><template v-if="newTask.aiMode===CUSTOM"><label>規劃<select v-model="newTask.planner"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>執行<select v-model="newTask.executor"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><label>驗證<select v-model="newTask.reviewer"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label></template></div><div class="notice"><ShieldCheck :size="18"/>AI 先整理計畫，經你核准後才執行。</div><div class="modal-actions"><button type="button" class="secondary" @click="showNew=false">取消</button><button class="primary" :disabled="busy||(!newTask.projectId)||(newTask.projectId==='__new__'&&!store.defaultProjectRoot)"><Plus :size="17"/>發布任務</button></div><p v-if="!store.projects.length&&store.user.role!=='admin'" class="error-text">請先在設定中新增或取得專案授權。</p></form></section></div>
  <!-- Task Detail：資訊分層為「概覽 / 執行進度 / 成果 / 技術資訊」。
       概覽只放一般使用者需要的東西，所有 Agent／Developer 的原始資料集中到技術資訊，
       但沒有任何能力被移除：manual action、validation skip、execution approval、
       repair approval、artifact、event 都還在，只是換了位置。 -->
  <div v-if="selected" class="drawer-backdrop" @click.self="selected=null"><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header class="drawer-header"><span class="eyebrow">TASK / {{selected.id.slice(0,8)}}</span><button class="icon-button" title="關閉詳情" @click="selected=null"><X/></button></header><div class="drawer-title"><span class="badge" :class="selected.displayStatus||selected.status">{{statusLabel(selected)}}</span><h2 id="detail-title">{{selected.title}}</h2><p>{{selected.projectName}} · {{selected.ownerName}} · {{time(selected.created)}}</p></div>
    <div class="drawer-tabs"><button v-for="item in detailTabs" :key="item.id" :class="{active:tab===item.id}" @click="tab=item.id">{{item.label}}<span v-if="item.id==='overview'&&detailPending.length" class="tab-count" :aria-label="`${detailPending.length} 件待處理`">{{detailPending.length}}</span></button></div>
    <div class="drawer-body">
      <!-- 待處理的事情只在概覽提供操作；其他分頁給一個回得去的提示，不重複做一套按鈕。 -->
      <button v-if="detailBanner&&tab!=='overview'" type="button" class="detail-banner" @click="tab='overview'"><AlertCircle :size="17"/><span class="grow">{{detailBanner.message}}</span><span class="detail-banner-action">{{detailBanner.action}} <ArrowUpRight :size="15"/></span></button>

      <!-- 概覽 -->
      <template v-if="tab==='overview'">
        <section v-if="detailPending.length" class="pending-actions" aria-label="需要你處理的事情"><h3><AlertCircle :size="17"/>需要你處理（{{detailPending.length}}）</h3><ul><li v-for="item in detailPending" :key="item.id"><strong>{{item.title}}</strong><small>{{item.description}}</small></li></ul><p class="subtle">以下依序列出可以處理的區塊。</p></section>
        <ManualAction :request="selected.manualAction" :skips="selected.manualActionSkips" :busy="busy" @decide="(decision,note)=>run(()=>api(`/tasks/${selected.id}/user-action/decision`,{requestId:selected.manualAction.id,decision,note}))"/>
        <GitIssue :task="selected" :busy="busy" @decide="action=>run(()=>api(`/tasks/${selected.id}/git/recheck`,{issueId:selected.gitRequest.requestId,action}))"/>
        <section v-if="selected.environmentIssue" class="questions"><h3>套件環境處理方案待審核</h3><p class="prewrap">{{selected.environmentIssue.message}}</p><button v-if="selected.status==='waiting_input'" class="primary" :disabled="busy" @click="run(()=>api(`/tasks/${selected.id}/preflight/retry`,{issueId:selected.environmentIssue.id}))">環境已處理，核准重新檢查</button><p>檢查通過才繼續已核准的步驟；更換套件須在下方補充需求並重新審核計畫。</p></section>
        <OutputIssue :task="selected" :busy="busy" :raw="outputRaw" :recovery="outputRecovery" @recover="recoverOutput" @raw="loadOriginalOutput" @replan="focusRevise"/>
        <ValidationSkip :request="selected.validationSkipRequest" :skips="selected.validationSkips" :busy="busy" @decide="decision=>run(()=>api(`/tasks/${selected.id}/validation/decision`,{requestId:selected.validationSkipRequest.id,decision}))"/>
        <ExecutionApproval v-if="selected.executionApproval" :request="selected.executionApproval" :busy="busy" @decide="decision=>run(()=>api(`/tasks/${selected.id}/execution/decision`,{requestId:selected.executionApproval.id,decision}))"/>
        <!-- 部署與驗收：核准合併、清理與撤銷都在這裡完成，不需要再開 PowerShell。 -->
        <Completion :task="selected" :review="gitReview" :busy="busy" :loading="reviewLoading" @refresh="loadReview" @test="completionTest" @test-main="completionTestMain" @push="completionPush" @restart="completionRestart" @validate="completionValidate" @approve="completionApprove" @retry="completionRetry" @cancel-pipeline="completionCancel" @merge="completionMerge" @rollback="completionRollback"/>
        <section v-if="selected.validationFailure" class="questions"><h3>最近未通過的驗證：第 {{selected.round}} 輪修正</h3><p class="prewrap">{{selected.validationFailure.summary}}</p><ul><li v-for="(e,i) in selected.validationFailure.evidence" :key="i">{{e}}</li></ul><p v-if="!selected.validationFailure.evidence.length">驗證缺少可確認的證據。</p><p v-for="(q,i) in selected.validationFailure.questions" :key="i">待確認：{{q}}</p><p v-if="selected.status==='repair_planning'">正在唯讀分析原因與解法，尚未執行修正。</p><template v-if="selected.repairPlan"><h3>問題原因與修正方案</h3><p class="prewrap">{{selected.repairPlan.summary}}</p><div v-for="(step,i) in selected.repairPlan.steps" :key="i" class="plan-step"><span class="step-number">{{Number(i)+1}}</span><div><strong>{{step.title}}</strong><p>{{step.instructions}}</p></div></div><h3>重新驗證標準</h3><ul><li v-for="(item,i) in selected.repairPlan.acceptance" :key="i">{{item}}</li></ul><p v-for="(q,i) in selected.repairPlan.questions" :key="i">待確認：{{q}}</p><template v-if="selected.status==='awaiting_repair_approval'&&!selected.validationSkipRequest"><button class="primary full" :disabled="busy||selected.repairPlan.questions.length>0" @click="run(()=>api(`/tasks/${selected.id}/repair/approve`,{proposalId:selected.repairPlan.id}))">核准此修正方案並執行</button><form @submit.prevent="run(async()=>{await api(`/tasks/${selected.id}/repair/revise`,{proposalId:selected.repairPlan.id,answer});answer='';})"><label>補充或修改修正方案<textarea v-model="answer" rows="3" minlength="2" maxlength="8000" required/></label><button class="secondary" :disabled="busy">重新提出方案，待我審核</button></form></template></template></section>
        <div v-if="selected.questions.length&&!selected.executionApproval&&!selected.validationSkipRequest&&!selected.manualAction" class="questions"><h3>需要你確認</h3><p v-for="(q,i) in selected.questions" :key="i">{{Number(i)+1}}. {{q}}</p></div>

        <section class="detail-block"><h3>任務狀態</h3>
          <div v-if="selected.status==='rate_limited'" class="notice">{{selected.retryEngine}} 額度限制，預計 {{new Date(selected.retryAt).toLocaleString('zh-TW',{timeZone:selected.retryTimeZone})}}（{{selected.retryTimeZone}}）自動重試目前步驟。暫停或取消任務可停止自動重試。</div>
          <div v-if="selected.manualCompletion" class="notice">此任務由使用者手動完成，不代表已通過 AI 驗證。</div>
          <div v-if="selected.error" class="notice warning">{{selected.error}}</div>
          <label>變更任務狀態<select :value="selected.status" :disabled="busy" @change="setTaskStatus(selected,$event)"><option :value="selected.status">{{statusLabel(selected)}}</option><option v-if="selected.status!=='completed'" value="completed">標記完成</option><option v-if="selected.status!=='paused'" value="paused">暫停任務</option><option v-if="selected.status!=='cancelled'" value="cancelled">取消任務</option><option v-if="['completed','cancelled','paused','failed','waiting_input'].includes(selected.status)" value="reopen">恢復處理</option></select></label>
        </section>

        <h3>原始需求</h3><p class="prewrap requirement">{{selected.description}}</p>
        <div v-if="!selected.plan" class="notice"><Clock3 :size="18"/>{{store.runner.enabled?'根節點將依順序整理計畫。':'AI 執行服務目前暫停；啟用後才會整理計畫。'}}</div>
        <template v-else><div class="section-heading"><h3>計畫摘要</h3><span class="count">v{{selected.planVersion}}</span></div><p class="prewrap">{{selected.plan.summary}}</p><h3>驗收條件</h3><ul class="acceptance"><li v-for="(a,i) in selected.plan.acceptance" :key="i"><ShieldCheck :size="16"/>{{a}}</li></ul><p class="subtle">每一步要做什麼、目前做到哪裡，在「執行進度」分頁。</p><button v-if="selected.status==='awaiting_approval'" class="primary full" :disabled="busy" @click="run(()=>api(`/tasks/${selected.id}/approve`,{version:selected.planVersion}))"><ShieldCheck :size="18"/>核准計畫 v{{selected.planVersion}} 並加入執行佇列</button></template>
        <form v-if="!selected.validationSkipRequest&&!selected.executionApproval&&!selected.manualAction&&!selected.gitRequest&&['waiting_input','awaiting_approval','paused','failed'].includes(selected.status)" @submit.prevent="run(async()=>{await api(`/tasks/${selected.id}/revise`,{answer});answer='';})"><label>回答問題或補充需求<textarea v-model="answer" class="revise-input" rows="3" minlength="2" maxlength="8000" required placeholder="補充後會建立新版計畫，重新請你審核。"/></label><button class="secondary" :disabled="busy">送出補充並重新規劃</button></form>
      </template>

      <!-- 執行進度：狀態全部由現有資料推導，沒有任何預估的完成百分比。 -->
      <template v-else-if="tab==='progress'">
        <div class="progress-summary"><strong>{{detailProgressSummary.label}}</strong><small v-if="detailProgressSummary.note">{{detailProgressSummary.note}}</small><small v-else>只顯示目前已知的狀態，不預估尚未發生的進度。</small></div>
        <ol class="progress-steps"><li v-for="step in detailProgress" :key="step.key" :class="step.state"><span class="progress-mark" aria-hidden="true">{{step.mark}}</span><div class="grow"><strong>{{step.label}}</strong><small v-if="step.detail">{{step.detail}}</small><small v-if="step.note" class="error-text">{{step.note}}</small></div><span class="progress-state">{{step.stateLabel}}</span></li></ol>
        <template v-if="selected.plan"><h3>每一步要做什麼</h3><div v-for="(step,i) in selected.plan.steps" :key="i" class="plan-step"><span class="step-number">{{Number(i)+1}}</span><div><strong>{{step.title}}</strong><small>{{step.role}} · {{selected.executor}}</small><p>{{step.instructions}}</p></div></div><div class="plan-step"><span class="step-number"><Check :size="16"/></span><div><strong>獨立驗證</strong><small>{{selected.reviewer}} · 檢查所有驗收條件</small></div></div></template>
        <h3>執行紀錄（Run / Attempt）</h3>
        <div v-if="!detailRuns.length" class="empty"><GitBranch/><p>尚未開始工作。</p></div>
        <template v-for="run in detailRuns" :key="run.id">
          <!-- 只重試過一次以上的 Run 才需要獨立的 Run 標頭；沒重試過就跟以前一樣是單一列。 -->
          <div v-if="run.attempts.length>1" class="run-group">
            <div class="run-header"><strong>{{runTitle(run)}}</strong><span class="count">{{run.attempts.length}} 次嘗試</span><span class="badge" :class="run.displayStatus||run.status">{{run.statusLabel||statuses[run.status]}}</span></div>
            <div v-for="(th,i) in run.attempts" :key="th.id" class="role-row"><span class="engine-mark">{{th.engine==='codex'?'C':'A'}}</span><div class="grow"><strong>{{attemptLabel(run,i)}}</strong><small>{{th.role}} · {{duration(th)}}</small><small class="prewrap">{{th.summary||th.error||'執行中，尚未回傳結果。'}}</small></div><span class="badge" :class="th.displayStatus||th.status">{{th.statusLabel||statuses[th.status]}}</span></div>
          </div>
          <div v-else class="role-row"><span class="engine-mark">{{run.attempts[0].engine==='codex'?'C':'A'}}</span><div class="grow"><strong>{{run.attempts[0].role}}</strong><small>{{runTitle(run)}} · {{duration(run.attempts[0])}}</small><small class="prewrap">{{run.attempts[0].summary||run.attempts[0].error||'執行中，尚未回傳結果。'}}</small></div><span class="badge" :class="run.displayStatus||run.status">{{run.statusLabel||statuses[run.status]}}</span></div>
        </template>
        <p class="subtle">完整的工作階段、Session ID 與原始回傳在「技術資訊」分頁。</p>
      </template>

      <!-- 成果：檔案、證據、Browser 驗證與發布核准集中在這裡。 -->
      <template v-else-if="tab==='results'">
        <h3>成果檔案</h3>
        <div class="notice"><Folder :size="18"/>工作副本中的檔案（含原始專案），最多顯示 500 個。原專案不會自動被覆寫。</div>
        <p v-if="!files.length" class="muted">尚未建立工作副本。</p>
        <a v-for="file in files" :key="file.path" :href="`/api/tasks/${selected.id}/download?path=${encodeURIComponent(file.path)}`" class="file-row"><FileText :size="17"/><span>{{file.path}}</span><small>{{Math.ceil(file.size/1024)}} KB</small><Download :size="16"/></a>
        <h3>驗證證據</h3>
        <p v-if="!detailEvidence.length" class="muted">尚未有可確認的驗證證據。</p>
        <div v-for="item in detailEvidence" :key="item.threadId" class="evidence-block"><strong>{{item.role}}</strong><p v-if="item.summary" class="prewrap">{{item.summary}}</p><ul><li v-for="(e,i) in item.evidence" :key="i">{{e}}</li></ul></div>
        <template v-if="detailBrowser.length"><h3><Activity :size="16"/> Browser 驗證（Playwright MCP）</h3><div v-for="item in detailBrowser" :key="item.threadId" class="browser-validation"><div class="setting-row"><span class="badge" :class="item.validation.status==='passed'?'completed':item.validation.status==='blocked'?'paused':'failed'">{{browserStatuses[item.validation.status]||item.validation.status}}</span><small>{{item.role}}</small><small v-if="item.validation.url">{{item.validation.url}}</small><small>工具呼叫 {{item.validation.toolCallCount}} 次</small></div><ul v-if="item.validation.checks?.length"><li v-for="(c,i) in item.validation.checks" :key="i">{{c.passed?'✓':'✗'}} {{c.description}}</li></ul><p v-if="item.validation.error" class="error-text">{{item.validation.error}}</p><p v-if="item.validation.notes" class="subtle">{{item.validation.notes}}</p></div></template>
        <div v-if="detailPublish" class="publish-box"><h3>成果交付</h3><p>{{detailPublish.note}}此版本需由負責人手動交付。</p><button v-if="!detailPublish.approved" class="secondary" @click="action('publish-approve')"><ShieldCheck :size="17"/>核准此版本交付</button><span v-else class="badge completed">此版本已核准，等待人工交付</span></div>
      </template>

      <!-- 技術資訊：Agent／開發者用的原始資料，預設不搶走主要視覺。 -->
      <template v-else-if="tab==='technical'">
        <p class="subtle">這一頁是給 Agent 與開發者除錯用的原始資料，一般使用時不需要閱讀。</p>
        <dl class="tech-facts"><template v-for="fact in detailFacts" :key="fact.label"><dt>{{fact.label}}</dt><dd>{{fact.value}}</dd></template></dl>
        <h3>Threads</h3>
        <div v-if="!selected.threads.length" class="empty"><GitBranch/><p>尚未開始工作。</p></div>
        <details v-for="th in selected.threads" :key="th.id" class="thread-detail" :open="th.status==='running'"><summary><span class="engine-mark">{{th.engine==='codex'?'C':'A'}}</span><div class="grow"><strong>{{th.role}}</strong><small>{{th.engine}} · {{duration(th)}}</small></div><span class="badge" :class="th.displayStatus||th.status">{{th.statusLabel||statuses[th.status]}}</span></summary>
          <dl class="tech-facts"><template v-for="row in threadTechnical(th)" :key="row.label"><dt>{{row.label}}</dt><dd>{{row.value}}</dd></template></dl>
          <p class="prewrap">{{th.summary||th.error||'執行中，尚未回傳結果。'}}</p>
          <template v-if="th.result?.browserValidation?.required"><h4>Browser MCP 詳細資料</h4><pre class="raw-block"><code>{{JSON.stringify(th.result.browserValidation,null,2)}}</code></pre></template>
          <template v-if="th.result"><h4>Raw Result</h4><pre class="raw-block"><code>{{JSON.stringify(th.result,null,2)}}</code></pre></template>
          <h4>Execution Log</h4>
          <p v-if="!threadEvents(selected,th.id).length" class="muted">這個工作階段還沒有紀錄。</p>
          <div class="thread-log" v-for="event in threadEvents(selected,th.id)" :key="event.seq"><time>{{time(event.at)}}</time><p>{{event.message}}</p></div>
        </details>
        <h3>Events</h3>
        <div class="timeline"><div v-for="event in [...selected.events].reverse()" :key="event.seq" class="timeline-event"><i/><div><time>{{time(event.at)}} · {{event.kind}}</time><p class="prewrap">{{event.message}}</p></div></div></div>
      </template>
    </div>
    <footer class="drawer-footer"><span>計畫 v{{selected.planVersion}} · {{selected.completedSteps}} / {{selected.totalSteps}} 步驟</span><div><button v-if="['planning','queued','running'].includes(selected.status)" class="secondary compact" @click="action('pause')"><Pause :size="15"/>暫停派工</button><button v-if="selected.threads.some((t:any)=>t.status==='running')" class="secondary compact danger" @click="action('stop')"><Square :size="14"/>中止</button><button v-if="['paused','failed'].includes(selected.status)" class="secondary compact" @click="action('resume')"><Play :size="15"/>恢復</button><button v-if="!['completed','cancelled'].includes(selected.status)" class="icon-button danger" title="取消任務" @click="action('cancel')"><X :size="18"/></button></div></footer></section></div>
  <div v-if="toast" class="toast" role="status"><AlertCircle :size="18"/>{{toast}}<button class="icon-button" title="關閉通知" @click="toast=''"><X :size="16"/></button></div>
</template>
