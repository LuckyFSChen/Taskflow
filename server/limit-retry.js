// Parse the explicit local reset time from Claude's limit error, never guess a timezone.
export function parseEngineLimit(message,at=Date.now()){
  if(!/(?:hit|reached|exceeded|exhausted|out of)[\s\S]{0,65}(?:usage|session|weekly|rate|quota|credits|limit)|(?:usage_limit_reached|insufficient_quota|rate_limit_exceeded)|(?:session|usage|weekly) limit/i.test(message||''))return null;
  return parseClaudeReset(message,at)||{resetAt:null,retryAt:new Date(at+15*60*1000).toISOString(),timeZone:'Asia/Taipei',estimated:true};
}
export function selectAvailableEngine(store,preferred,at=Date.now()){
  const engines=store.setting('engineAutoFallback',true)?[preferred,preferred==='claude'?'codex':'claude']:[preferred];
  for(const engine of engines){const cooldown=store.setting('engineCooldown:'+engine);if(!cooldown||Date.parse(cooldown.retryAt)<=at)return {engine};}
  const engine=engines.sort((a,b)=>Date.parse(store.setting('engineCooldown:'+a).retryAt)-Date.parse(store.setting('engineCooldown:'+b).retryAt))[0];
  return {engine:null,waitingEngine:engine,cooldown:store.setting('engineCooldown:'+engine)};
}
export function parseClaudeReset(message,at=Date.now()){
  if(!/(?:session|usage|weekly) limit/i.test(message||''))return null;
  const match=message.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z0-9_+\-/]+)\)/i);
  if(!match||!Number.isFinite(at))return null;
  let hour=Number(match[1]);const minute=Number(match[2]||0),period=match[3]?.toLowerCase(),timeZone=match[4];
  if(minute>59||(period?(hour<1||hour>12):hour>23))return null;
  if(period)hour=hour%12+(period==='pm'?12:0);
  let formatter;try{formatter=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{return null;}
  // Search actual instants to handle midnight, timezone offsets and DST transitions.
  const start=Math.floor(at/60000)*60000;
  for(let offset=0;offset<=48*60;offset++){
    const instant=start+offset*60000,parts=formatter.formatToParts(instant);
    if(Number(parts.find(p=>p.type==='hour').value)===hour&&Number(parts.find(p=>p.type==='minute').value)===minute){
      return {resetAt:new Date(instant).toISOString(),retryAt:new Date(Math.max(instant+30000,at+30000)).toISOString(),timeZone};
    }
  }
  return null;
}
export function nextTaskEngine(task,threads){
  if(task.validationReviewPending)return task.reviewer;
  if(task.status==='planning'||task.retryResumeStatus==='planning'&&task.status==='rate_limited')return task.planner;
  const all=threads.filter(th=>th.version===task.planVersion);
  if(task.round>0&&!all.some(th=>th.phase==='repair'&&th.round===task.round&&th.status==='completed'&&th.result?.passed&&!th.result.questions?.length))return !task.repairPlan||task.repairPlan.round!==task.round||task.repairPlan.planVersion!==task.planVersion?task.planner:task.executor;
  const completed=all.filter(th=>th.phase==='execute'&&th.status==='completed'&&th.result?.passed&&!th.result.questions?.length).length;
  return task.plan?.steps[completed]?task.executor:task.reviewer;
}
export function scheduleLimitRetry(store,task,engine,reset,{message=null,notify=true}={}){
  const resume=task.status==='rate_limited'?task.retryResumeStatus:!task.plan?'planning':'queued';
  task.status='rate_limited';task.retryResumeStatus=resume;task.retryAt=reset.retryAt;task.retryResetAt=reset.resetAt;task.retryTimeZone=reset.timeZone;task.retryEngine=engine;task.error=message;
  store.saveTask(task);
  const label=new Intl.DateTimeFormat('zh-TW',{timeZone:reset.timeZone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(reset.retryAt));
  const text=`可用引擎額度受限，將於 ${label}（${reset.timeZone}）重新嘗試 ${engine} 的目前步驟。${reset.estimated?'供應商未提供明確恢復時間，這是下次檢查時間。':''}`;
  store.event(task.id,'retry_scheduled',text);if(notify)store.notify(task,text);
}
