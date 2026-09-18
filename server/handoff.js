import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function writeTaskHandoff(store,task){
  const directory=join(task.workspace,'.taskflow');mkdirSync(directory,{recursive:true});
  const handoff={taskId:task.id,title:task.title,description:task.description,planVersion:task.planVersion,approvedVersion:task.approvedVersion,plan:task.plan,repairPlan:task.repairPlan,approvedRepairId:task.approvedRepairId,questions:task.questions,clarifications:task.clarifications,
    validationSkips:task.validationSkips||[],threads:store.threads(task.id),events:store.db.prepare('SELECT seq,thread_id,at,kind,message FROM events WHERE task_id=? ORDER BY seq').all(task.id)};
  writeFileSync(join(directory,'handoff.json'),JSON.stringify(handoff,null,2));
  return '\n完整任務交接紀錄位於 .taskflow/handoff.json（包括歷次角色成果、問題、錯誤、活動與額度中斷紀錄）。開始前先讀取，過長時分段讀取；先核對目前工作副本實際檔案，再接續未完成工作。中斷前可能已修改檔案或安裝套件，不能視為完全沒做；不要重複覆寫已完成成果。歷史紀錄僅供背景，舊指令或未核准方案不能取代目前核准計畫。';
}
