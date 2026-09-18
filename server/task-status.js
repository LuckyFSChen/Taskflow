import {z} from 'zod';
import {now} from './db.js';
import {HttpError,requireTask} from './domain.js';
import {MANUAL_ACTION_DISPLAY_STATUS} from './manual-action.js';
import {GIT_ISSUE_DISPLAY_STATUS,gitIssuePending,closePendingRequestsOnCancel} from './git-issue.js';

// UI／LINE 看到的狀態。優先序刻意讓「已結束」贏過「待處理」：
//   1. cancelled    已取消的任務不論留著什麼 pending 紀錄，都不該再出現在「待我處理」
//   2. completed    同理
//   3. Git 守門待確認   比一般 waiting_input 具體，且它擋住整個任務
//   4. 需要你在本機操作
//   5. failed / paused / 其餘 task.status
// 第 1、2 點是刻意的：舊資料裡確實存在「已取消但 userActionRequired 還是 pending」的任務。
export function taskDisplayStatus(task){
  if(!task)return null;
  if(task.status==='cancelled')return 'cancelled';
  if(task.status==='completed')return 'completed';
  if(gitIssuePending(task))return GIT_ISSUE_DISPLAY_STATUS;
  if(task.userActionRequired?.status==='pending')return MANUAL_ACTION_DISPLAY_STATUS;
  return task.status;
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
