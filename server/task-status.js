import {z} from 'zod';
import {now} from './db.js';
import {HttpError,requireTask} from './domain.js';

export function changeTaskStatus(store,runner,user,tid,input){
  const {status,expectedStatus}=z.object({status:z.enum(['paused','completed','cancelled','reopen']),expectedStatus:z.string().optional()}).parse(input);
  const task=requireTask(store,user,tid),previous=task.status;
  if(expectedStatus&&previous!==expectedStatus)throw new HttpError(409,'任務狀態已更新，請重新選擇。');
  if(previous===status)return task;
  const active=store.threads(tid).some(t=>t.status==='running');
  if(status==='reopen'&&active)throw new HttpError(409,'AI 工作正在停止，請稍後再恢復。');
  let next=status;
  if(status==='reopen'&&(task.outputIssue||task.environmentIssue||task.userActionRequired?.status==='pending'))throw new HttpError(409,'請先審核問題處理方案；格式問題需補充後重新規劃，環境問題請使用重新檢查，需要你協助的操作請先回報結果。');
  if(status==='reopen'){
    next=!task.plan?'planning':task.questions?.length?'waiting_input':task.approvedVersion===task.planVersion?'queued':'awaiting_approval';
    // Preserve repair progress and its separate approval gate when resuming.
  }
  task.controlVersion=(task.controlVersion||0)+1;
  task.status=next;task.error=null;task.retryAt=null;task.retryResumeStatus=null;
  task.manualCompletion=status==='completed'?{by:user.id,at:now(),previousStatus:previous}:null;
  task.artifactVersion=null;task.publishApproval=null;
  if(status==='paused')task.resumeStatus=task.plan?'queued':'planning';
  store.saveTask(task);
  const labels={paused:'暫停',completed:'手動完成（未代表 AI 驗證通過）',cancelled:'取消',reopen:'恢復處理'};
  store.event(tid,'status_changed',`${user.name} 將任務由 ${previous} 改為 ${labels[status]}`);
  if(active)runner.stopTask(tid);
  return task;
}
