import {hash,now} from './db.js';
import {HttpError,requireTask} from './domain.js';
import {recordClarification} from './clarifications.js';

export function toolAccessFailure(result){
  if(!result||result.passed)return false;
  const text=[result.summary,...(result.evidence||[])].join('\n');
  return /驗證工具存取失敗|(?:Browser Use|瀏覽器|驗證工具|browser|playwright|mcp__cua)[\s\S]{0,300}(?:security policy|permission|存取.*(?:拒絕|失敗)|無法存取|access denied|not available)/i.test(text);
}
export function validationSkipRequest(store,task){
  if(!['waiting_input','awaiting_repair_approval','paused'].includes(task.status)||task.approvedVersion!==task.planVersion||!task.plan||task.environmentIssue||task.outputIssue)return null;
  const review=store.threads(task.id).filter(th=>th.version===task.planVersion&&['execute','repair','review'].includes(th.phase)).at(-1);
  if(!review||!['execute','repair','review'].includes(review.phase)||review.result?.questions?.length)return null;
  if(!review||review.status!=='completed'||!toolAccessFailure(review.result)||task.validationSkips?.some(skip=>skip.threadId===review.id))return null;
  if(review.phase==='review'&&task.validationFailure?.threadId!==review.id)return null;
  return {id:hash(JSON.stringify([review.id,task.planVersion,task.controlVersion||0,review.result])),threadId:review.id,phase:review.phase,summary:review.result.summary,evidence:review.result.evidence||[]};
}
export function decideValidationSkip(store,user,taskId,{requestId,decision}={}){
  const task=requireTask(store,user,taskId),request=validationSkipRequest(store,task);
  if(!['skip','wait'].includes(decision))throw new HttpError(400,'請選擇跳過或不跳過');
  if(!request||request.id!==requestId||store.threads(taskId).some(th=>th.status==='running'))throw new HttpError(409,'驗證狀態已變更，請重新查看');
  const skip=decision==='skip';
  recordClarification(task,store.threads(taskId),[request.summary],skip?'同意僅跳過上述因驗證工具存取失敗而無法執行的檢查，記為未驗證。仍須驗證其他項目、處理真正的功能錯誤，不得將跳過標成通過，也不得繞過工具權限。':'不跳過驗證，暫停等待工具存取問題處理。');
  if(skip){task.validationSkips=[...(task.validationSkips||[]),{...request,at:now(),by:user.id,planVersion:task.planVersion}];task.validationReviewPending=request.phase==='review';}
  task.status=skip?'queued':'paused';task.questions=[];task.error=null;task.controlVersion=(task.controlVersion||0)+1;
  store.saveTask(task);store.event(taskId,'validation_skip_decision',skip?`${user.name} 同意跳過工具受限的檢查（未驗證），繼續驗證其他項目`:`${user.name} 不跳過驗證，暫停等待處理`);return task;
}
