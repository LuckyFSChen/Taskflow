import {hash} from './db.js';
import {HttpError,requireTask} from './domain.js';
import {recordClarification} from './clarifications.js';

// Derive requests from persisted results so already waiting tasks also work.
export function executionApproval(store,task){
  if(task.status!=='waiting_input'||!task.plan||task.approvedVersion!==task.planVersion||task.environmentIssue||task.outputIssue)return null;
  const thread=store.threads(task.id).filter(t=>t.version===task.planVersion).at(-1);
  const questions=task.questions||[];
  if(!thread||!['execute','repair'].includes(thread.phase)||thread.status!=='completed'||!questions.length||JSON.stringify(questions)!==JSON.stringify(thread.result?.questions))return null;
  if(!questions.every(q=>/是否(?:核准|同意|允許)|請(?:你)?核准/.test(q)))return null;
  return {id:hash(JSON.stringify([thread.id,task.planVersion,task.controlVersion||0,questions])),questions,threadId:thread.id};
}

export function decideExecutionApproval(store,user,taskId,{requestId,decision}={}){
  const task=requireTask(store,user,taskId),request=executionApproval(store,task);
  if(!['approve','reject'].includes(decision))throw new HttpError(400,'請選擇核准或不核准');
  if(!request||request.id!==requestId||store.threads(taskId).some(t=>t.status==='running'))throw new HttpError(409,'此核准請求已變更或已處理，請重新查看');
  const approved=decision==='approve';
  recordClarification(task,store.threads(taskId),request.questions,approved?'核准上述操作；接續原步驟，保留既有成果。此核准僅限上述具體操作。':'不核准上述操作；不得執行，也不得擅自改用替代方案。任務暫停。');
  task.executionDecision={requestId,decision,questions:request.questions,threadId:request.threadId,at:new Date().toISOString()};
  task.status=approved?'queued':'paused';task.questions=[];task.error=null;task.dependencyPreflight=null;
  task.controlVersion=(task.controlVersion||0)+1;
  store.saveTask(task);store.event(taskId,'execution_decision',`${user.name} ${approved?'核准操作，接續原步驟':'不核准操作，暫停任務'}：${request.questions.join('\n')}`);
  return task;
}
