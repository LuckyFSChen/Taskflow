import {z} from 'zod';
import {now} from './db.js';
import {HttpError,requireTask} from './domain.js';
import {MANUAL_ACTION_DISPLAY_STATUS} from './manual-action.js';
import {GIT_ISSUE_DISPLAY_STATUS,gitIssuePending,closePendingRequestsOnCancel} from './git-issue.js';

// UI／LINE 看到的狀態。優先序刻意讓「已結束」贏過「待處理」：
//   1. cancelled    已取消的任務不論留著什麼 pending 紀錄，都不該再出現在「待我處理」
//   2. closed       任務生命週期正式結束，同理不該再顯示任何待處理旗標
//   3. completed    AI 執行已結束，但任務尚未真正結束（見下方 Delivery 生命週期狀態機）
//   4. Git 守門待確認   比一般 waiting_input 具體，且它擋住整個任務
//   5. 需要你在本機操作
//   6. failed / paused / ready_to_close / 其餘 task.status
// 第 1、2、3 點是刻意的：舊資料裡確實存在「已取消但 userActionRequired 還是 pending」的任務。
export function taskDisplayStatus(task){
  if(!task)return null;
  if(task.status==='cancelled')return 'cancelled';
  if(task.status==='closed')return 'closed';
  if(task.status==='completed')return 'completed';
  if(gitIssuePending(task))return GIT_ISSUE_DISPLAY_STATUS;
  if(task.userActionRequired?.status==='pending')return MANUAL_ACTION_DISPLAY_STATUS;
  return task.status;
}

// Task 生命週期第二段：Completed（AI 執行已結束）之後不再直接進垃圾桶或直接結束，
// 而是拆成 Git 交付整合與使用者確認兩步：
//   completed        AI／Agent 已完成實作與驗證，尚未確認 Git 整合結果（Execution Terminal State）
//   ready_to_close   已合併至正式分支並通過 merge-base --is-ancestor 二次驗證，等待使用者確認
//   closed           使用者主動關閉，才是整個 workflow 真正的 terminal state
// 只有這兩條路徑允許：completed→ready_to_close（合併驗證通過）、ready_to_close→closed（使用者主動關閉）。
// 刻意不允許 completed 直接跳 closed——那會讓「開發完成」被誤當成「任務已結束」，
// 正是這次改造要拆開的兩個語意。唯一例外是舊資料相容：呼叫端必須明確傳入 {legacy:true}
// 才能放行，一般 API 流程不會、也不應該用到這個通道。
const DELIVERY_TRANSITIONS={completed:['ready_to_close'],ready_to_close:['closed']};
export function canTransitionTaskStatus(from,to,{legacy=false}={}){
  if(legacy&&from==='completed'&&to==='closed')return true;
  return (DELIVERY_TRANSITIONS[from]||[]).includes(to);
}
export function assertTaskTransition(task,to,options={}){
  if(!canTransitionTaskStatus(task.status,to,options))throw new HttpError(409,`任務目前是 ${task.status}，不能直接轉為 ${to}。`);
}

// 純函式，不碰 Git、不做任何 I/O：只憑呼叫端已經確認過的即時檢查結果判斷「這個 completed
// 任務現在能不能視為 ready_to_close」。mainContainsTaskCommit 必須是呼叫端剛剛用
// git merge-base --is-ancestor 對目前 main HEAD 做的即時結果（見 git-review.js taskGitReview／
// mergeDecision），不能是任務完成當下或上次合併時快取的舊結論；沒給就一律視為尚未確認，
// 回傳 false，讓任務維持 completed 而不是自動假設已合併（計畫書第三十一章相容舊任務的原則）。
export function isTaskReadyToClose(task,{mainContainsTaskCommit}={}){
  if(!task||task.status!=='completed')return false;
  if(!task.gitMerge)return false;
  return mainContainsTaskCommit===true;
}

export function changeTaskStatus(store,runner,user,tid,input){
  const {status,expectedStatus}=z.object({status:z.enum(['paused','completed','cancelled','reopen']),expectedStatus:z.string().optional()}).parse(input);
  const task=requireTask(store,user,tid),previous=task.status;
  if(expectedStatus&&previous!==expectedStatus)throw new HttpError(409,'任務狀態已更新，請重新選擇。');
  if(previous===status)return task;
  const active=store.threads(tid).some(t=>t.status==='running');
  if(status==='reopen'&&active)throw new HttpError(409,'AI 工作正在停止，請稍後再恢復。');
  let next=status;
  if(status==='reopen'&&(task.outputIssue||task.environmentIssue||gitIssuePending(task)||task.userActionRequired?.status==='pending'))throw new HttpError(409,'請先審核問題處理方案；格式問題需補充後重新規劃，環境問題請使用重新檢查，Git 未提交修改請先確認保留或重新檢查，需要你協助的操作請先回報結果。');
  if(status==='reopen'){
    next=!task.plan?'planning':task.questions?.length?'waiting_input':task.approvedVersion===task.planVersion?'queued':'awaiting_approval';
    // Preserve repair progress and its separate approval gate when resuming.
  }
  task.controlVersion=(task.controlVersion||0)+1;
  task.status=next;task.error=null;task.retryAt=null;task.retryResumeStatus=null;
  task.manualCompletion=status==='completed'?{by:user.id,at:now(),previousStatus:previous}:null;
  task.artifactVersion=null;task.publishApproval=null;
  if(status==='paused')task.resumeStatus=task.plan?'queued':'planning';
  // 任務結束後不該再有「待我處理」的殘留請求；留著 pending 就是之前「已取消卻還顯示待我處理」的成因。
  const closed=['cancelled','completed'].includes(status)?closePendingRequestsOnCancel(task,user):[];
  store.saveTask(task);
  if(closed.length)store.event(tid,'requests_closed',`任務已${status==='cancelled'?'取消':'標記完成'}，同時關閉待處理項目：${closed.map(k=>({git_issue:'Git 修改待確認',user_action:'需要你協助的操作'})[k]||k).join('、')}。專案目錄的未提交修改一律保留不動。`);
  const labels={paused:'暫停',completed:'手動完成（未代表 AI 驗證通過）',cancelled:'取消',reopen:'恢復處理'};
  store.event(tid,'status_changed',`${user.name} 將任務由 ${previous} 改為 ${labels[status]}`);
  if(active)runner.stopTask(tid);
  return task;
}
