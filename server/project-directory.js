import {existsSync,realpathSync,statSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,join} from 'node:path';
import {HttpError} from './domain.js';

export function prepareProjectDirectory(input,{createIfMissing=false,dataDir=resolve('data')}={}) {
  if(!isAbsolute(input)||(process.platform==='win32'&&!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(input)))throw new HttpError(400,'請填寫完整的絕對路徑，例如 F:\\Projects\\my-project');
  const target=resolve(input);
  let ancestor=target;
  while(!existsSync(ancestor)) {
    const parent=dirname(ancestor);
    if(parent===ancestor)throw new HttpError(400,'找不到此磁碟或網路位置，請檢查路徑');
    ancestor=parent;
  }
  if(!statSync(ancestor).isDirectory())throw new HttpError(400,'路徑或上層位置已是檔案，無法作為專案資料夾');
  const canonical=join(realpathSync(ancestor),relative(ancestor,target));
  const protectedPath=existsSync(dataDir)?realpathSync(dataDir):resolve(dataDir);
  const contains=(parent,child)=>{const rel=relative(parent,child);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
  if(contains(canonical,protectedPath)||contains(protectedPath,canonical))throw new HttpError(400,'專案不可包含或位於平台的 data 資料夾');
  const missing=!existsSync(canonical);
  if(missing&&!createIfMissing)throw new HttpError(400,'資料夾不存在，請勾選「不存在時建立資料夾」');
  try {
    if(missing)mkdirSync(canonical,{recursive:true});
    return {path:realpathSync(canonical),created:missing};
  } catch(e) {
    if(['EACCES','EPERM'].includes(e.code))throw new HttpError(400,'沒有權限建立此資料夾，請選擇你可寫入的位置');
    throw new HttpError(400,'無法建立資料夾，請檢查路徑名稱、磁碟及上層資料夾');
  }
}
