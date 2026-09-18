// Output Issue 的人工處理流程（Phase 5）。
//
// 這個檔案是「重新整理成果報告」這個動作的全部實作。它刻意只 import
// deterministicResultRecovery，沒有 adapter、沒有 cliAdapter、沒有任何 spawn，
// 因此結構上不可能呼叫 Agent：使用者按下按鈕時，TaskFlow 只是把「已經存在的
// 原始回傳」再讀一次並嘗試整理成合規的 Result。
//
// 成功時不另寫一套狀態判斷，而是走 runner 匯出的 applyResultGuards /
// applyPhaseResult，確保「依原本流程繼續下一個安全階段」與正常執行完全一致：
// passed=false 永遠不會變成 Completed，review 未通過仍進入既有 Validation 流程。
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {now} from './db.js';
import {HttpError,requireTask} from './domain.js';
import {deterministicResultRecovery,recoverablePhase} from './output-recovery.js';
import {applyResultGuards,applyPhaseResult} from './runner.js';
import {deriveBrowserValidationRequirement} from './browser-capability.js';
import {detectWebProject} from './project-preview.js';

const RAW_LIMIT=200000;

function readJson(path){
  try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}
}

// 使用者要看的「原始回傳」：validatedOutput 在任何修復之前就存下來的那一份。
export function originalOutput(issue){
  if(!issue?.runDir)return null;
  const path=join(issue.runDir,'original-output.json');
  if(!existsSync(path))return null;
  const saved=readJson(path);
  return saved===undefined?null:saved;
}

// Recovery 的素材：優先用最後一次無損結構轉換的結果（format-repair-N.json），
// 與 runner 自動還原時採用的 error.candidate 相同；沒有才退回原始回傳。
// 兩者都只是既有檔案，讀它們不會讓任何工作被重新執行。
export function recoveryCandidate(issue){
  if(!issue?.runDir||!existsSync(issue.runDir))return originalOutput(issue)?.result;
  let latest=null,highest=0;
  for(const name of readdirSync(issue.runDir)){
    const match=/^format-repair-(\d+)\.json$/.exec(name);
    if(match&&Number(match[1])>=highest){highest=Number(match[1]);latest=join(issue.runDir,name);}
  }
  if(latest){const value=readJson(latest);if(value!==undefined&&value!==null)return value;}
  return originalOutput(issue)?.result;
}

// 「重新整理成果報告」什麼時候該出現：
//   1. 問題還在、屬於目前這版計畫、任務還在等待使用者處理
//   2. 這個階段本來就適用 deterministic recovery（plan／repair_plan 不適用）
//   3. 原始回傳還在磁碟上，真的有東西可以重新整理
//   4. 自動還原還沒失敗過 —— 同一份原始回傳跑同一套規則不會有第二種結果，
//      與其給一個注定失敗的按鈕，不如直接告訴使用者目前仍缺少什麼。
//
// decorated() 每 3 秒的 /api/state 輪詢都會呼叫這裡，所以先做完全部記憶體內的
// 判斷，最後才碰一次磁碟，而且只確認檔案存在、不讀取也不解析內容。
export function outputIssueRecoverable(task){
  const issue=task?.outputIssue;
  if(!issue||task.status!=='waiting_input')return false;
  if(issue.planVersion!==task.planVersion)return false;
  if(!recoverablePhase(issue.phase))return false;
  if(issue.recovery&&issue.recovery.ok===false)return false;
  return !!issue.runDir&&existsSync(join(issue.runDir,'original-output.json'));
}

function requireOpenIssue(store,user,tid,issueId){
  const t=requireTask(store,user,tid);
  const issue=t.outputIssue;
  if(!issue)throw new HttpError(409,'這個任務目前沒有待處理的成果報告問題。');
  if(issueId&&issueId!==issue.id)throw new HttpError(409,'成果報告問題已變更，請重新讀取任務。');
  if(issue.planVersion!==t.planVersion||t.status!=='waiting_input')throw new HttpError(409,'任務狀態已變更，請重新讀取任務。');
  return {t,issue};
}

// 給「查看原始回傳」用。只回傳已保存的原始內容，不做任何解讀或修補。
export function taskOriginalOutput(store,user,tid){
  const t=requireTask(store,user,tid);
  const issue=t.outputIssue;
  if(!issue)throw new HttpError(409,'這個任務目前沒有待處理的成果報告問題。');
  const saved=originalOutput(issue);
  if(saved===null)return {available:false,note:'原始回傳的保存檔已不存在（可能已被清理）。',raw:null,sessionId:null,error:null,issues:issue.issues||[]};
  const raw=typeof saved.result==='string'?saved.result:JSON.stringify(saved.result??null,null,2);
  return {
    available:true,
    raw:raw.length>RAW_LIMIT?raw.slice(0,RAW_LIMIT)+'\n…（原始回傳過長，僅顯示前段）':raw,
    truncated:raw.length>RAW_LIMIT,
    sessionId:saved.sessionId||null,
    error:saved.error||null,
    issues:issue.issues||[],
  };
}

function recordFailure(store,t,issue,{reason,missing=[],notes=[]}){
  t.outputIssue={...issue,recovery:{ok:false,reason,missing,notes,at:now()}};
  store.saveTask(t);
  store.event(t.id,'output_recovery_failed',`重新整理成果報告未成功：${reason}`,issue.threadId||null);
  return {task:t,recovery:{ok:false,reason,missing,notes}};
}

/**
 * 只執行 deterministic recovery，不呼叫 Agent。
 * @returns {{task:any,recovery:{ok:boolean,reason?:string,missing?:string[],notes?:string[]}}}
 */
export function recoverTaskOutput(store,user,tid,input={}){
  const {t,issue}=requireOpenIssue(store,user,tid,input.issueId);
  if(store.threads(t.id).some(x=>x.status==='running'))throw new HttpError(409,'目前仍有工作在執行，請等待結束後再重新整理成果報告。');
  if(!recoverablePhase(issue.phase))
    return recordFailure(store,t,issue,{reason:`${issue.phase||'這個'} 階段不套用成果報告整理；計畫缺少的內容沒有安全的補值方式，請補充需求並重新規劃。`});

  const candidate=recoveryCandidate(issue);
  if(candidate===undefined)
    return recordFailure(store,t,issue,{reason:'找不到已保存的原始 AI 回傳，無法重新整理成果報告。'});

  const recovery=deterministicResultRecovery(candidate);
  if(!recovery.ok)return recordFailure(store,t,issue,{reason:recovery.reason,missing:recovery.missing||[],notes:recovery.notes||[]});

  const thread=store.threads(t.id).find(x=>x.id===issue.threadId);
  if(!thread)return recordFailure(store,t,issue,{reason:'找不到這次執行的角色工作階段，無法安全套用還原結果。'});

  // 還原的結果必須通過與正常執行完全相同的 deterministic guards。特別是
  // Browser 驗證：這次沒有任何 Browser MCP 工具呼叫紀錄可以佐證，需要 Browser
  // 驗證的任務因此不可能藉由「整理格式」被判定通過。
  const requirement=deriveBrowserValidationRequirement({
    webKind:t.workspace&&existsSync(t.workspace)?detectWebProject(t.workspace):null,
    title:t.title,description:t.description,plan:t.plan,
  });
  const result=applyResultGuards(recovery.result,{
    phase:issue.phase,
    browserEvidence:{toolUsed:false,toolCallCount:0,categories:{}},
    browserRequirement:{...requirement,previewUrl:null},
    workingDirectory:t.workspace,threadId:thread.id,planVersion:t.planVersion,
  });

  thread.status='completed';thread.finished=now();thread.result=result;thread.summary=result.summary;thread.error=null;
  store.saveThread(thread);

  t.outputIssue=null;t.error=null;
  const message=`已從原始回傳重新整理成果報告（來源：${recovery.source==='text'?'原始文字':'結構化輸出'}），未重新執行任何工作。${(recovery.notes||[]).join('')}`;
  store.event(t.id,'output_recovered',message,thread.id);
  applyPhaseResult(store,t,thread,issue.phase,result,{wasPaused:false});
  return {task:t,recovery:{ok:true,reason:message,missing:[],notes:recovery.notes||[]}};
}
