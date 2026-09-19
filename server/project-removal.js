import {existsSync,lstatSync,realpathSync,renameSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,join,parse} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HttpError} from './domain.js';
const platformRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const contains=(parent,child)=>{const r=relative(parent,child);return r===''||(!r.startsWith('../')&&!r.startsWith('..\\')&&r!=='..'&&!isAbsolute(r));};
const overlap=(a,b)=>contains(a,b)||contains(b,a);
function canonical(input){
  if(!isAbsolute(input))throw new HttpError(409,'刪除路徑必須是完整路徑');
  const path=resolve(input);let current=path;
  while(true){
    try{if(lstatSync(current).isSymbolicLink())throw new HttpError(409,'刪除路徑包含符號連結或 Junction，請先整理資料夾');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(dirname(current)===current)break;current=dirname(current);
  }
  current=path;while(!existsSync(current))current=dirname(current);
  return join(realpathSync(current),relative(current,path));
}
export function projectRemovalPlan(store,runner,previews,pid,{dataDir=resolve('data'),appRoot=platformRoot}={}){
  const project=store.project(pid);if(!project)throw new HttpError(404,'找不到專案');
  const tasks=store.tasks().filter(t=>t.projectId===pid),threads=tasks.flatMap(t=>store.threads(t.id));
  const active=new Set([...(runner.status.activeTaskIds||[]),runner.status.activeTaskId].filter(Boolean));
  if(tasks.some(t=>active.has(t.id)||t.status==='running')||threads.some(t=>t.status==='running'))throw new HttpError(409,'專案仍有執行中的任務，請先暫停並等待工作結束');
  if(previews.hasProjectActivity?.(pid))throw new HttpError(409,'專案網頁仍在預覽或建置中，請先停止所有預覽再移除');
  const original=canonical(project.path),data=canonical(dataDir),app=canonical(appRoot);
  const protectedPaths=[homedir(),process.env.SystemRoot,process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean).map(canonical);
  const defaultRoot=store.setting('defaultProjectRoot','');
  if(original===parse(original).root||contains(original,app)||overlap(original,data)||protectedPaths.some((p,i)=>i===0?contains(original,p):overlap(original,p))||(contains(app,original)&&!contains(canonical(defaultRoot||join(app,'Projects')),original)))throw new HttpError(409,'此路徑包含平台、磁碟根目錄或受保護資料，不允許刪除');
  if(defaultRoot&&contains(original,canonical(defaultRoot)))throw new HttpError(409,'不可刪除預設專案存放位置本身或其上層資料夾');
  const others=store.db.prepare('SELECT * FROM projects WHERE id<>?').all(pid);
  // Only the selected directory is removed. A registered ancestor stays in place;
  // an equal path or registered descendant would be deleted and must block removal.
  const conflict=others.find(p=>contains(original,canonical(p.path)));
  if(conflict)throw new HttpError(409,`刪除範圍與專案「${conflict.name}」共用資料夾或包含其資料夾（重疊路徑：${conflict.path}），請先調整專案路徑`);
  const paths=[{path:original,kind:'原始專案'}];
  const addManaged=(section,identifier)=>{
    if(!/^[0-9a-f-]{36}$/i.test(identifier))throw new HttpError(409,'工作紀錄識別碼不正確，停止刪除');
    const root=canonical(join(data,section)),path=canonical(join(root,identifier));
    if(!contains(data,root)||root===data||!contains(root,path)||path===root)throw new HttpError(409,'工作副本路徑超出管理範圍');
    paths.push({path,kind:section==='workspaces'?'AI 工作副本（全部版本）':section==='worktrees'?'AI 任務分支工作目錄（git worktree）':'AI 執行紀錄'});
  };
  // 工作目錄可能是舊版 v1/v2 工作副本，也可能是 Git 模式的 worktree；兩個受管理目錄都要一併清除，
  // 但 task.workspace 仍必須落在其中之一，否則一樣停止刪除，避免刪到管理範圍外的路徑。
  for(const t of tasks){
    addManaged('workspaces',t.id);const managed=[paths.at(-1).path];
    if(t.git?.mode==='worktree'){addManaged('worktrees',t.id);managed.push(paths.at(-1).path);}
    if(t.workspace&&!managed.some(root=>contains(root,canonical(t.workspace))))throw new HttpError(409,'工作副本不在此任務的管理目錄，停止刪除');
  }
  for(const th of threads)addManaged('runs',th.id);
  for(const other of store.tasks().filter(t=>t.projectId!==pid&&t.workspace))if(paths.some(p=>overlap(p.path,canonical(other.workspace))))throw new HttpError(409,'刪除範圍與其他任務的工作副本重疊');
  for(const item of paths){if(existsSync(item.path)&&!lstatSync(item.path).isDirectory())throw new HttpError(409,'刪除目標已變更為檔案');item.exists=existsSync(item.path);}
  const fingerprint=createHash('sha256').update(JSON.stringify({project,tasks,threads,paths:paths.map(p=>({...p,identity:p.exists?[lstatSync(p.path).dev,lstatSync(p.path).ino]:null}))})).digest('hex');
  return {project,taskCount:tasks.length,threadCount:threads.length,paths,fingerprint,taskIds:tasks.map(t=>t.id)};
}
export function removeProject(store,runner,previews,pid,input,options={}){
  // All validation, staging and DB changes are synchronous: the runner cannot claim a task mid-delete.
  const plan=projectRemovalPlan(store,runner,previews,pid,options);
  if(input.confirmCode!==plan.project.code||input.fingerprint!==plan.fingerprint)throw new HttpError(409,'專案資料已變更或代號不符，請重新開啟移除確認視窗');
  const operation=randomUUID(),data=canonical(options.dataDir||resolve('data'));
  const journal=join(data,'deletions',operation+'.json'),moves=[];
  mkdirSync(dirname(journal),{recursive:true});
  const save=state=>writeFileSync(journal,JSON.stringify({state,project:plan.project,moves},null,2));
  try{
    for(const item of plan.paths.filter(p=>p.exists)){
      const staged=join(dirname(item.path),'.taskflow-delete-'+operation+'-'+moves.length);
      if(existsSync(staged))throw new Error('Deletion staging path already exists');
      moves.push({source:item.path,staged});save('staging');renameSync(item.path,staged);
    }
    store.transaction(()=>{
      for(const tid of plan.taskIds){store.db.prepare('DELETE FROM events WHERE task_id=?').run(tid);store.db.prepare('DELETE FROM threads WHERE task_id=?').run(tid);store.db.prepare('DELETE FROM tasks WHERE id=?').run(tid);}
      store.db.prepare('DELETE FROM memberships WHERE project_id=?').run(pid);
      // 方案群組掛在專案底下。專案移除後它們就沒有歸屬了，而且 plan_groups.project_id
      // 有外鍵，留著會讓下一行刪除專案直接失敗。
      store.db.prepare('DELETE FROM plan_groups WHERE project_id=?').run(pid);
      store.db.prepare('DELETE FROM projects WHERE id=?').run(pid);
      // Clear only flows and pending notifications which reference this project or its tasks.
      const ids=[pid,...plan.taskIds];
      for(const row of store.db.prepare('SELECT user_id,line_id,data FROM line_flows').all())if(ids.some(id=>row.data.includes(id)))store.db.prepare('DELETE FROM line_flows WHERE user_id=? AND line_id=?').run(row.user_id,row.line_id);
      for(const row of store.db.prepare('SELECT id,payload FROM outbox WHERE sent=0').all())if(ids.some(id=>(row.payload||'').includes(id)))store.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);
    });
  }catch(error){
    let rollbackFailed=false;
    for(const move of [...moves].reverse())try{if(existsSync(move.staged)&&!existsSync(move.source))renameSync(move.staged,move.source);}catch{rollbackFailed=true;}
    if(!rollbackFailed)rmSync(journal,{force:true});
    throw new HttpError(409,rollbackFailed?'移除失敗，部分檔案需要復原；請檢查 data/deletions 的紀錄。':'無法移除專案，資料庫與資料夾已保留。請關閉占用檔案的程式後重試。');
  }
  const pending=[];
  // Staged paths were derived from validated absolute targets; rm does not follow child symlinks.
  for(const move of moves)try{rmSync(move.staged,{recursive:true,force:true,maxRetries:2,retryDelay:100});}catch{pending.push(move.staged);}
  if(pending.length){save('cleanup-pending');}else rmSync(journal,{force:true});
  return {ok:true,deletedTasks:plan.taskCount,pendingCleanup:pending,warning:pending.length?'專案已移除，但部分磁碟檔案仍被占用，尚未完全刪除。請依下列路徑清理。':null};
}
