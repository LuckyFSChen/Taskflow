import {accessSync,constants,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {validatedOutput} from './output-validation.js';
export const preflightSchema=z.object({summary:z.string().min(1),toolAvailable:z.boolean(),registryReachable:z.boolean(),installationAllowed:z.boolean(),evidence:z.array(z.string().min(1)).min(1)}).strict();
export const preflightJson={type:'object',additionalProperties:false,required:['summary','toolAvailable','registryReachable','installationAllowed','evidence'],properties:{summary:{type:'string'},toolAvailable:{type:'boolean'},registryReachable:{type:'boolean'},installationAllowed:{type:'boolean'},evidence:{type:'array',minItems:1,items:{type:'string'}}}};
export function needsPreflight(task){
  return task.type==='code'&&(/npm|pnpm|yarn|套件|依賴|package|install/i.test(JSON.stringify(task.plan))||existsSync(join(task.workspace,'package.json')));
}
export async function dependencyPreflight(adapter,options){
  try{accessSync(options.cwd,constants.W_OK);}catch{const error=new Error('工作副本無寫入權限，尚未開始工作。處理方案：恢復該資料夾的寫入權限後，核准重新檢查；不自動更改權限或改用替代實作。');error.code='DEPENDENCY_PREFLIGHT';throw error;}
  mkdirSync(join(options.cwd,'.taskflow'),{recursive:true});
  copyFileSync(new URL('../scripts/probe-child-process.cjs',import.meta.url),join(options.cwd,'.taskflow','probe-child-process.cjs'));
  const checkedAdapter=async request=>adapter({...request,prompt:request.prompt+'\n還必須執行 node .taskflow/probe-child-process.cjs，檢查 Node 與安裝腳本 shell 建立子程序。此探針只執行版本與空指令，不安裝或修改專案。只有 exit 0 且每項 ok=true 才算通過。子程序拒絕或未完成檢查，installationAllowed 必須為 false，不能由 npm ping 成功推定安裝可行。evidence 必須包含探針的各項輸出。'});
  const output=await validatedOutput(checkedAdapter,{...options,preflight:true,readOnly:false,schema:preflightJson,
    prompt:'你是套件環境檢查員，只檢查，不執行任務、不改檔、不安裝套件、不更改 registry 或權限。於目前工作目錄依序執行 npm --version、npm config get registry、npm ping --fetch-retries=0 --fetch-timeout=10000。若專案使用 pnpm/yarn，也檢查其 --version。確認目前引擎是否允許在工作副本執行套件安裝（工具政策拒絕／沙箱禁止網路時 installationAllowed=false）。正式執行階段已授權 npm/pnpm/yarn install 與 npm ci；本檢查刻意禁止實際安裝，不代表正式階段沒有安裝授權，仍需檢查引擎網路或沙箱是否另有限制。不確定時回 false，不能假設外部網路可用。證據包含指令與實際結果；不要輸出憑證或帶帳密的網址。任何失敗必須如實記錄。不得改用替代套件或自製實作。回傳 summary、toolAvailable、registryReachable、installationAllowed、evidence。'},preflightSchema);
  const r=output.result;
  if(!r.toolAvailable||!r.registryReachable||!r.installationAllowed){
    const error=new Error('套件環境檢查未通過，尚未開始本次工作。\n'+r.summary+'\n'+r.evidence.join('\n')+'\n處理方案：檢查套件工具、既有 registry 網路與引擎安裝權限；處理完成後核准重新檢查。若要替換套件或自製實作，須先修改計畫並經審核。');
    error.code='DEPENDENCY_PREFLIGHT';error.report=r;throw error;
  }
  return r;
}
