import {hash,now,id} from './db.js';
import {HttpError,requireTask} from './domain.js';
import {recordClarification} from './clarifications.js';
import {normalizeCommand,isHighRiskCommand} from './command-permissions.js';
import {planProgressOf} from './completion-state.js';

// Unambiguous: the execution environment itself refused the operation, not the code.
const STRONG_PATTERNS=[
  /this command requires approval/i,
  /requires approval/i,
  /requires elevation/i,
  /elevation required/i,
  /operation requires elevation/i,
  /administrator privileges/i,
  /requires administrator/i,
  /run as administrator/i,
  /sudo required/i,
  /not in (?:the )?allowed(?: command)? list/i,
  /command is not permitted/i,
  /blocked by (?:execution )?policy/i,
  /execution blocked by policy/i,
  /policy denied/i,
  /sandbox (?:denied|blocked)/i,
  /interactive login required/i,
  /mfa required/i,
  /browser confirmation required/i,
  /requires (?:a )?browser (?:login|authorization|confirmation)/i,
  /oauth (?:login|authorization) required/i,
  /you haven'?t granted it yet/i,
];
// Ambiguous alone (a Linux file-permission issue may be fixable by the agent itself),
// only counted alongside language that points at command/tool execution being denied.
const WEAK_PATTERNS=[/access is denied/i,/permission denied/i,/not allowed/i,/not permitted/i];
const WEAK_CONTEXT=/\b(bash|shell|command|cli|npx|npm|pnpm|yarn|tool|execute|approval|policy|sandbox|elevat|allow[- ]?list)\b/i;

function detectRequiresAdministrator(text){
  if(/administrator privileges|requires administrator|run as administrator|sudo required|elevation required|requires elevation|operation requires elevation/i.test(text))return true;
  if(/requires approval|not in (?:the )?allowed(?: command)? list|command is not permitted|blocked by (?:execution )?policy|execution blocked by policy|policy denied|sandbox (?:denied|blocked)/i.test(text))return false;
  return null;
}

// Deterministic, rule-based classification. The LLM's own self-report (userActionRequired
// in the structured result) is only ever a secondary, corroborated signal here — never the
// sole basis for stopping retries; the regex layer is authoritative whenever it matches.
// TaskFlow 自己負責版本控制（runner.js 的 commitPhase）：執行環境擋下 agent 的 git add／
// git commit／git push 是預期中的正確行為，不是需要使用者出手排除的環境問題——使用者手動跑
// 一次 git commit 既不該做、也不是平台要的。把這種阻擋當成手動操作請求，會生出一個 commands
// 為空、使用者根本無從執行的請求，並把一個實際上已經完成、而且已經由平台 commit 的步驟卡住。
// 只有在這類阻擋「之外」還有別的阻擋時，才真的需要使用者介入。
const PLATFORM_OWNED_CONTEXT=/git\s+(?:add|commit|push)|版本控制/i;
const CONTEXT_WINDOW=240;
function platformOwnedMatch(text,index){
  return PLATFORM_OWNED_CONTEXT.test(text.slice(Math.max(0,index-CONTEXT_WINDOW),index+CONTEXT_WINDOW));
}
// 逐一檢查每個 pattern 的「每一次」出現：第一次出現落在版本控制的敘述裡，不代表後面沒有
// 真正需要使用者處理的阻擋，所以不能只看第一個 match 就放棄。
function firstActionableMatch(patterns,text){
  for(const pattern of patterns){
    const scan=new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g');
    let found;
    while((found=scan.exec(text))!==null){
      if(!platformOwnedMatch(text,found.index))return {match:found[0]};
      if(found.index===scan.lastIndex)scan.lastIndex++;
    }
  }
  return null;
}
export function detectManualActionRequirement({message,summary,evidence,selfReport}={}){
  const text=[message,summary,...(evidence||[]),selfReport?.reason,selfReport?.instructions].filter(Boolean).join('\n');
  if(text){
    const strong=firstActionableMatch(STRONG_PATTERNS,text);
    if(strong)return {category:'approval_required',match:strong.match,requiresAdministrator:detectRequiresAdministrator(text)};
    const weak=firstActionableMatch(WEAK_PATTERNS,text);
    if(weak&&WEAK_CONTEXT.test(text))return {category:'permission_error',match:weak.match,requiresAdministrator:detectRequiresAdministrator(text)};
  }
  if(selfReport?.required&&(selfReport.commands?.length||selfReport.instructions))return {category:'agent_reported',match:selfReport.reason||selfReport.instructions,requiresAdministrator:selfReport.requiresAdministrator??null};
  return null;
}
export function classifyExecutionFailure(context){
  const detection=detectManualActionRequirement(context);
  if(!detection)return 'execution_error';
  return detection.category==='approval_required'?'approval_required':detection.category==='agent_reported'?'user_action_required':'permission_error';
}
function fingerprintCommand(command){
  return String(command).replace(/^(?:npx|npm exec|npm run|npm|pnpm exec|pnpm run|pnpm|yarn run|yarn|cmd \/c|powershell(?:\.exe)?)\s+/i,'').split(/\s+/).filter(w=>!w.startsWith('-')).join(' ').toLowerCase().trim();
}
// First-version equivalent-operation fingerprint: cwd + normalized command intents,
// ignoring package-manager wrapper and flags (npx prisma migrate ≈ pnpm prisma migrate dev).
export function fingerprintOperation(cwd,commands){
  return hash(JSON.stringify([String(cwd||'').toLowerCase(),(commands||[]).map(fingerprintCommand).sort()]));
}
// The task-level status a runtime consumer (UI, LINE, reviewer) can check to unambiguously
// recognize "a human needs to act", distinct from the generic waiting_input used for
// ordinary plan questions or approvals — see manualActionRequest()/decorated task display.
export const MANUAL_ACTION_DISPLAY_STATUS='waiting_user_action';
export function buildUserActionRequest({detection,selfReport,workingDirectory,phase,threadId,planVersion,rawMessage}){
  const sr=selfReport?.required?selfReport:null;
  const commands=sr?.commands?.length?sr.commands:[];
  const workingDirectoryResolved=sr?.workingDirectory||workingDirectory||null;
  const message=(rawMessage||detection.match||null);
  return {
    required:true,
    reason:sr?.reason||`偵測到執行環境阻擋此操作（${detection.match}）`,
    actionType:sr?.actionType||'run_command',
    commands,
    workingDirectory:workingDirectoryResolved,
    // Raw stderr/tool evidence behind the detection, preserved verbatim (truncated) so a human
    // or the agent re-verifying later can see exactly what the environment refused — never
    // overwritten or discarded by later format-repair or retry logic.
    message:message?String(message).slice(0,2000):null,
    instructions:sr?.instructions||'請在本機終端機（Windows 請先用一般 PowerShell，不必預設要求系統管理員）執行以上指令；若未列出指令，請查看此步驟的活動紀錄取得實際指令。完成後請回報「我已執行完成」。',
    verification:sr?.verification?.length?sr.verification:[],
    requiresAdministrator:sr?.requiresAdministrator??detection.requiresAdministrator??null,
    status:'pending',
    category:detection.category,
    fingerprint:fingerprintOperation(workingDirectoryResolved,commands),
    phase,threadId,planVersion,at:now(),
  };
}
// A pending manual action can be retried in-sandbox (instead of asking the user to run it on
// their own machine) only when: it is a Claude Code / policy allow-list block, not something
// that genuinely needs elevation or a human outside the app, and none of the commands are
// high-risk (destructive/irreversible) operations.
export function canRetryWithApproval(ua){
  return !!ua&&ua.category==='approval_required'&&ua.requiresAdministrator!==true&&ua.commands?.length>0&&!ua.commands.some(isHighRiskCommand);
}
export function manualActionRequest(store,task){
  const ua=task.userActionRequired;
  if(!ua||ua.status!=='pending')return null;
  // 已結束的任務不再有待處理請求：舊資料裡確實存在「已取消但 userActionRequired 還是 pending」
  // 的任務，若照樣送出請求，UI 會繼續顯示待我處理，也會讓人按下一個不該還能按的按鈕。
  if(['cancelled','completed'].includes(task.status))return null;
  return {id:hash(JSON.stringify([ua.threadId,task.planVersion,task.controlVersion||0,ua])),...ua,retryable:canRetryWithApproval(ua)};
}
export function decideManualAction(store,user,taskId,{requestId,decision,note}={}){
  const task=requireTask(store,user,taskId),request=manualActionRequest(store,task);
  if(!['completed','failed','skip','approve_once'].includes(decision))throw new HttpError(400,'請選擇「已完成」、「執行失敗」、「略過」或「允許一次執行」');
  if(!request||request.id!==requestId||store.threads(taskId).some(t=>t.status==='running'))throw new HttpError(409,'此請求已變更或已處理，請重新查看');
  if(decision==='failed'&&(typeof note!=='string'||!note.trim()))throw new HttpError(400,'請貼上執行後看到的錯誤訊息');
  const ua=task.userActionRequired,commandsText=ua.commands.join('\n')||'（請參閱此步驟的活動紀錄取得實際指令）';
  if(decision==='approve_once'){
    if(!request.retryable)throw new HttpError(409,'此操作不支援自動核准重試，請改用「已完成」、「執行失敗」或「略過」');
    // Bind the grant to this task's own workspace; never let it authorize a command against
    // a path outside the sandboxed working copy.
    if(!task.workspace||ua.workingDirectory!==task.workspace)throw new HttpError(409,'工作目錄與任務工作副本不符，無法核准');
    const approvals=ua.commands.map(command=>({id:id(),command,normalizedCommand:normalizeCommand(command),cwd:ua.workingDirectory,status:'approved',scope:'once',requestedAt:ua.at,approvedAt:now(),approvedBy:user.id,consumedAt:null,source:{phase:ua.phase,planVersion:ua.planVersion}}));
    task.manualActionHistory=[...(task.manualActionHistory||[]),{...ua,decision,resolvedAt:now(),resolvedBy:user.id}];
    task.commandApprovals=[...(task.commandApprovals||[]),...approvals];
    recordClarification(task,store.threads(taskId),[`使用者已核准以下指令可於這次執行中執行一次：\n${commandsText}`],'已核准；此次執行環境已臨時放行上述指令，請照常執行完成原步驟，不必再次詢問或改用其他指令。核准僅限本次執行，之後若再遇到相同或其他被擋的指令，仍須重新申請核准。');
    task.userActionRequired=null;task.status='queued';task.error=null;
    task.controlVersion=(task.controlVersion||0)+1;
    store.saveTask(task);
    store.event(taskId,'command_approval_approved',`${user.name} 核准以下指令執行一次：\n${commandsText}`);
    return task;
  }
  task.manualActionHistory=[...(task.manualActionHistory||[]),{...ua,decision,note:note?String(note).trim().slice(0,4000):null,resolvedAt:now(),resolvedBy:user.id}];
  if(decision==='completed'){
    recordClarification(task,store.threads(taskId),[`使用者已於本機完成以下操作：\n${commandsText}`],`已完成。請只驗證結果（${ua.verification.join('；')||'依原驗收條件檢查'}），不要重新執行相同或等效的指令。`);
    // 只有被擋住的階段本身是 review 時，回報「已完成」才代表要重跑 group-level 獨立驗證。
    // execute／repair 階段的手動操作只影響那一個步驟，必須回到原本的步驟流程繼續驗證，
    // 不能讓剩餘的計畫步驟被略過。
    task.userActionRequired=null;task.validationReviewPending=ua.phase==='review';task.status='queued';task.error=null;
  } else if(decision==='failed'){
    recordClarification(task,store.threads(taskId),[`使用者嘗試執行以下操作：\n${commandsText}`],`執行失敗，錯誤訊息如下：\n${note.trim().slice(0,4000)}\n請分析原因並修正設定或程式；不要再次嘗試已被平台拒絕的原指令本身。`);
    task.userActionRequired=null;task.status='queued';task.error=null;
  } else {
    const thread=store.threads(taskId).find(t=>t.id===ua.threadId);
    if(thread?.result)store.saveThread({...thread,result:{...thread.result,passed:true,manualActionSkipped:true,evidence:[...(thread.result.evidence||[]),`使用者已選擇略過（因執行環境限制無法執行，未驗證）：${commandsText}`]}});
    task.manualActionSkips=[...(task.manualActionSkips||[]),{...ua,skippedAt:now(),skippedBy:user.id}];
    recordClarification(task,store.threads(taskId),[`以下操作因執行環境限制而略過：\n${commandsText}`],'使用者選擇略過；此項目未驗證，不得聲稱通過，其餘驗收仍須實際檢查。');
    task.userActionRequired=null;
    // 略過的是 review 階段的手動操作時，仍然不能只憑這個略過決定就標記完成：計畫步驟
    // 沒做完的話，這次 review 涵蓋的範圍本來就不是整份計畫，必須回到步驟流程繼續。
    if(ua.phase==='review'){
      const progress=planProgressOf(task,store.threads(taskId));
      if(progress.remaining>0){
        task.status='queued';task.error=null;
        store.notify(task,`已依你的選擇略過該項受限操作；但計畫還有 ${progress.remaining} 個步驟未完成（已完成 ${progress.completed}/${progress.total}），任務不會標記完成，將繼續執行「${progress.nextStepTitle}」。`);
      } else {
        task.status='completed';task.artifactVersion=id();
        store.notify(task,'驗證完成；其中一項因執行環境限制經你同意略過（未驗證），其餘驗收已通過。');
      }
    }
    else{task.status='queued';task.error=null;}
  }
  task.controlVersion=(task.controlVersion||0)+1;
  store.saveTask(task);
  store.event(taskId,'user_action_decision',`${user.name} ${{completed:'回報已完成手動操作',failed:'回報手動操作執行失敗',skip:'略過此手動操作'}[decision]}`);
  return task;
}
