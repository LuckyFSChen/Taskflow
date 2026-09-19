import {threadPresentation} from './thread-presentation.js';
import {registerNotificationAdmin} from './notification-admin.js';
import {approveRepair,reviseRepair} from './repair-approval.js';
import {projectRemovalPlan,removeProject} from './project-removal.js';
import {runnerLimit} from './runner.js';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync,realpathSync,readdirSync,lstatSync } from 'node:fs';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { z } from 'zod';
import { id,hash,passwordHash,passwordMatches } from './db.js';
import { HttpError,createTask,requireTask,approveTask,reviseTask } from './domain.js';
import {executionApproval,decideExecutionApproval} from './execution-approval.js';
import {validationSkipRequest,decideValidationSkip} from './validation-skip.js';
import {manualActionRequest,decideManualAction} from './manual-action.js';
import { prepareProjectDirectory } from './project-directory.js';
import {browseDirectory,createDirectory,availableDrives} from './directory-browser.js';
import {createTaskWithProject} from './task-project.js';
// 方案群組：任務佇列的分組依據。只認明確的 planGroupId，不做任何字串推測。
import {createPlanGroup,renamePlanGroup,assignTaskPlanGroup,planGroupsPublic} from './plan-group.js';
import {changeTaskStatus,taskDisplayStatus} from './task-status.js';
import {gitIssueRequest,decideGitIssue,gitIssuePending,closePendingRequestsOnCancel} from './git-issue.js';
import {createProjectPreview,detectWebProject,openFolder} from './project-preview.js';
import {checkClaudeBrowserCapability} from './browser-capability.js';
import {createSystemHealth} from './system-health.js';
import {onboardingStatus,completeOnboarding} from './onboarding.js';
import {recoverTaskOutput,taskOriginalOutput,outputIssueRecoverable} from './output-issue.js';
import {taskGitReview,decideGitReview,rollbackTaskMerge} from './git-review.js';
// 測試基準比對：在 main 與任務分支各跑一次完整測試，用結構化比對取代「AI 說那 3 個是既有失敗」。
import {createCompletionTests,completionTestPublic} from './completion-test.js';
import {legacyWorkspaceStatus,migrateLegacyWorkspace} from './git-migration.js';
import {createGitWorkspace} from './git-workspace.js';

export function allowedOrigins(publicOrigin=process.env.PUBLIC_ORIGIN) {
  const configured=new URL(publicOrigin||`http://127.0.0.1:${process.env.PORT||4310}`).origin;
  const allowed=new Set([configured,`http://127.0.0.1:${process.env.PORT||4310}`,`http://localhost:${process.env.PORT||4310}`,`http://[::1]:${process.env.PORT||4310}`,'http://127.0.0.1:5173','http://localhost:5173']);
  const url=new URL(configured);
  if(['127.0.0.1','localhost','[::1]'].includes(url.hostname)) {
    for(const host of ['127.0.0.1','localhost','[::1]']) {
      const local=new URL(configured);local.hostname=host;allowed.add(local.origin);
    }
  }
  return [...allowed];
}

export function createApp(store,runner,{dist=resolve('dist'),previews=createProjectPreview(),folderOpener=openFolder,health=createSystemHealth(store),gitWorkspace=createGitWorkspace(),completionTests=createCompletionTests({gitWorkspace})}={}) {
  const app=express(),attempts=new Map();app.disable('x-powered-by');
  app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");next();});
  app.use('/api',express.json({limit:'100kb'}));
  app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)){const origin=req.get('origin');const allowed=allowedOrigins(store.setting('publicOrigin',process.env.PUBLIC_ORIGIN));if(origin&&!allowed.includes(origin))return res.status(403).json({error:'不允許的來源'});if(!req.is('application/json'))return res.status(415).json({error:'需使用 JSON 請求'});}const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tf_session='))?.slice(11);if(cookie){const session=store.db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?').get(hash(cookie),Date.now());if(session){req.user=store.user(session.user_id);req.sessionHash=hash(cookie);}}next();});
  app.get('/api/health',(req,res)=>res.json({ok:true,service:'taskflow'}));
  app.post('/api/login',(req,res)=>{const key=req.ip||'local',record=attempts.get(key)||{n:0,until:Date.now()+60000};if(record.until<Date.now()){record.n=0;record.until=Date.now()+60000;}if(++record.n>15){attempts.set(key,record);throw new HttpError(429,'登入嘗試過多，請稍後再試');}attempts.set(key,record);const input=z.object({username:z.string().max(80),password:z.string().max(200)}).parse(req.body);const u=store.db.prepare('SELECT * FROM users WHERE username=?').get(input.username);if(!u||!passwordMatches(input.password,u.password))throw new HttpError(401,'帳號或密碼不正確');const token=randomBytes(32).toString('base64url');store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),u.id,Date.now()+12*3600000);res.cookie('tf_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',maxAge:12*3600000,path:'/'});res.json(store.user(u.id));});
  app.use('/api',(req,res,next)=>{if(!req.user)return res.status(401).json({error:'請先登入'});next();});
  app.post('/api/logout',(req,res)=>{store.db.prepare('DELETE FROM sessions WHERE token=?').run(req.sessionHash);res.clearCookie('tf_session',{path:'/'});res.json({ok:true});});
  const admin=(req,res,next)=>{if(req.user.role!=='admin')throw new HttpError(403,'需要管理者權限');next();};
  registerNotificationAdmin(app,store,admin);
  app.locals.previews=previews;
  app.get('/api/admin/directories',admin,(req,res)=>{
    const path=z.string().max(1000).optional().parse(req.query.path)||store.setting('defaultProjectRoot','')||resolve('.');
    res.json({...browseDirectory(path),drives:availableDrives(),defaultRoot:store.setting('defaultProjectRoot','')});
  });
  app.post('/api/admin/directories',admin,(req,res)=>{
    const input=z.object({parent:z.string().min(1).max(1000),name:z.string().min(1).max(80)}).parse(req.body);
    res.status(201).json({path:createDirectory(input.parent,input.name)});
  });
  function projectTarget(req,{allowActive=false}={}){
    const p=store.project(req.params.id);
    if(!p||!store.hasProject(req.user,p.id))throw new HttpError(404,'找不到專案');
    const taskId=z.string().uuid().optional().parse(req.body.taskId);
    if(!taskId)return {key:p.id,path:p.path};
    const t=requireTask(store,req.user,taskId);
    if(t.projectId!==p.id||!t.workspace)throw new HttpError(404,'找不到專案工作副本');
    if(!allowActive&&store.threads(t.id).some(x=>x.status==='running'))throw new HttpError(409,'AI 正在修改此工作副本，請完成後再開啟預覽');
    return {key:`${p.id}:${t.id}:${t.planVersion}`,path:t.workspace};
  }
  // Preview credentials (fullstack Preview 的一次性測試帳密) 只給 runner.js 內部組 prompt 用，
  // 一般前端 UI 一律拿不到，避免外洩到瀏覽器或被其他使用者看見。
  const withoutCredentials=info=>info?{...info,credentials:undefined}:info;
  app.get('/api/projects/:id/targets',(req,res)=>{
    const p=store.project(req.params.id);if(!p||!store.hasProject(req.user,p.id))throw new HttpError(404,'找不到專案');
    const targets=[{taskId:null,label:'原始專案',web:detectWebProject(p.path),preview:withoutCredentials(previews.status(p.id))},...store.tasks(req.user).filter(t=>t.projectId===p.id&&t.workspace).map(t=>({taskId:t.id,label:`${t.title} · v${t.planVersion} 工作副本`,web:detectWebProject(t.workspace),preview:withoutCredentials(previews.status(`${p.id}:${t.id}:${t.planVersion}`))}))];
    res.json({targets});
  });
  app.post('/api/projects/:id/open-folder',async(req,res)=>{const target=projectTarget(req,{allowActive:true});await folderOpener(target.path);res.json({ok:true});});
  app.post('/api/projects/:id/preview',async(req,res)=>{const target=projectTarget(req);res.json(withoutCredentials(await previews.start(target.key,target.path)));});
  app.post('/api/projects/:id/preview/stop',async(req,res)=>{const target=projectTarget(req);await previews.stop(target.key);res.json({ok:true});});
  const visibleProjects=user=>{const projects=store.db.prepare('SELECT * FROM projects').all().filter(p=>store.hasProject(user,p.id));return projects.map(p=>user.role==='admin'?p:{id:p.id,name:p.name,code:p.code});};
  function decorated(t){const threads=store.threads(t.id).filter(th=>th.version===t.planVersion).map(th=>({...th,...threadPresentation(th)}));return {...t,validationSkipRequest:validationSkipRequest(store,t),executionApproval:executionApproval(store,t),manualAction:manualActionRequest(store,t),
    // Git 守門的待確認請求（未提交修改、受保護分支…）。原始的 t.gitIssue 仍隨 spread 送出，
    // 讓 UI 也能顯示「已確認／已處理」的歷程；gitRequest 只在真的還要使用者處理時才存在。
    gitRequest:gitIssueRequest(store,t),
    // runDir 是伺服器磁碟路徑，不送到瀏覽器；改送「這個問題現在能不能重新整理」這個結論。
    outputIssue:t.outputIssue?{...t.outputIssue,runDir:undefined,recoverable:outputIssueRecoverable(t)}:t.outputIssue,
    // Distinct, explicit status a UI/automation consumer can branch on for "needs a human to act
    // outside the app" — never collapse this into the generic waiting_input/failed states.
    displayStatus:taskDisplayStatus(t),
    // 測試比對的紀錄裡有伺服器磁碟上的 log 路徑，和 workspace 一樣不送到瀏覽器；
    // 只送結論、數量與失敗項目名稱。
    completionTest:completionTestPublic(t),
    // repositoryPath／workingDirectory 是伺服器磁碟路徑，和 workspace 一樣不送到瀏覽器；
    // 只送使用者真正需要判讀的 Git 座標：從哪個分支開出、目前在哪個分支、哪兩個 commit。
    git:t.git?{mode:t.git.mode,baseBranch:t.git.baseBranch,workingBranch:t.git.workingBranch,baseCommit:t.git.baseCommit,headCommit:t.git.headCommit}:t.git,
    // 方案群組只送 id 與名稱；群組的完成度／狀態一律由前端依真實 task state 聚合，
    // 後端不預先算任何進度數字，也不會在這裡幫沒有 planGroupId 的舊任務「猜」一個群組。
    planGroupId:t.planGroupId||null,planGroupName:t.planGroupId?store.planGroup(t.planGroupId)?.name||null:null,
    workspace:undefined,threads,ownerName:store.user(t.ownerId)?.name,projectName:store.project(t.projectId)?.name,completedSteps:threads.filter(th=>th.phase==='execute'&&th.status==='completed'&&th.result?.passed&&!th.result.questions?.length).length,totalSteps:t.plan?.steps.length||0};}
  app.get('/api/state',async(req,res)=>{
    const browser=await checkClaudeBrowserCapability().catch(error=>({available:false,provider:null,cli:'claude',error:error.message}));
    res.json({user:req.user,onboarding:onboardingStatus(store,req.user),defaultProjectRoot:req.user.role==='admin'?store.setting('defaultProjectRoot',''):undefined,projects:visibleProjects(req.user),planGroups:planGroupsPublic(store,req.user),tasks:store.tasks(req.user).map(decorated),runner:{enabled:store.setting('runnerEnabled',false),...runner.status,maxConcurrent:runnerLimit(store),activeTaskIds:(runner.status.activeTaskIds||[]).filter(id=>store.tasks(req.user).some(t=>t.id===id)),activeTaskId:store.tasks(req.user).some(t=>t.id===runner.status.activeTaskId)?runner.status.activeTaskId:null},integrations:{lineConfigured:!!(process.env.INBOX_URL&&process.env.INBOX_TOKEN),lastSync:store.setting('inboxLastSuccess'),error:store.setting('inboxError'),notificationError:store.db.prepare("SELECT error FROM outbox WHERE sent=0 AND cancelled_at IS NULL AND error IS NOT NULL ORDER BY rowid DESC LIMIT 1").get()?.error||null,pendingNotifications:store.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent=0 AND cancelled_at IS NULL').get().n,browser:{configured:!!browser.available,provider:browser.provider,available:browser.available,error:browser.error}}});
  });
  // Read-only environment report every signed-in member can see: the dashboard warning
  // and 平台設定 both read it. ?refresh=1 is a manual re-check, still rate limited inside
  // the provider so a polling client can never spawn CLI processes continuously.
  app.get('/api/system/health',async(req,res)=>res.json(await health.get({force:req.query.refresh==='1'})));
  // 首次設定精靈：完成或「稍後設定」都只記錄同一個旗標，不新增任何 Schema，也不
  // 代表環境沒問題——系統狀態仍由 /api/system/health 決定，首頁會繼續提醒。
  app.post('/api/onboarding/complete',admin,(req,res)=>{
    z.object({}).strict().parse(req.body||{});
    res.json(completeOnboarding(store,req.user));
  });
  app.post('/api/tasks',(req,res)=>res.status(201).json(decorated(store.transaction(()=>createTaskWithProject(store,req.user,req.body)))));
  // 方案群組。三條路徑都只改分組座標，不碰任務的執行狀態、計畫版本或任何核准紀錄。
  app.post('/api/plan-groups',(req,res)=>res.status(201).json(store.transaction(()=>createPlanGroup(store,req.user,req.body))));
  app.post('/api/plan-groups/:id/rename',(req,res)=>res.json(renamePlanGroup(store,req.user,req.params.id,req.body)));
  // 把既有任務（含沒有方案的舊任務）歸入方案，或移出成為獨立任務。
  // 這是使用者明確按下的動作：TaskFlow 不會自己依標題或專案把舊任務合併進任何方案。
  app.post('/api/tasks/:id/plan-group',(req,res)=>res.json(decorated(store.transaction(()=>assignTaskPlanGroup(store,req.user,req.params.id,req.body)))));
  app.get('/api/tasks/:id',(req,res)=>{const t=requireTask(store,req.user,req.params.id);res.json({...decorated(t),events:store.events(t.id)});});
  app.post('/api/tasks/:id/preflight/retry',(req,res)=>{const t=requireTask(store,req.user,req.params.id);if(!t.environmentIssue||t.environmentIssue.id!==req.body.issueId||t.environmentIssue.planVersion!==t.planVersion||t.status!=='waiting_input')throw new HttpError(409,'環境問題已變更，請重新查看');t.environmentIssue=null;t.dependencyPreflight=null;t.error=null;t.status=t.plan&&t.approvedVersion===t.planVersion?'queued':'awaiting_approval';t.controlVersion=(t.controlVersion||0)+1;store.saveTask(t);store.event(t.id,'preflight_approved',`${req.user.name} 核准重新檢查套件環境；通過前不執行工作`);res.json(decorated(t));});
  // Git 安全守門（未提交修改、受保護分支、巢狀版本庫…）的三個人工出路。沿用既有的
  // gitIssue／resumeStatus 機制與這條既有路徑，不另外開 /git/approve、/git/retry：
  //   action='recheck'（預設，向後相容原本只帶 issueId 的呼叫）真的重跑 git status
  //   action='approve' 確認保留未提交修改並繼續（記下指紋，同一組修改不再重複詢問）
  //   action='cancel'  取消任務並關閉待確認項目
  // 這條路徑不會執行任何破壞性 git 指令：不 reset、不 clean、不 stash、不 checkout、不刪檔。
  app.post('/api/tasks/:id/git/recheck',(req,res)=>{
    const input=z.object({issueId:z.string().max(200).optional(),action:z.enum(['approve','recheck','cancel']).default('recheck')}).strict().parse(req.body||{});
    // 不包在 store.transaction 裡：這條路徑在「確認前修改又變了」或「git 檢查失敗」時會
    // 先更新待確認清單／留下事件紀錄，再回報 409 要求使用者重新查看。包進交易會把那些
    // 更新一起回滾，使用者就會看到過期的清單。
    res.json(decorated(decideGitIssue(store,req.user,req.params.id,input,{gitWorkspace,runner})));
  });
  // Phase 3：自動流程到「驗證完成」就停住，之後每一步都要人按下去。這些路徑只會執行使用者
  // 選的那一個動作；TaskFlow 不替他切換分支、不解衝突，也不在沒被要求時刪掉任何分支。
  app.get('/api/tasks/:id/git/review',(req,res)=>res.json(taskGitReview(store,req.user,req.params.id,{gitWorkspace})));
  app.post('/api/tasks/:id/git/decision',(req,res)=>{
    const input=z.object({decision:z.enum(['merge','changes','reject']),artifactVersion:z.string().max(200).optional(),answer:z.string().max(8000).optional(),keepBranch:z.boolean().optional(),cleanup:z.boolean().optional()}).strict().parse(req.body||{});
    // 不包在 store.transaction 裡：git merge 無法隨資料庫交易一起回滾，
    // 一旦合併成功卻因後續步驟回滾而在紀錄上消失，比多寫幾次任務更危險。
    res.json(decorated(decideGitReview(store,req.user,req.params.id,input,{gitWorkspace})));
  });
  // 舊的 v1/v2 工作副本只在使用者按下轉換時才會搬進 Git，而且原資料夾一律保留不刪。
  app.get('/api/tasks/:id/git/legacy',(req,res)=>res.json(legacyWorkspaceStatus(store,req.user,req.params.id)));
  app.post('/api/tasks/:id/git/migrate',(req,res)=>{z.object({}).strict().parse(req.body||{});res.json(decorated(migrateLegacyWorkspace(store,req.user,req.params.id,{gitWorkspace})));});
  // 測試比對只「開始」，不等結果：整套測試要跑好幾分鐘，同步等待一定逾時。
  // 結果寫回任務資料，前端沿用既有的三秒輪詢看進度。後端不接受任何指令字串，
  // 執行的永遠是專案自己的 npm test。
  app.post('/api/tasks/:id/completion/test',(req,res)=>{
    z.object({}).strict().parse(req.body||{});
    res.json(decorated(completionTests.start(store,req.user,req.params.id)));
  });
  app.post('/api/tasks/:id/git/rollback',(req,res)=>{
    const input=z.object({mergeCommit:z.string().min(7).max(64)}).strict().parse(req.body||{});
    res.json(decorated(rollbackTaskMerge(store,req.user,req.params.id,input,{gitWorkspace})));
  });
  // 只執行 deterministic recovery（讀已存在的原始回傳並重新整理格式）。這條路徑
  // 沒有任何引擎呼叫，也永遠不會重跑已完成的工作。
  app.post('/api/tasks/:id/output/recover',(req,res)=>{
    const input=z.object({issueId:z.string().optional()}).strict().parse(req.body||{});
    const outcome=store.transaction(()=>recoverTaskOutput(store,req.user,req.params.id,input));
    res.json({...decorated(outcome.task),recovery:outcome.recovery});
  });
  app.get('/api/tasks/:id/output/original',(req,res)=>res.json(taskOriginalOutput(store,req.user,req.params.id)));
  app.post('/api/tasks/:id/status',(req,res)=>res.json(decorated(changeTaskStatus(store,runner,req.user,req.params.id,req.body))));
  app.post('/api/tasks/:id/repair/approve',(req,res)=>res.json(decorated(approveRepair(store,req.user,req.params.id,req.body.proposalId))));
  app.post('/api/tasks/:id/repair/revise',(req,res)=>res.json(decorated(reviseRepair(store,req.user,req.params.id,req.body.proposalId,req.body.answer))));
  app.post('/api/tasks/:id/approve',(req,res)=>res.json(decorated(approveTask(store,req.user,req.params.id,req.body.version))));
  app.post('/api/tasks/:id/revise',(req,res)=>res.json(decorated(reviseTask(store,req.user,req.params.id,req.body.answer))));
  app.post('/api/tasks/:id/execution/decision',(req,res)=>res.json(decorated(store.transaction(()=>decideExecutionApproval(store,req.user,req.params.id,req.body)))));
  app.post('/api/tasks/:id/validation/decision',(req,res)=>res.json(decorated(store.transaction(()=>decideValidationSkip(store,req.user,req.params.id,req.body)))));
  app.post('/api/tasks/:id/user-action/decision',(req,res)=>res.json(decorated(store.transaction(()=>decideManualAction(store,req.user,req.params.id,req.body)))));
  app.post('/api/tasks/:id/action',(req,res)=>{const t=requireTask(store,req.user,req.params.id),action=z.enum(['pause','resume','cancel','stop','retry','publish-approve']).parse(req.body.action),active=store.threads(t.id).some(x=>x.status==='running');
    if(action==='pause'){if(!['planning','repair_planning','awaiting_repair_approval','rate_limited','queued','running'].includes(t.status))throw new HttpError(409,'此狀態無法暫停');t.resumeStatus=t.status==='planning'?'planning':'queued';t.status='paused';}
    if(['resume','retry'].includes(action)&&(t.outputIssue||t.environmentIssue||gitIssuePending(t)||t.userActionRequired?.status==='pending'))throw new HttpError(409,'請先審核問題處理方案；不能直接重跑工作');
    if(action==='resume'||action==='retry'){if(!['paused','failed'].includes(t.status)||active)throw new HttpError(409,'尚無法恢復，請等待目前工作結束');t.status=t.plan&&t.approvedVersion===t.planVersion?'queued':'planning';t.error=null;}
    // 取消時一併關閉待處理的人工請求，否則已取消的任務會繼續顯示「待我處理」。
    if(action==='cancel'){if(['completed','cancelled'].includes(t.status))throw new HttpError(409,'任務已結束');t.status='cancelled';t.resumeStatus=null;closePendingRequestsOnCancel(t,req.user);runner.stopTask(t.id);}
    if(action==='stop'){if(!active)throw new HttpError(409,'目前沒有正在執行的工作');t.status='paused';t.error='已中止執行，請檢查工作副本後恢復。';runner.stopTask(t.id);}
    if(action==='publish-approve'){if(t.status!=='completed'||t.manualCompletion||!t.artifactVersion||req.body.artifactVersion!==t.artifactVersion)throw new HttpError(409,'成果版本不符');t.publishApproval={by:req.user.id,at:new Date().toISOString(),artifactVersion:t.artifactVersion};}
    store.saveTask(t);store.event(t.id,action,action==='publish-approve'?`${req.user.name} 核准此版成果發布；尚未執行對外發布`:`${req.user.name}：${action}`);res.json(decorated(t));});
  app.post('/api/tasks/:id/priority',(req,res)=>{const t=requireTask(store,req.user,req.params.id);t.priority=z.number().int().min(0).max(3).parse(req.body.priority);store.saveTask(t);res.json({ok:true});});
  app.post('/api/reorder',(req,res)=>{const ids=z.array(z.string().uuid()).max(500).parse(req.body.ids);if(new Set(ids).size!==ids.length)throw new HttpError(400,'重複任務');const tasks=ids.map(tid=>requireTask(store,req.user,tid));store.transaction(()=>{const positions=tasks.map(t=>t.position).sort((a,b)=>a-b);tasks.forEach((t,i)=>{t.position=positions[i]+i*0.001;store.saveTask(t);});});res.json({ok:true});});
  app.get('/api/tasks/:id/artifacts',(req,res)=>{const t=requireTask(store,req.user,req.params.id);const files=[];if(t.workspace&&existsSync(t.workspace)){const walk=(dir,depth=0)=>{if(depth>12||files.length>=500)return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink()||['node_modules','.git','.venv'].includes(entry.name)||entry.name.startsWith('.env'))continue;const p=join(dir,entry.name);if(entry.isDirectory())walk(p,depth+1);else if(files.length<500)files.push({path:relative(t.workspace,p).replaceAll('\\','/'),size:lstatSync(p).size});}};walk(t.workspace);}res.json({files,note:'工作副本中的檔案（含原始專案），最多列出 500 個。'});});
  app.get('/api/tasks/:id/download',(req,res)=>{const t=requireTask(store,req.user,req.params.id);if(!t.workspace)throw new HttpError(404,'尚無成果');const input=z.string().max(1000).parse(req.query.path);const path=resolve(t.workspace,input);if(!existsSync(path))throw new HttpError(404,'檔案不存在');const rel=relative(realpathSync(t.workspace),realpathSync(path));if(rel.startsWith('..')||isAbsolute(rel)||rel.split(/[\\/]/).some(p=>p.startsWith('.env')||['.git','.ssh','.aws','.codex','.claude'].includes(p))||/\.(pem|key|pfx)$/i.test(rel)||!lstatSync(path).isFile())throw new HttpError(403,'不允許存取');res.download(path);});
  app.post('/api/account/password',(req,res)=>{const input=z.object({current:z.string().max(200),password:z.string().min(12).max(200)}).parse(req.body);const u=store.db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);if(!passwordMatches(input.current,u.password))throw new HttpError(400,'目前密碼不正確');store.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(input.password),req.user.id);store.db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id,req.sessionHash);res.json({ok:true});});
  app.get('/api/account/line-links',(req,res)=>{const pending=store.db.prepare('SELECT link_expires FROM users WHERE id=? AND link_hash IS NOT NULL AND link_expires>?').get(req.user.id,Date.now());res.json({links:store.lineLinks(req.user.id).map(({line_id,...link})=>({...link,lineHint:line_id.slice(0,5)+'…'+line_id.slice(-5),notifications:!!link.notifications})),pendingExpires:pending?.link_expires||null});});
  app.post('/api/account/line-link',(req,res)=>{const input=z.object({label:z.string().trim().max(80).default('LINE')}).parse(req.body);const code=randomBytes(18).toString('base64url');const expires=Date.now()+10*60000;store.db.prepare('UPDATE users SET link_hash=?,link_expires=?,link_label=? WHERE id=?').run(hash(code),expires,input.label||'LINE',req.user.id);res.json({command:`/link ${code}`,expiresMinutes:10,expiresAt:expires});});
  app.post('/api/account/line-link/cancel',(req,res)=>{store.db.prepare('UPDATE users SET link_hash=NULL,link_expires=NULL WHERE id=?').run(req.user.id);res.json({ok:true});});
  app.post('/api/account/line-links/:id/update',(req,res)=>{const input=z.object({label:z.string().trim().min(1).max(80).optional(),notifications:z.boolean().optional()}).strict().refine(v=>v.label!==undefined||v.notifications!==undefined).parse(req.body);const link=store.lineLinks(req.user.id).find(l=>l.id===req.params.id);if(!link)throw new HttpError(404,'找不到此 LINE 連結');store.db.prepare('UPDATE line_links SET label=?,notifications=? WHERE id=? AND user_id=?').run(input.label??link.label,input.notifications===undefined?link.notifications:Number(input.notifications),link.id,req.user.id);res.json({ok:true});});
  app.post('/api/account/line-links/:id/remove',(req,res)=>{if(req.body.confirm!==true)throw new HttpError(400,'請確認解除 LINE 連結');if(!store.unlinkLine(req.user.id,req.params.id))throw new HttpError(404,'找不到此 LINE 連結');res.json({ok:true});});
  app.get('/api/admin/users',admin,(req,res)=>res.json(store.db.prepare('SELECT id,name,username,role,line_id FROM users').all().map(u=>({...u,projectIds:store.db.prepare('SELECT project_id FROM memberships WHERE user_id=?').all(u.id).map(x=>x.project_id)}))));
  app.post('/api/admin/users',admin,(req,res)=>{const input=z.object({name:z.string().min(1).max(80),username:z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/),password:z.string().min(12).max(200),projectIds:z.array(z.string().uuid()).default([])}).parse(req.body);const u=store.transaction(()=>{for(const pid of input.projectIds)if(!store.project(pid))throw new HttpError(400,'專案不存在');const created=store.addUser(input.name,input.username,input.password);for(const pid of input.projectIds)store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(created.id,pid);return created;});res.status(201).json(u);});
  app.post('/api/admin/users/:id/projects',admin,(req,res)=>{const pids=z.array(z.string().uuid()).parse(req.body.projectIds);if(!store.user(req.params.id))throw new HttpError(404,'成員不存在');store.transaction(()=>{store.db.prepare('DELETE FROM memberships WHERE user_id=?').run(req.params.id);for(const pid of pids){if(!store.project(pid))throw new HttpError(400,'專案不存在');store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(req.params.id,pid);}});res.json({ok:true});});
  app.post('/api/admin/projects/:id/previews/stop',admin,async(req,res)=>{if(!store.project(req.params.id))throw new HttpError(404,'找不到專案');await previews.stopProject(req.params.id);res.json({ok:true});});
  app.get('/api/admin/projects/:id/removal',admin,(req,res)=>res.json(projectRemovalPlan(store,runner,previews,req.params.id)));
  app.post('/api/admin/projects/:id/remove',admin,(req,res)=>{const input=z.object({confirmCode:z.string(),fingerprint:z.string()}).strict().parse(req.body);res.json(removeProject(store,runner,previews,req.params.id,input));});
  app.post('/api/admin/projects',admin,(req,res)=>{
    const p=z.object({name:z.string().trim().min(1).max(100),code:z.string().regex(/^[a-zA-Z0-9_-]{2,32}$/),path:z.string().trim().min(1).max(1000),createIfMissing:z.boolean().default(false)}).parse(req.body);
    if(store.db.prepare('SELECT id FROM projects WHERE code=?').get(p.code))throw new HttpError(409,'此專案代號已存在，請使用其他代號');
    const directory=prepareProjectDirectory(p.path,{createIfMissing:p.createIfMissing});
    const pid=id();store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,p.code,p.name,directory.path);
    res.status(201).json({...store.project(pid),directoryCreated:directory.created});
  });
  app.post('/api/admin/project-root',admin,(req,res)=>{
    const input=z.string().trim().min(1).max(1000).parse(req.body.path);
    const directory=prepareProjectDirectory(input,{createIfMissing:true});
    store.setSetting('defaultProjectRoot',directory.path);
    res.json({path:directory.path,created:directory.created});
  });
  app.post('/api/admin/runner',admin,(req,res)=>{const input=z.object({enabled:z.boolean().optional(),maxConcurrent:z.number().int().min(1).max(32).optional()}).strict().refine(v=>v.enabled!==undefined||v.maxConcurrent!==undefined).parse(req.body);if(input.enabled!==undefined)store.setSetting('runnerEnabled',input.enabled);if(input.maxConcurrent!==undefined)store.setSetting('runnerMaxConcurrent',input.maxConcurrent);res.json({ok:true});});
  // Unknown API endpoints must never fall through to the Vue HTML entry point.
  app.use('/api',(req,res)=>res.status(404).json({error:'找不到此功能，服務可能仍在更新，請重新整理後再試。'}));
  if(existsSync(dist)){app.use(express.static(dist));app.get('/{*path}',(req,res)=>res.sendFile(join(dist,'index.html')));}
  app.use((error,req,res,next)=>{const status=error instanceof z.ZodError?400:error.code==='GIT_SAFETY'?409:error.status||500;res.status(status).json({error:error instanceof z.ZodError?'欄位格式不正確：'+error.issues.map(i=>`${i.path.join('.')} ${i.message}`).join('；'):status===500?'伺服器錯誤；請檢查資料是否重複或服務紀錄。':error.message});if(status===500)console.error(error.message);});
  return app;
}
