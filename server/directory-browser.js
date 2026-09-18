import {readdirSync,realpathSync,statSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,join} from 'node:path';
import {HttpError} from './domain.js';
import {prepareProjectDirectory} from './project-directory.js';
import {projectName} from './line-projects.js';

export function browseDirectory(input,{dataDir=resolve('data')}={}){
  if(typeof input!=='string'||!isAbsolute(input))throw new HttpError(400,'請選擇完整的資料夾路徑');
  try{
    const path=realpathSync(input),protectedPath=realpathSync(dataDir),rel=relative(protectedPath,path);
    if(rel===''||(!rel.startsWith('..')&&!isAbsolute(rel)))throw new HttpError(403,'無法瀏覽平台內部資料夾');
    if(!statSync(path).isDirectory())throw new HttpError(400,'此位置不是資料夾');
    const folders=readdirSync(path,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!e.name.startsWith('.')&&resolve(path,e.name).toLowerCase()!==protectedPath.toLowerCase()).map(e=>({name:e.name,path:join(path,e.name)})).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant'));
    let selectable=true,reason='';try{prepareProjectDirectory(path,{dataDir});}catch(e){selectable=false;reason=e.message;}
    return {path,parent:dirname(path)===path?null:dirname(path),folders:folders.slice(0,1000),truncated:folders.length>1000,selectable,reason};
  }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,['EACCES','EPERM'].includes(e.code)?'無權限讀取此資料夾':'資料夾不存在或無法讀取，請選擇其他位置');}
}
export function createDirectory(parent,name){
  const path=join(browseDirectory(parent).path,projectName(name));
  if(existsSync(path))throw new HttpError(409,'已有同名資料夾或檔案，請改用其他名稱');
  return prepareProjectDirectory(path,{createIfMissing:true}).path;
}
export const availableDrives=()=>process.platform==='win32'?Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+':\\').filter(path=>existsSync(path)):['/'];
