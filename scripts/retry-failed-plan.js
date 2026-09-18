import 'dotenv/config';
import {join,resolve} from 'node:path';
import {createStore,id,now} from '../server/db.js';
import {cliAdapter} from '../server/runner.js';
import {planJson,planSchema} from '../server/domain.js';
const s=createStore(),t=s.task(process.argv[2]);
if(!t||t.status!=='failed'||t.plan||!t.workspace||s.threads(t.id).some(x=>x.status==='running'))throw Error('Only an idle failed planning task can be retried');
const revision=t.controlVersion||0;
const thread={id:id(),taskId:t.id,version:t.planVersion,round:t.round,phase:'plan',engine:t.planner,role:'需求規劃',title:'重試規劃回傳格式',status:'running',started:now(),finished:null,summary:null,result:null,sessionId:null,error:null};
t.status='paused';t.error='正在重試規劃回傳格式';s.saveTask(t);s.saveThread(thread);s.event(t.id,'started','保留原需求版本，使用完整輸出契約重試唯讀規劃。',thread.id);
try{
const output=await cliAdapter({engine:t.planner,cwd:t.workspace,runDir:resolve('data/runs',thread.id),readOnly:true,schema:planJson,onEvent:message=>s.event(t.id,'activity',message,thread.id),prompt:`你是 TaskFlow 需求規劃角色，使用繁體中文。只唯讀檢查，不改檔、不部署、不讀取秘密。任務標題：${t.title}\n完整需求與歷次補充：${t.description}\n依最新補充整合既有決定，不重問已經回答的事項。最多8步；最終驗證由平台額外安排。先前失敗是缺少 acceptance/questions/steps，請回傳完整的 summary、acceptance、questions、steps，每一步包含 title、role、instructions。尚需澄清時 questions 列出具體問題，但仍須回傳完整結構，不可僅有 summary。`});
const result=planSchema.parse(output.result),current=s.task(t.id);
if(current.planVersion!==t.planVersion||(current.controlVersion||0)!==revision||current.status!=='paused'||current.error!=='正在重試規劃回傳格式'){thread.status='cancelled';thread.summary='任務已更新，未套用晚到的規劃。';}
else {thread.status='completed';thread.result=result;thread.summary=result.summary;thread.sessionId=output.sessionId;current.plan=result;current.questions=result.questions;current.error=null;current.status=result.questions.length?'waiting_input':'awaiting_approval';s.saveTask(current);s.event(t.id,'finished','格式重試成功；規劃已完整通過資料結構檢查。',thread.id);s.notify(current,result.questions.length?'重新規劃完成，請查看待確認問題。':'重新規劃完成，請查看並審核計畫。');console.log(JSON.stringify({status:current.status,steps:result.steps.length,questions:result.questions.length,sessionId:output.sessionId}));}
}catch(e){thread.status='failed';thread.error=e.message;thread.sessionId=e.sessionId||null;const current=s.task(t.id);if((current.controlVersion||0)===revision&&current.status==='paused'&&current.error==='正在重試規劃回傳格式'){current.status='failed';current.error=e.message;s.saveTask(current);}s.event(t.id,'error',e.message,thread.id);console.error(e.message);process.exitCode=1;}
finally{thread.finished=now();s.saveThread(thread);s.close();}
