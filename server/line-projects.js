import {existsSync,mkdirSync,realpathSync,rmdirSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {id} from './db.js';
import {HttpError} from './domain.js';
import {prepareProjectDirectory} from './project-directory.js';
import {createGitWorkspace} from './git-workspace.js';

const sharedGitWorkspace=createGitWorkspace();

export function projectName(input){
  const name=String(input).normalize('NFC').trim();
  if(!name||name.length>80||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||name==='.'||name==='..'||/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name))throw new HttpError(400,'專案名稱請使用 1～80 字，不可含路徑分隔符號、Windows 保留名稱或結尾句點。');
  return name;
}
export function lineProjectLocation(store,user,input){
  if(user.role!=='admin')throw new HttpError(403,'只有管理者可以從 LINE 建立專案，請聯絡管理者。');
  const name=projectName(input),configured=store.setting('defaultProjectRoot','');
  if(!configured)throw new HttpError(400,'請先在平台設定填寫「預設專案存放位置」。');
  const root=prepareProjectDirectory(configured).path,path=join(root,name),rel=relative(root,path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new HttpError(400,'專案名稱不可離開預設存放位置。');
  if(existsSync(path)||store.db.prepare('SELECT name FROM projects').all().some(p=>p.name.normalize('NFC').toLowerCase()===name.toLowerCase()))throw new HttpError(409,'已有同名專案或資料夾，請改用其他名稱；既有內容不會覆蓋。');
  return {name,root,path};
}
export function createLineProject(store,user,input,expectedRoot,{gitWorkspace=sharedGitWorkspace}={}){
  const location=lineProjectLocation(store,user,input);
  if(location.root!==expectedRoot)throw new HttpError(409,'預設存放位置已變更，請重新建立專案。');
  try{mkdirSync(location.path);}catch(e){throw new HttpError(400,e.code==='EEXIST'?'此資料夾剛被建立，請改用其他名稱。':'無法建立資料夾，請檢查磁碟與寫入權限。');}
  const pid=id(),code=`p-${pid.slice(0,8)}`,path=realpathSync(location.path);
  try{store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,code,location.name,path);}
  catch(e){try{rmdirSync(location.path);}catch{}throw e;}
  // 新專案一建立就給它自己的 repository boundary。預設存放位置本身可能位於另一個 repository
  // 底下（TaskFlow 預設就是 F:\TaskFlow\Projects），不先劃清界線的話，Git 會把這個資料夾
  // 解析成上層版本庫的一部分。初始化失敗不阻擋專案建立：第一個任務開始前還會再試一次。
  try{gitWorkspace.ensureRepository(path,{projectRoot:path,managedProjectsRoot:location.root});}catch{}
  return store.project(pid);
}
