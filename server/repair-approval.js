import {recordClarification} from './clarifications.js';
import {HttpError,requireTask} from './domain.js';
import {now} from './db.js';
export function approveRepair(store,user,tid,proposalId){
 const t=requireTask(store,user,tid),p=t.repairPlan;
 if(t.status!=='awaiting_repair_approval'||!p||p.id!==proposalId||p.planVersion!==t.planVersion||p.round!==t.round)throw new HttpError(409,'修正方案已變更或不在待審核狀態，請重新查看');
 if(p.questions.length)throw new HttpError(409,'修正方案仍有待確認問題，請先補充後重新產生方案');
 t.approvedRepairId=p.id;t.repairApproval={proposalId:p.id,by:user.id,at:now()};t.status='queued';t.error=null;store.saveTask(t);store.event(tid,'repair_approved',`${user.name} 核准第 ${t.round} 輪修正方案 ${p.id}`);return t;
}
export function reviseRepair(store,user,tid,proposalId,answer){
 const t=requireTask(store,user,tid);if(t.status!=='awaiting_repair_approval'||t.repairPlan?.id!==proposalId)throw new HttpError(409,'請重新查看最新修正方案');
 if(typeof answer!=='string'||answer.trim().length<2||answer.length>8000)throw new HttpError(400,'請輸入 2 至 8000 字的補充');
 recordClarification(t,store.threads(tid),t.repairPlan?.questions||[],answer);t.repairFeedback=(t.repairFeedback||'')+'\n'+answer.trim();t.repairPlan=null;t.approvedRepairId=null;t.repairApproval=null;t.controlVersion=(t.controlVersion||0)+1;t.status='repair_planning';store.saveTask(t);store.event(tid,'repair_revised','使用者補充修正方案，重新分析後再次審核');return t;
}
