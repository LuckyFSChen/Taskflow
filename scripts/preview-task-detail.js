// Disposable local UI verification fixture for the Task Detail information layering
// (概覽 / 執行進度 / 成果 / 技術資訊). It never starts the runner, never spawns a CLI
// engine and never sends a LINE message: it only seeds a throwaway SQLite file with
// one task per state so the drawer can be checked in a real browser.
//
//   npm run build && node scripts/preview-task-detail.js
//   → http://127.0.0.1:14314   帳號 admin / 密碼 task-detail-ui-fixture
//
// 每個任務都對應一種真實狀態，包含需要使用者處理的五種情況。
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createApp} from '../server/app.js';

const root=mkdtempSync(join(tmpdir(),'tf-task-detail-ui-'));
const workspace=join(root,'workspace');
mkdirSync(join(workspace,'src'),{recursive:true});
writeFileSync(join(workspace,'README.md'),'# 測試工作副本\n');
writeFileSync(join(workspace,'src','login.js'),'export function login(){return true;}\n');

const store=createStore(join(root,'db.sqlite'));
// 這份 fixture 跑在自己的連接埠，Origin 檢查要指向它，否則登入會被擋成「不允許的來源」。
store.setSetting('publicOrigin','http://127.0.0.1:14314');
const admin=store.addUser('測試管理者','admin','task-detail-ui-fixture','admin');
const projectId=id();
store.db.prepare('INSERT INTO projects(id,code,name,path) VALUES (?,?,?,?)').run(projectId,'demo','示範專案',workspace);

const iso=minutesAgo=>new Date(Date.now()-minutesAgo*60000).toISOString();
let position=0;

function task(extra){
  const t={
    id:id(),ownerId:admin.id,projectId,status:'running',priority:1,position:position++,
    type:'code',planner:'claude',executor:'codex',reviewer:'claude',
    created:iso(180),planVersion:1,approvedVersion:1,round:0,questions:[],error:null,workspace,
    title:'未命名',description:'用於 UI 驗證的測試需求。',
    plan:{summary:'先分析登入流程，再修改程式，最後執行測試。',acceptance:['登入成功後導向工作總覽','瀏覽器主控台沒有錯誤'],questions:[],
      steps:[{title:'分析需求',role:'需求分析',instructions:'閱讀既有登入流程與相關測試。'},
             {title:'修改程式',role:'實作',instructions:'修正登入後導向錯誤的問題。'},
             {title:'執行測試',role:'實作',instructions:'執行 npm test 並附上輸出。'}]},
    ...extra};
  store.saveTask(t);
  store.event(t.id,'created','任務已建立，等待根節點規劃');
  return t;
}
function thread(t,extra){
  const th={id:id(),taskId:t.id,version:1,round:0,phase:'execute',engine:'codex',role:'實作',title:'修改程式',
    status:'completed',started:iso(90),finished:iso(85),summary:null,result:null,sessionId:'sess-'+id().slice(0,8),error:null,...extra};
  store.saveThread(th);
  store.event(t.id,'started',`${th.role} 開始工作`,th.id);
  store.event(t.id,'activity',`${th.role}：${th.summary||'執行中'}`,th.id);
  return th;
}
const result=extra=>({summary:'',questions:[],artifacts:[],passed:true,evidence:[],
  browserValidation:{required:false,status:'not_required',executed:false,passed:null,toolUsed:false,toolCallCount:0,categories:{},url:null,checks:[],consoleErrors:[],networkErrors:[],notes:'',error:null},
  userActionRequired:{required:false,reason:null,actionType:null,commands:[],workingDirectory:null,instructions:null,verification:[],requiresAdministrator:null},...extra});

// 1. 一般任務：第一步完成，第二步正在執行。
const normal=task({title:'1 一般任務：執行中',description:'登入後應該導向工作總覽，目前會停在空白頁。'});
thread(normal,{phase:'plan',role:'需求規劃',title:'整理需求與驗收',engine:'claude',summary:'整理出三個步驟與兩項驗收條件。',result:result({summary:'整理出三個步驟。',evidence:['讀取 src/login.js']})});
thread(normal,{title:'分析需求',role:'需求分析',summary:'確認導向邏輯寫在 login.js。',result:result({summary:'確認導向邏輯寫在 login.js。',evidence:['grep redirect src/login.js：找到 1 處']})});
thread(normal,{title:'修改程式',status:'running',started:iso(4),finished:null,summary:null,result:null});

// 2. waiting_input：AI 提出問題。
const asking=task({title:'2 等待回答：AI 需要補充資訊',status:'waiting_input',questions:['導向的預設頁面要用工作總覽還是任務佇列？','舊的 session 需要一併清除嗎？']});
thread(asking,{title:'分析需求',role:'需求分析',summary:'需要確認導向目標後才能繼續。',result:result({summary:'需要確認導向目標。',passed:false,questions:['導向的預設頁面要用工作總覽還是任務佇列？'],evidence:['讀取 src/login.js']})});

// 3. manual action：需要使用者在本機執行指令。
const manual=task({title:'3 需要你的協助：本機執行指令',status:'waiting_input',
  userActionRequired:{status:'pending',required:true,threadId:null,phase:'execute',planVersion:1,
    reason:'安裝全域套件需要系統管理員權限，執行環境的核准機制已拒絕。',actionType:'run_command',category:'approval_required',
    commands:['npm install -g pnpm'],workingDirectory:workspace,
    instructions:'請以一般權限開啟 PowerShell 執行；若顯示權限不足再改用系統管理員。',
    verification:['pnpm -v 可以顯示版本'],requiresAdministrator:false,
    message:'npm ERR! code EACCES\nnpm ERR! requires elevation'}});
thread(manual,{title:'修改程式',summary:'安裝套件被拒絕，需要使用者協助。',result:result({summary:'安裝套件被拒絕。',passed:false,evidence:['npm install -g pnpm：requires elevation']})});

// 4. repair approval：驗證未通過，修正方案待審核。
const repair=task({title:'4 修正方案待審核',status:'awaiting_repair_approval',round:1,
  validationFailure:{threadId:null,summary:'測試沒有實際執行，無法確認登入導向已修好。',evidence:['npm test：沒有輸出'],questions:[]},
  repairPlan:{id:id(),round:1,planVersion:1,summary:'測試指令被工作目錄設定擋下，改在工作副本根目錄執行並補上導向的單元測試。',
    acceptance:['npm test 有輸出且全部通過','導向行為有對應測試'],questions:[],
    steps:[{title:'修正測試指令',role:'實作',instructions:'改在工作副本根目錄執行 npm test。'},
           {title:'補上導向測試',role:'實作',instructions:'新增登入後導向工作總覽的測試。'}]}});
thread(repair,{title:'分析需求',role:'需求分析',summary:'完成分析。',result:result({summary:'完成分析。',evidence:['讀取 src/login.js']})});
thread(repair,{title:'修改程式',summary:'已修改導向邏輯。',result:result({summary:'已修改導向邏輯。',evidence:['修改 src/login.js 第 12 行']})});
thread(repair,{title:'執行測試',summary:'測試沒有輸出。',result:result({summary:'測試沒有輸出。',passed:true,evidence:['npm test：沒有輸出']})});
thread(repair,{phase:'review',role:'獨立驗證',title:'檢查成果與驗收',engine:'claude',summary:'測試沒有實際執行，無法確認。',result:result({summary:'測試沒有實際執行，無法確認。',passed:false,evidence:['npm test：沒有輸出']})});
thread(repair,{phase:'repair_plan',round:1,role:'修正方案分析',title:'第 1 輪修正方案',engine:'claude',summary:'提出兩個修正步驟。',result:result({summary:'提出兩個修正步驟。',evidence:['讀取 package.json']})});

// 5. output issue：成果報告不完整。
const output=task({title:'5 成果報告不完整',status:'waiting_input',
  outputIssue:{id:id(),planVersion:1,threadId:null,phase:'review',at:iso(20),
    message:'questions：Required\nevidence：Expected array, received string',
    issues:['questions：Required','evidence：Expected array, received string'],
    recovery:{ok:false,missing:['summary','evidence'],reason:'原始回傳沒有可用的工作摘要，無法在不重新執行的情況下補齊。',notes:['已讀取原始回傳','沒有重新執行任何角色']}}});
thread(output,{title:'執行測試',summary:'回傳格式不完整。',result:result({summary:'回傳格式不完整。',passed:false,evidence:[]})});

// 6. completed：通過驗證、有成果檔案、Browser 驗證通過、等待發布核准。
const done=task({title:'6 已完成：成果與 Browser 驗證',status:'completed',artifactVersion:'artifact-'+id().slice(0,8)});
thread(done,{title:'分析需求',role:'需求分析',summary:'完成分析。',result:result({summary:'完成分析。',evidence:['讀取 src/login.js']})});
thread(done,{title:'修改程式',summary:'修正導向邏輯。',result:result({summary:'修正導向邏輯。',evidence:['修改 src/login.js 第 12 行']})});
thread(done,{title:'執行測試',summary:'測試全部通過。',result:result({summary:'測試全部通過。',evidence:['npm test：12 passed, 0 failed']})});
thread(done,{phase:'review',role:'獨立驗證',title:'檢查成果與驗收',engine:'claude',summary:'兩項驗收條件都以實際執行確認。',
  result:result({summary:'兩項驗收條件都以實際執行確認。',evidence:['npm test：12 passed','瀏覽器主控台沒有錯誤訊息'],artifacts:['src/login.js'],
    browserValidation:{required:true,status:'passed',executed:true,passed:true,toolUsed:true,toolCallCount:6,categories:{navigate:1,interact:3,console:2},
      url:'http://127.0.0.1:5173/',checks:[{description:'登入後導向工作總覽',passed:true},{description:'主控台沒有錯誤',passed:true}],
      consoleErrors:[],networkErrors:[],notes:'以 Playwright MCP 實際操作登入流程。',error:null}})});

// 7. Browser 驗證受阻：沒有偵測到工具呼叫，不得當成通過。
const blocked=task({title:'7 Browser 驗證受阻（未驗證）',status:'failed',error:'Browser 驗證未取得實際工具呼叫證據。'});
thread(blocked,{title:'執行測試',summary:'宣稱已用瀏覽器檢查。',result:result({summary:'宣稱已用瀏覽器檢查。',passed:false,evidence:['npm test：3 passed'],
  browserValidation:{required:true,status:'blocked',executed:false,passed:false,toolUsed:false,toolCallCount:0,categories:{},url:null,checks:[],
    consoleErrors:[],networkErrors:[],notes:'',error:'未偵測到 Browser MCP 工具呼叫，不採信宣稱的通過結果。'}})});

// 8. 計畫待審核。
const pending=task({title:'8 計畫待審核',status:'awaiting_approval',approvedVersion:null});
thread(pending,{phase:'plan',role:'需求規劃',title:'整理需求與驗收',engine:'claude',summary:'整理出三個步驟與兩項驗收條件。',result:result({summary:'整理出三個步驟。',evidence:['讀取 src/login.js']})});

// 9. execution approval：AI 請求核准一項操作（由既有 thread 結果推導）。
const approval=task({title:'9 需要核准一項操作',status:'waiting_input',questions:['是否核准刪除舊的 sessions 資料表？']});
thread(approval,{title:'修改程式',summary:'需要授權才能刪除資料表。',result:result({summary:'需要授權才能刪除資料表。',passed:false,questions:['是否核准刪除舊的 sessions 資料表？'],evidence:['讀取 migrations/001.sql']})});

// 10. validation skip：驗證工具存取失敗，待使用者決定是否跳過。
const skip=task({title:'10 驗證工具受限，待你決定',status:'waiting_input'});
thread(skip,{phase:'review',role:'獨立驗證',title:'檢查成果與驗收',engine:'claude',summary:'驗證工具存取失敗：Browser Use 被 security policy 拒絕，無法開啟頁面確認。',
  result:result({summary:'驗證工具存取失敗：Browser Use 被 security policy 拒絕，無法開啟頁面確認。',passed:false,evidence:['npm test：5 passed']})});
const skipTask=store.task(skip.id);
skipTask.validationFailure={threadId:store.threads(skip.id).at(-1).id,summary:'驗證工具存取失敗，無法確認畫面行為。',evidence:[],questions:[]};
store.saveTask(skipTask);

const app=createApp(store,{status:{},stop(){}},{dist:resolve('dist')});
const server=app.listen(14314,'127.0.0.1',()=>console.log('Task detail fixture: http://127.0.0.1:14314  admin / task-detail-ui-fixture'));
function stop(){server.close(()=>{store.close();rmSync(root,{recursive:true,force:true});process.exit(0);});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
// 忘了關也不會一直佔著連接埠：一小時後自己收掉，連同暫存資料夾一起刪除。
setTimeout(()=>{console.log('Fixture 已逾時自動關閉。');stop();},60*60*1000).unref();
