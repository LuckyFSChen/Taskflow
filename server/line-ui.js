import {approveRepair} from './repair-approval.js';
import {executionApproval,decideExecutionApproval} from './execution-approval.js';
import {validationSkipRequest,decideValidationSkip} from './validation-skip.js';
import {randomUUID} from 'node:crypto';
import {createTask,approveTask,reviseTask,requireTask} from './domain.js';
import {lineProjectLocation,createLineProject} from './line-projects.js';
import {createTaskWithProject,taskProjectLocation} from './task-project.js';
import {changeTaskStatus} from './task-status.js';
import {threadPresentation} from './thread-presentation.js';
import {gitIssuePending} from './git-issue.js';

export const menuButtons=[['發布任務','tf:new'],['建立專案','tf:create-project'],['任務進度','tf:status:0'],['待我審核','tf:pending:0'],['工作台','tf:web'],['重啟服務','tf:service-restart'],['最新網址','tf:service-url']];
export function lineMessage(text,buttons=menuButtons){const message={type:'text',text:text.slice(0,4900)};if(buttons.length)message.quickReply={items:buttons.slice(0,13).map(([label,data])=>({type:'action',action:{type:'postback',label:label.slice(0,20),data,displayText:label.slice(0,100)}}))};return message;}
const statuses={planning:'等待規劃',awaiting_approval:'待審核',queued:'排隊中',running:'執行中',waiting_input:'等待回答',paused:'已暫停',completed:'已完成',repair_planning:'分析修正方案',awaiting_repair_approval:'待審核修正方案',rate_limited:'等待額度恢復',failed:'需要處理',cancelled:'已取消'};
const cancelButton=['取消發布','tf:cancel'];
const attentionStatuses=['awaiting_approval','awaiting_repair_approval','waiting_input','failed'];
function progressSummary(store,task){
  const threads=store.threads(task.id).filter(th=>th.version===task.planVersion),latest=threads.at(-1);
  const done=threads.filter(th=>th.phase==='execute'&&th.status==='completed'&&th.result?.passed&&!th.result.questions?.length).length;
  let text=task.manualCompletion?'手動完成（未代表驗證通過）':statuses[task.status]||task.status;
  if(task.plan?.steps?.length)text+=`｜${done}/${task.plan.steps.length} 步驟`;
  if(latest)text+=`\n最近角色：${latest.role||latest.phase}｜${threadPresentation(latest).statusLabel||statuses[latest.status]||latest.status}`;
  const skip=validationSkipRequest(store,task);
  // Git 守門在 LINE 上只說明狀況並指向網頁：確認保留未提交修改這種決定需要看到完整檔案清單，
  // 不適合用一個 quick reply 按鈕代替。
  const next=skip?'選擇是否跳過受限驗證（仍記為未驗證）':executionApproval(store,task)?'核准或拒絕角色提出的操作':gitIssuePending(task)?`在網頁確認 Git 未提交修改（${task.gitIssue.fileCount??(task.gitIssue.files||[]).length} 個檔案）：保留修改並繼續、我已自行處理重新檢查，或取消任務`:task.environmentIssue?'處理套件環境後核准重新檢查':task.outputIssue?'查看回傳格式問題與原始結果':task.status==='awaiting_approval'?'閱讀並核准計畫':task.status==='awaiting_repair_approval'?'閱讀並審核修正方案':task.status==='waiting_input'?(task.questions||[]).join('；')||'查看角色紀錄並處理阻塞':task.status==='failed'?task.error||'查看錯誤並決定處理方式':'';
  if(next)text+='\n待處理：'+next.slice(0,180);
  return text;
}
export function handleLineUI(store,user,lineId,{text='',data='',delivery={}},runner) {
  const send=(text,buttons=menuButtons)=>store.enqueueLine(lineId,[lineMessage(text,buttons)],delivery);
  const load=()=>{const row=store.db.prepare('SELECT data,expires FROM line_flows WHERE user_id=? AND line_id=?').get(user.id,lineId);if(!row)return null;if(row.expires<Date.now()){clear();return null;}return JSON.parse(row.data);};
  const save=flow=>store.db.prepare('INSERT INTO line_flows VALUES (?,?,?,?) ON CONFLICT(user_id,line_id) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(user.id,lineId,JSON.stringify(flow),Date.now()+30*60000);
  const clear=()=>store.db.prepare('DELETE FROM line_flows WHERE user_id=? AND line_id=?').run(user.id,lineId);
  const check=(nonce,stage)=>{const flow=load();if(!flow||flow.id!==nonce||flow.stage!==stage)throw new Error('這個按鈕已失效，請使用最新訊息的按鈕，或重新發布任務。');return flow;};
  const accessibleProjects=()=>store.db.prepare('SELECT * FROM projects ORDER BY name,id').all().filter(p=>store.hasProject(user,p.id));
  const projectPage=(flow,page)=>{const all=accessibleProjects(),start=page*8,items=all.slice(start,start+8);if(!items.length){send('目前沒有可用專案，請先由管理者在工作台新增並分配專案。');return;}const buttons=items.map(p=>[p.name,`tf:project:${flow.id}:${p.id}`]);if(page>0)buttons.push(['上一頁',`tf:projects:${flow.id}:${page-1}`]);if(start+8<all.length)buttons.push(['下一頁',`tf:projects:${flow.id}:${page+1}`]);if(user.role==='admin')buttons.push(['建立專案','tf:create-project']);buttons.push(cancelButton);send('① 回覆專案名稱或代號選擇專案：\n'+items.map(p=>`${p.name}（${p.code}）`).join('\n'),buttons);};
  const ownTask=tid=>{const t=requireTask(store,user,tid);if(t.ownerId!==user.id)throw new Error('只能操作你自己的任務。');return t;};
  if(!data){const mapped={'建立專案':'tf:create-project','取消建立':'tf:cancel','發布任務':'tf:new','任務進度':'tf:status:0','待我審核':'tf:pending:0','主選單':'tf:home','選單':'tf:home','工作台':'tf:web','取消發布':'tf:cancel','取消':'tf:cancel','/status':'tf:status:0'};data=mapped[text]||'';}
  if(!data){
    const reply=text.trim().replace(/[。！!]+$/,'');
    const flow=load();
    const stateReply={'標記完成':'completed','結束任務':'completed','暫停任務':'paused','取消任務':'cancelled','恢復處理':'reopen'}[reply];
    if(stateReply&&(!flow||['review','task-control'].includes(flow.stage))){
      if(!flow){send('請先點「任務進度」選擇要修改的任務，再使用狀態按鈕。');return true;}
      data=`tf:state:${flow.id}:${stateReply}`;
    }
    if(flow?.stage==='execution-review'&&/^(核准|核准並繼續|核准執行|不核准|不核准，暫停任務)$/.test(reply))data=`tf:execution-decision:${flow.id}:${reply.startsWith('不')?'reject':'approve'}`;
    else if(/^(?:請|幫我|我要)?(?:建立|新增|發布)(?:一個)?任務$/.test(reply))data='tf:new';
    else if(/^(核准|核准執行|核准此版計畫|核准修正方案|同意執行|確認執行)$/.test(reply)){
      if(!['review','repair-review'].includes(flow?.stage)){send('請先回覆「待我審核」，選擇任務並查看計畫，再回覆「核准執行」。');return true;}
      data=flow.stage==='repair-review'?`tf:repair-approve:${flow.taskId}:${flow.proposalId}`:`tf:approve:${flow.taskId}:${flow.version}`;
    }
    else if(flow?.stage==='type'){
      if(['程式開發','程式','開發','code'].includes(reply))data=`tf:type:${flow.id}:code`;
      else if(['研究與文件','研究','文件','research'].includes(reply))data=`tf:type:${flow.id}:research`;
      else if(['改用既有專案','既有專案'].includes(reply))data=`tf:existing:${flow.id}`;
    }
    else if(flow?.stage==='project'){
      const candidates=accessibleProjects().filter(p=>p.name===reply||p.code===reply);
      if(candidates.length===1)data=`tf:project:${flow.id}:${candidates[0].id}`;
    }
    else if(flow?.stage==='confirm'&&reply==='確認發布')data=`tf:submit:${flow.id}`;
    else if(flow?.stage==='project-confirm'&&reply==='確認建立')data=`tf:confirm-project:${flow.id}`;
    else if(flow?.stage==='task-select'){
      if(/^[1-8]$/.test(reply)&&flow.tasks[Number(reply)-1])data=`tf:view:${flow.tasks[Number(reply)-1]}`;
      else if(reply==='下一頁')data=`tf:${flow.action}:${flow.page+1}`;
      else if(reply==='上一頁'&&flow.page>0)data=`tf:${flow.action}:${flow.page-1}`;
    }
    else if(flow?.stage==='review'&&['回答','修改需求','回答／修改需求'].includes(reply))data=`tf:answer:${flow.taskId}:${flow.version}`;
    if(!data&&['確認發布','確認建立'].includes(reply)){send('目前沒有等待這項確認的內容，請先回覆「建立任務」或「建立專案」。');return true;}
  }
  if(data){const parts=data.split(':'),action=parts[1];if(parts[0]!=='tf'){send('請使用下方快捷功能。');return true;}
    try {
      if(action==='state'){
        const flow=load();
        if(!flow||flow.id!==parts[2]||!['review','task-control'].includes(flow.stage))throw new Error('這個按鈕已失效，請重新查看任務。');
        const task=ownTask(flow.taskId);
        if(task.planVersion!==flow.version||(task.controlVersion||0)!==flow.controlVersion||task.status!==flow.expectedStatus)throw new Error('任務已更新，請重新查看後再修改狀態。');
        if(!runner&&store.threads(task.id).some(t=>t.status==='running'))throw new Error('無法連接任務執行服務，尚未修改狀態。');
        const updated=changeTaskStatus(store,runner||{stopTask:()=>{}},user,task.id,{status:parts[3],expectedStatus:flow.expectedStatus});
        clear();send(`${updated.title}\n狀態：${updated.manualCompletion?'手動完成（不代表 AI 驗證通過）':statuses[updated.status]}\n${['completed','cancelled','paused'].includes(updated.status)?'如有正在執行的 AI 工作，已要求停止。':'將依原有計畫與審核狀態繼續處理。'}`,[['查看任務',`tf:view:${task.id}`],...menuButtons]);return true;
      }
      if(action==='home'){clear();send('可直接聊天，或回覆「建立任務」、「任務進度」、「待我審核」。也可以使用下方按鈕。');return true;}
      if(action==='create-project'){
        if(user.role!=='admin')throw new Error('只有管理者可以建立專案，請聯絡管理者。');
        if(!store.setting('defaultProjectRoot',''))throw new Error('請先在平台設定填寫「預設專案存放位置」。');
        save({id:randomUUID(),stage:'project-name'});send('請輸入專案名稱，平台會以此名稱在預設位置建立資料夾。',[['取消建立','tf:cancel']]);return true;
      }
      if(action==='confirm-project'){
        const flow=check(parts[2],'project-confirm');
        const project=createLineProject(store,user,flow.name,flow.root);
        const next={id:randomUUID(),stage:'project'};save(next);
        send(`專案已建立：${project.name}\n資料夾：${project.path}\n可直接在這個專案發布任務。`,[['在此發布任務',`tf:project:${next.id}:${project.id}`],...menuButtons]);return true;
      }
      if(action==='cancel'){clear();send('已取消這次填寫，不會建立專案或發布任務。');return true;}
      if(action==='new'){
        const flow={id:randomUUID(),stage:user.role==='admin'?'type':'project',createProject:user.role==='admin'};save(flow);
        if(flow.createProject)send('預設依任務標題建立新專案。請回覆「程式開發」、「研究與文件」，或「改用既有專案」。',[['程式開發',`tf:type:${flow.id}:code`],['研究與文件',`tf:type:${flow.id}:research`],['改用既有專案',`tf:existing:${flow.id}`],cancelButton]);else projectPage(flow,0);return true;
      }
      if(action==='existing'){const flow=check(parts[2],'type');flow.createProject=false;flow.stage='project';save(flow);projectPage(flow,0);return true;}
      if(action==='projects'){const flow=check(parts[2],'project'),page=Number(parts[3]);if(!Number.isInteger(page)||page<0)throw new Error('無效的頁數');projectPage(flow,page);return true;}
      if(action==='project'){const flow=check(parts[2],'project');if(!store.hasProject(user,parts[3]))throw new Error('無法使用此專案，請聯絡管理者。');flow.projectId=parts[3];flow.stage='type';save(flow);send(`已選擇：${store.project(flow.projectId).name}\n② 回覆「程式開發」或「研究與文件」`,[['程式開發',`tf:type:${flow.id}:code`],['研究與文件',`tf:type:${flow.id}:research`],cancelButton]);return true;}
      if(action==='type'){const flow=check(parts[2],'type');if(!['code','research'].includes(parts[3]))throw new Error('無效的任務類型');flow.type=parts[3];flow.stage='title';save(flow);send('③ 請輸入任務標題（2～140 字）。', [cancelButton]);return true;}
      if(action==='submit'){const flow=check(parts[2],'confirm');const t=createTaskWithProject(store,user,{title:flow.title,description:flow.description,projectId:flow.projectId,createProject:flow.createProject===true,type:flow.type,priority:1,planner:'claude',executor:flow.type==='code'?'codex':'claude',reviewer:flow.type==='code'?'claude':'codex'},{expectedRoot:flow.projectRoot});clear();send(`已發布：${t.title}\n專案：${store.project(t.projectId).name}\nAI 會先整理計畫，經你審核後才開始執行。`,[['查看任務',`tf:view:${t.id}`],...menuButtons]);return true;}
      if(action==='status'||action==='pending'){const page=Number(parts[2]||0);if(!Number.isInteger(page)||page<0)throw new Error('無效的頁數');const tasks=store.tasks(user).filter(t=>t.ownerId===user.id&&(action==='status'||attentionStatuses.includes(t.status))).sort((a,b)=>Number(attentionStatuses.includes(b.status))-Number(attentionStatuses.includes(a.status))||String(b.updated||'').localeCompare(String(a.updated||'')));const list=tasks.slice(page*8,page*8+8);save({id:randomUUID(),stage:'task-select',tasks:list.map(t=>t.id),action,page});const buttons=list.map((t,i)=>[`${i+1}. ${t.title}`.slice(0,20),`tf:view:${t.id}`]);if(page>0)buttons.push(['上一頁',`tf:${action}:${page-1}`]);if((page+1)*8<tasks.length)buttons.push(['下一頁',`tf:${action}:${page+1}`]);buttons.push(['主選單','tf:home']);send(list.length?`最新任務狀態｜待處理 ${tasks.filter(t=>attentionStatuses.includes(t.status)).length} 項\n\n`+list.map((t,i)=>`${i+1}. ${t.title}\n${progressSummary(store,t)}`).join('\n\n')+'\n\n回覆編號查看任務，例如「1」。':action==='pending'?'目前沒有等待你處理的任務。':'目前沒有任務，點選「發布任務」開始。',list.length?buttons:menuButtons);return true;}
      if(action==='view'){
        const task=ownTask(parts[2]),skipRequest=validationSkipRequest(store,task);
        if(skipRequest){
          const flow={id:randomUUID(),stage:'validation-skip',taskId:task.id,requestId:skipRequest.id};save(flow);
          const body=task.title+'\n\n驗證工具存取失敗：是否跳過？\n'+skipRequest.summary+'\n\n僅跳過工具受限檢查（未驗證），其餘驗證仍須執行。';
          if(body.length>4800){clear();send('驗證報告較長，請至工作台查看完整範圍後決定。',[['工作台','tf:web']]);return true;}
          send(body,[['跳過受限驗證並繼續',`tf:validation-decision:${flow.id}:skip`],['不跳過，等待處理',`tf:validation-decision:${flow.id}:wait`],['工作台','tf:web']]);return true;
        }
        const t=ownTask(parts[2]),request=executionApproval(store,t);
        if(request){
          const flow={id:randomUUID(),stage:'execution-review',taskId:t.id,requestId:request.id};save(flow);
          const body=t.title+'\n\n需要你核准\n'+request.questions.join('\n\n')+'\n\n核准後接續原步驟；不核准則暫停任務。';
          if(body.length>4800){clear();send('核准內容較長，請至工作台閱讀完整內容並決定。',[['工作台','tf:web']]);return true;}
          send(body,[['核准並繼續',`tf:execution-decision:${flow.id}:approve`],['不核准，暫停任務',`tf:execution-decision:${flow.id}:reject`],['工作台','tf:web']]);return true;
        }
      }
      if(action==='view'){const t=ownTask(parts[2]);const controls={id:randomUUID(),stage:'task-control',taskId:t.id,version:t.planVersion,controlVersion:t.controlVersion||0,expectedStatus:t.status};save(controls);let body=`${t.title}\n狀態：${t.manualCompletion?'手動完成':statuses[t.status]||t.status}\n專案：${store.project(t.projectId)?.name}\n`;if(t.validationSkips?.some(s=>s.planVersion===t.planVersion))body+='\n部分驗證因工具存取失敗，經同意跳過（未驗證）。\n';if(t.status==='rate_limited')body+=`預計重試：${new Date(t.retryAt).toLocaleString('zh-TW',{timeZone:t.retryTimeZone})}（${t.retryTimeZone}）\n`;if(t.plan&&t.status!=='awaiting_repair_approval')body+=`\n計畫 v${t.planVersion}\n${t.plan.summary}\n\n驗收條件\n${t.plan.acceptance.map((a,i)=>`${i+1}. ${a}`).join('\n')}\n\n執行步驟\n${t.plan.steps.map((s,i)=>`${i+1}. ${s.title}（${s.role}）\n${s.instructions}`).join('\n')}\n\n引擎：${t.executor} 執行、${t.reviewer} 驗證`;
        if(t.questions.length)body+='\n\n需要確認\n'+t.questions.join('\n');if(t.error)body+='\n\n'+t.error;
        const buttons=[['任務進度','tf:status:0'],['主選單','tf:home']];
        for(const [label,status] of [['標記完成','completed'],['暫停任務','paused'],['取消任務','cancelled']])if(t.status!==status)buttons.unshift([label,`tf:state:${controls.id}:${status}`]);
        if(['completed','cancelled','paused','failed','waiting_input'].includes(t.status))buttons.unshift(['恢復處理',`tf:state:${controls.id}:reopen`]);
        body+='\n\n可點選下方按鈕修改狀態，也可回覆「標記完成」、「暫停任務」、「取消任務」或「恢復處理」。';
        if(body.length>18000){send(`${t.title}\n計畫內容較長，請至工作台完整閱讀並審核。`,[['工作台','tf:web'],['重啟服務','tf:service-restart'],['最新網址','tf:service-url'],...buttons]);return true;}
        if(t.validationFailure){body+=`\n驗證問題：${t.validationFailure.summary}\n證據：${t.validationFailure.evidence.join('；')}\n`;}
        if(t.repairPlan){body+=`\n第 ${t.round} 輪修正方案：${t.repairPlan.summary}\n${t.repairPlan.steps.map((s,i)=>`${i+1}. ${s.title}：${s.instructions}`).join('\n')}\n重新驗證：${t.repairPlan.acceptance.join('；')}\n`;}
        if(t.status==='awaiting_repair_approval'){
          if(body.length>4200){body=`${t.title}\n修正方案較長，請到網頁查看完整問題、原因與解法後核准；本則訊息不提供直接核准。`;}
          else if(t.repairPlan.questions.length){body+='\n方案仍有待確認問題，請到網頁補充：'+t.repairPlan.questions.join('；');}
          else{save({...controls,stage:'repair-review',proposalId:t.repairPlan.id});body+='\n查看上述修正方案後，回覆「核准修正方案」才會執行；也可到網頁補充或修改。';buttons.unshift(['核准修正方案',`tf:repair-approve:${t.id}:${t.repairPlan.id}`]);}
        }
        if(t.status==='awaiting_approval'&&!t.questions.length){save({...controls,stage:'review'});body+='\n\n回覆「核准執行」核准此任務的上述版本，或回覆「修改需求」。';buttons.unshift(['核准此版計畫',`tf:approve:${t.id}:${t.planVersion}`]);}
        if(['waiting_input','awaiting_approval','failed','paused'].includes(t.status))buttons.unshift(['回答／修改需求',`tf:answer:${t.id}:${t.planVersion}`]);
        const chunks=body.match(/[\s\S]{1,4000}/g)||[''];store.enqueueLine(lineId,chunks.map((c,i)=>lineMessage(c,i===chunks.length-1?buttons:[])),delivery);return true;}
      if(action==='repair-approve'){ownTask(parts[2]);approveRepair(store,user,parts[2],parts[3]);clear();send('此修正方案已核准，修正後會再次獨立驗證。',[['查看任務',`tf:view:${parts[2]}`],...menuButtons]);return true;}
      if(action==='execution-decision'){
        const flow=check(parts[2],'execution-review');ownTask(flow.taskId);
        store.transaction(()=>decideExecutionApproval(store,user,flow.taskId,{requestId:flow.requestId,decision:parts[3]}));
        clear();send(parts[3]==='approve'?'已核准操作，接續原步驟，保留既有計畫與成果。':'已不核准操作，任務已暫停。',[['查看任務',`tf:view:${flow.taskId}`],...menuButtons]);return true;
      }
      if(action==='validation-decision'){
        const flow=check(parts[2],'validation-skip');ownTask(flow.taskId);
        store.transaction(()=>decideValidationSkip(store,user,flow.taskId,{requestId:flow.requestId,decision:parts[3]}));clear();
        send(parts[3]==='skip'?'已記錄跳過受限檢查（未驗證），繼續驗證其他項目。':'不跳過，任務暫停等待處理。',[['查看任務',`tf:view:${flow.taskId}`],...menuButtons]);return true;
      }
      if(action==='approve'){ownTask(parts[2]);approveTask(store,user,parts[2],Number(parts[3]));clear();send('計畫已核准，會依優先順序執行。', [['查看任務',`tf:view:${parts[2]}`],...menuButtons]);return true;}
      if(action==='answer'){const t=ownTask(parts[2]);if(t.planVersion!==Number(parts[3])||!['waiting_input','awaiting_approval','failed','paused'].includes(t.status))throw new Error('此任務已更新，請重新查看。');save({id:randomUUID(),stage:'answer',taskId:t.id,version:t.planVersion});send(`請直接輸入「${t.title}」的回答或需求修改內容。\n送出後會重新規劃並請你審核。`,[['取消回答','tf:cancel']]);return true;}
      if(action==='web'){let url;try{url=new URL(store.setting('publicOrigin',process.env.PUBLIC_ORIGIN)||'http://localhost:4310');}catch{}if(url?.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){const m=lineMessage('開啟工作台，查看完整角色紀錄與成果。');m.quickReply.items.unshift({type:'action',action:{type:'uri',label:'開啟工作台',uri:url.origin}});store.enqueueLine(lineId,[m],delivery);}else send('工作台目前只在 Windows 電腦上開放：\nhttp://localhost:4310\n請在那台電腦開啟。手機可直接用這裡的選單發布、追蹤與審核任務；完整網頁的外部連線尚未設定。');return true;}
      send('請使用下方快捷功能。');return true;
    }catch(e){send(`無法完成：${e.message}`);return true;}
  }
  if(text.startsWith('/'))return false;
  const flow=load();if(!flow)return false;
  if(flow.stage==='project-name'){
    try{const location=lineProjectLocation(store,user,text);flow.name=location.name;flow.root=location.root;flow.stage='project-confirm';save(flow);send(`確認建立專案\n名稱：${location.name}\n資料夾：${location.path}`, [['確認建立',`tf:confirm-project:${flow.id}`],['重新命名','tf:create-project'],['取消建立','tf:cancel']]);}
    catch(e){send(e.message,[['重新輸入名稱','tf:create-project'],['取消建立','tf:cancel']]);}
    return true;
  }
  if(flow.stage==='title'){if(text.length<2||text.length>140){send('標題請輸入 2～140 字。',[cancelButton]);return true;}flow.title=text;flow.stage='description';save(flow);send('④ 請描述詳細需求、限制與預期成果（至少 5 字）。',[cancelButton]);return true;}
  if(flow.stage==='description'){if(text.length<5||text.length>16000){send('需求請輸入 5～16,000 字。',[cancelButton]);return true;}let projectLabel=flow.projectId?store.project(flow.projectId)?.name:'';if(flow.createProject){try{const location=taskProjectLocation(store,user,flow.title);flow.projectRoot=location.root;projectLabel=`新建 ${location.name}\n資料夾：${location.path}`;}catch(e){send(e.message,[['重新發布','tf:new'],cancelButton]);return true;}}flow.description=text;flow.stage='confirm';save(flow);send(`確認發布\n專案：${projectLabel}\n類型：${flow.type==='code'?'程式開發':'研究與文件'}\n標題：${flow.title}\n需求：${text.slice(0,3500)}${text.length>3500?'\n（預覽截短，完整需求會保存）':''}\n\nAI 先規劃，核准後才執行。\n請回覆「確認發布」或「取消」。`,[['確認發布',`tf:submit:${flow.id}`],cancelButton]);return true;}
  if(flow.stage==='answer'){try{const task=ownTask(flow.taskId);if(task.planVersion!==flow.version)throw new Error('需求版本已更新，請重新查看任務。');reviseTask(store,user,flow.taskId,text);clear();send('回答已收到，AI 會重新整理計畫。');}catch(e){send(e.message);}return true;}
  if(flow.stage==='review')return false;
  return false;
}
