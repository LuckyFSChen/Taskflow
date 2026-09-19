// 方案群組（Plan Group）：一個「執行方案」底下的多個任務。
//
// 為什麼要有正式的 id：任務佇列以前是扁平清單，屬於同一個方案的任務散落各處。
// 把它們聚在一起的唯一合法依據是這個穩定的 planGroupId，由使用者（或建立任務的流程）
// 明確指定，存在 plan_groups 資料表與 tasks.plan_group_id 欄位。
//
// 刻意不做的事：
//   - 不用 task.title、專案名稱、Git branch 或任何字串相似度推測「這幾個應該是同一個方案」。
//   - 不替既有的舊任務補 group id。舊任務的 planGroupId 是 null，就是獨立任務。
//   - 不提供「自動分組」開關。分組永遠是使用者的決定。
import {z} from 'zod';
import {id,now} from './db.js';
import {HttpError,requireTask} from './domain.js';

export const planGroupInput=z.object({
  name:z.string().trim().min(2).max(80),
  projectId:z.string().uuid(),
}).strict();

export const planGroupRenameInput=z.object({name:z.string().trim().min(2).max(80)}).strict();

// 指派／取消指派任務所屬方案。planGroupId 為 null 代表「移出方案，成為獨立任務」。
export const taskPlanGroupInput=z.object({planGroupId:z.string().uuid().nullable()}).strict();

export function createPlanGroup(store,user,input){
  const data=planGroupInput.parse(input);
  if(!store.hasProject(user,data.projectId))throw new HttpError(403,'尚未獲授權使用此專案');
  return store.savePlanGroup({id:id(),projectId:data.projectId,ownerId:user.id,name:data.name,created:now(),updated:now()});
}

export function requireOwnPlanGroup(store,user,groupId){
  const group=store.planGroup(groupId);
  if(!group||(group.ownerId!==user.id&&user.role!=='admin'))throw new HttpError(404,'找不到方案');
  return group;
}

export function renamePlanGroup(store,user,groupId,input){
  const group=requireOwnPlanGroup(store,user,groupId);
  const {name}=planGroupRenameInput.parse(input);
  return store.savePlanGroup({...group,name});
}

// 把單一任務移進／移出方案。這是使用者明確按下的動作，不是規則推測，
// 所以舊任務也可以用這條路徑歸進方案——但永遠要有人按。
export function assignTaskPlanGroup(store,user,taskId,input){
  const task=requireTask(store,user,taskId);
  const {planGroupId}=taskPlanGroupInput.parse(input);
  if(planGroupId===null){
    if(!task.planGroupId)return task;
    const previous=store.planGroup(task.planGroupId);
    task.planGroupId=null;
    store.saveTask(task);
    store.event(task.id,'plan_group',`${user.name} 將任務移出方案${previous?`「${previous.name}」`:''}，改為獨立任務`);
    return task;
  }
  const group=requireOwnPlanGroup(store,user,planGroupId);
  if(group.projectId!==task.projectId)throw new HttpError(409,'方案屬於其他專案，請選擇同一專案的方案。');
  if(task.planGroupId===group.id)return task;
  task.planGroupId=group.id;
  store.saveTask(task);
  store.event(task.id,'plan_group',`${user.name} 將任務歸入方案「${group.name}」`);
  return task;
}

// 送到前端的方案清單。只帶穩定的座標（id／名稱／專案），完成度與狀態一律由前端依
// 真實的 task state 聚合（src/plan-group.js），後端不預先算任何「進度百分比」。
export function planGroupsPublic(store,user){
  return store.planGroups(user).map(group=>({
    id:group.id,
    name:group.name,
    projectId:group.projectId,
    projectName:store.project(group.projectId)?.name||null,
    ownerId:group.ownerId,
    created:group.created,
    updated:group.updated,
  }));
}
