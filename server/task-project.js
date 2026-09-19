import {existsSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {taskInput,createTask,HttpError} from './domain.js';
import {createPlanGroup} from './plan-group.js';
import {lineProjectLocation,createLineProject} from './line-projects.js';

// 建立任務時順便開一個新方案：表單選「建立新方案」走這裡。
// 只有真的填了名稱才會建立；名稱空白就當成「獨立任務」，不會自動生出方案。
function resolvePlanGroupId(store,user,input,projectId){
  const name=typeof input.planGroupName==='string'?input.planGroupName.trim():'';
  if(!name)return input.planGroupId??null;
  return createPlanGroup(store,user,{name,projectId}).id;
}

export function taskProjectLocation(store,user,title){
  // Task titles remain unchanged; normalize only the Windows directory name.
  let base=title.normalize('NFC').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,70).replace(/[. ]+$/g,'');
  if(!base||base==='.'||base==='..')base='新專案';
  if(/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(base))base='專案_'+base;
  const root=store.setting('defaultProjectRoot','');
  const names=new Set(store.db.prepare('SELECT name FROM projects').all().map(p=>p.name.normalize('NFC').toLowerCase()));
  for(let i=1;i<=1000;i++){const name=i===1?base:`${base} (${i})`;if(!names.has(name.toLowerCase())&&!existsSync(join(root,name)))return lineProjectLocation(store,user,name);}
  throw new HttpError(409,'同名專案過多，請修改任務標題。');
}
// Caller supplies the existing transaction (HTTP or LINE event) so project/task save together.
export function createTaskWithProject(store,user,input,{expectedRoot}={}){
  if(input.createProject!==true)return createTask(store,user,{...input,planGroupId:resolvePlanGroupId(store,user,input,input.projectId)});
  const data=taskInput.omit({projectId:true}).parse(input);
  const location=taskProjectLocation(store,user,data.title);
  if(expectedRoot&&location.root!==expectedRoot)throw new HttpError(409,'預設位置已變更，請重新確認發布。');
  let project;
  store.db.exec('SAVEPOINT task_project');
  // 新專案 + 新方案要一起成立或一起回滾：方案掛在專案底下，專案沒建成就不該留下孤兒方案。
  try{project=createLineProject(store,user,location.name,location.root);const task=createTask(store,user,{...data,projectId:project.id,planGroupId:resolvePlanGroupId(store,user,input,project.id)});store.db.exec('RELEASE task_project');return task;}
  catch(e){store.db.exec('ROLLBACK TO task_project');store.db.exec('RELEASE task_project');if(project)try{rmdirSync(project.path);}catch{}throw e;}
}
