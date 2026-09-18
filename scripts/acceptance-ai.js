import 'dotenv/config';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createTask,approveTask} from '../server/domain.js';
import {createRunner} from '../server/runner.js';
const dir=resolve('data','validation',`workflow-${Date.now()}`),source=join(dir,'source');mkdirSync(source,{recursive:true});writeFileSync(join(source,'INPUT.txt'),'TASKFLOW_ACCEPTANCE_2026');
const store=createStore(join(dir,'validation.sqlite'));const user=store.addUser('Validation','validation','isolated-validation-account','admin'),pid=id();store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'fixture','Acceptance fixture',source);
const task=createTask(store,user,{title:'真實雙引擎交接驗證',description:'這是一個已授權的隔離驗收測試。只需一個執行步驟：讀取 INPUT.txt，建立 DELIVERY.md，內容只有 INPUT.txt 的原文加換行。不得修改 INPUT.txt，也不需研究或其他檔案。驗收是讀取 DELIVERY.md 確認與 INPUT.txt 一致。不需詢問，格式已明確指定。',projectId:pid,type:'code',planner:'claude',executor:'codex',reviewer:'claude'});
const runner=createRunner(store,{dataDir:join(dir,'runtime'),recover:false});store.setSetting('runnerEnabled',true);
const start=Date.now();let completed=false;
try {
  for(let i=0;i<15;i++){
    await runner.tick();const current=store.task(task.id);console.log(`${i+1}. ${current.status}`);
    if(current.status==='awaiting_approval'){approveTask(store,user,task.id,current.planVersion);continue;}
    if(current.status==='completed'){completed=true;break;}
    if(['waiting_input','failed','paused','cancelled'].includes(current.status))throw new Error(current.error||JSON.stringify(current.questions));
  }
  const current=store.task(task.id);if(!completed)throw new Error('Workflow did not complete within 15 dispatches');
  const file=join(current.workspace,'DELIVERY.md');if(!existsSync(file)||readFileSync(file,'utf8').trim()!=='TASKFLOW_ACCEPTANCE_2026')throw new Error('Delivered file content is incorrect');
  if(existsSync(join(source,'DELIVERY.md')))throw new Error('Original source was unexpectedly modified');
  const report={passed:true,at:new Date().toISOString(),elapsedSeconds:Math.round((Date.now()-start)/1000),taskId:task.id,threads:store.threads(task.id).map(t=>({role:t.role,engine:t.engine,status:t.status,sessionId:t.sessionId,summary:t.summary})),checks:['real Claude planning','versioned approval','real Codex file creation','real Claude independent review','output content checked by Node','original source unchanged']};writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){const report={passed:false,error:e.message,task:store.task(task.id),threads:store.threads(task.id)};writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));console.error(e.message);process.exitCode=1;}finally{runner.stop();store.close();}
