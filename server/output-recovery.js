// Deterministic Result Recovery。
//
// 核心原則：Result Recovery 不等於重新執行工作。
// 這個檔案只處理「已經存在的 raw output」——它沒有 adapter，沒有任何呼叫引擎的
// 途徑，因此結構上就不可能重跑 Claude／Codex／Executor／Planner／Reviewer。
//
// 它接在既有管線之後：
//   AI Execution → extract → normalize → fillSafeResultDefaults
//                → deterministicResultRecovery → Output Issue
// 前面三步（server/output-validation.js）處理的是無損的結構轉換；到這裡代表
// 結果仍不符合 schema，Recovery 是建立 Output Issue 前的最後一次嘗試。
//
// 三條紅線：
//   1. summary 一定來自原始輸出。找不到就讓 Recovery 失敗，不自行虛構。
//   2. evidence 只能是原始輸出裡「指令＋結果」形式的敘述。看到「修改完成」
//      絕不能生出「npm run build 通過」。
//   3. passed 預設 false。只有原始輸出本身就帶可信的布林 passed 才沿用，
//      不從「工作完成」之類的文字推論。
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {resultSchema} from './domain.js';

// 只有 result schema 的階段適用；plan／repair_plan 缺的是 steps 與 acceptance，
// 沒有任何安全的補值方式，必須維持原本的 Output Issue。
export const RECOVERABLE_PHASES=['execute','repair','review'];
export function recoverablePhase(phase){return RECOVERABLE_PHASES.includes(phase);}

// 還原失敗時「到底還缺什麼」以欄位代號回報（summary／evidence／…），讓 UI 能翻成
// 使用者看得懂的字，而不是把 Zod 的原始訊息當成主要畫面。
function missingFromIssues(issues){
  const fields=[];
  for(const issue of issues||[]){
    const field=String(issue?.path?.[0]||'').trim();
    if(field&&!fields.includes(field))fields.push(field);
  }
  return fields;
}

const SUMMARY_LIMIT=4000,LINE_LIMIT=400,EVIDENCE_LIMIT=40,ARTIFACT_LIMIT=50;

// evidence 必須同時有「做了什麼」與「結果如何」。只有結果詞（例如「完成」）
// 不算證據，這正是規格中「修改完成」不得變成「npm run build 通過」的防線。
const COMMAND=/\b(?:npm|pnpm|yarn|npx|node|deno|bun|python|pytest|phpunit|composer|php|go|cargo|dotnet|mvn|gradle|make|tsc|vue-tsc|eslint|vitest|jest|playwright|curl|git)\b/i;
const OUTCOME=/通過|未通過|失敗|成功|錯誤|exit\s*code|exit\s*0|\bpassed\b|\bpassing\b|\bfailed\b|\bfailing\b|\bsuccess(?:ful)?\b|\bok\b|\berrors?\b/i;
// 「21 tests passed」這類本身就是結果的敘述，不需要指令名稱。
const TEST_COUNT=/\b\d+\s+(?:tests?|specs?|assertions?|suites?)\b[^\n]{0,40}?\b(?:passed|failed|passing|failing|ok)\b|\d+\s*(?:個)?\s*(?:測試|案例|項)\s*(?:全部)?\s*(?:通過|失敗)/i;
const PATHLIKE=/[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)+/g;

function text(value){return typeof value==='string'?value.trim():'';}

// 與 output-validation 的 extract 相同的無損解包，Recovery 可能拿到尚未解包的原始值。
function unwrap(value,depth=0){
  if(depth>3)return value;
  if(typeof value==='string'){
    const body=value.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    try{return unwrap(JSON.parse(body),depth+1);}catch{return value;}
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const keys=Object.keys(value);
    if(keys.length===1&&['result','output'].includes(keys[0]))return unwrap(value[keys[0]],depth+1);
  }
  return value;
}

// 原始輸出「本來就有」這個字串陣列時回傳它（含明確的空陣列）；沒有才回傳 null。
export function explicitList(value){
  if(Array.isArray(value))return value.filter(item=>text(item)).map(item=>text(item));
  if(text(value))return [text(value)];
  return null;
}

export function splitStatements(value){
  return String(value??'')
    .split(/\r?\n|(?<=[。！？；])|(?<=\.)\s+/)
    .map(line=>text(line).replace(/[。；;,、\s]+$/,''))
    .filter(Boolean)
    .map(line=>line.slice(0,LINE_LIMIT));
}

// 只擷取原始輸出裡明確出現的檔案路徑。絕不掃描 Workspace，也不把整個專案當成果。
export function extractArtifacts(corpus){
  const found=[];
  for(const match of String(corpus??'').replace(/\bhttps?:\/\/\S+/gi,' ').matchAll(PATHLIKE)){
    const value=match[0].replace(/[.,;:]+$/,'').replaceAll('\\','/').replace(/^\.\//,'');
    if(!/\.[A-Za-z0-9]{1,10}$/.test(value))continue;
    if(!found.includes(value))found.push(value);
  }
  return found.slice(0,ARTIFACT_LIMIT);
}

// 只擷取「指令＋結果」或「N tests passed」形式的敘述；其餘一律不算證據。
export function extractEvidence(corpus){
  return splitStatements(corpus)
    .filter(line=>TEST_COUNT.test(line)||(COMMAND.test(line)&&OUTCOME.test(line)))
    .filter((line,index,all)=>all.indexOf(line)===index)
    .slice(0,EVIDENCE_LIMIT);
}

// passed 只在原始輸出本身帶有布林（或無損可轉換的 'true'/'false'）時沿用。
// 其他情況一律 false —— 包含輸出說「工作完成」的情況。
export function recoverPassed(source){
  if(!source||typeof source!=='object')return false;
  if(typeof source.passed==='boolean')return source.passed;
  if(source.passed==='true')return true;
  return false;
}

export function deterministicResultRecovery(raw,context={}){
  const value=unwrap(raw);
  const structured=value&&typeof value==='object'&&!Array.isArray(value)?value:null;
  const notes=[];
  const gitFiles=explicitList(context?.gitFiles)||[];

  // 規則 1：summary 一定來自原始輸出，找不到就失敗。
  const summary=structured?text(structured.summary):text(value);
  if(!summary)return {ok:false,reason:'原始輸出沒有可用的 summary，Recovery 失敗；不得自行虛構摘要。',missing:['summary'],notes,source:structured?'structured':'text'};

  const corpus=structured
    ?[text(structured.summary),...(Array.isArray(structured.evidence)?structured.evidence.filter(e=>typeof e==='string'):[text(structured.evidence)])].filter(Boolean).join('\n')
    :summary;

  const questions=structured?explicitList(structured.questions):null;
  const artifacts=structured?explicitList(structured.artifacts):null;
  const evidence=structured?explicitList(structured.evidence):null;

  if(!questions)notes.push('原始輸出缺少 questions，安全補上空陣列。');
  if(!artifacts){
    notes.push(gitFiles.length
      ?'原始輸出缺少 artifacts，改由本輪 Git 實際變更的檔案清單重建 artifacts。'
      :'原始輸出缺少 artifacts，改由原始輸出中明確出現的檔案路徑擷取。');
  }
  if(!evidence)notes.push('原始輸出缺少 evidence，只擷取原始輸出中明確的指令與結果敘述。');

  // 規則 2：evidence 只能來自原始輸出。原始輸出既沒有 evidence 欄位、文字裡也找不到
  // 任何「指令＋結果」的敘述時，Recovery 失敗——這與 fillSafeResultDefaults 刻意不替
  // evidence 補值的理由相同：宣稱做完卻拿不出任何證據的結果，必須讓人看過。
  // 原始輸出明確給了空陣列則屬於它自己的陳述，照樣沿用。
  const recoveredEvidence=evidence||extractEvidence(corpus);
  if(!evidence&&!recoveredEvidence.length)return {ok:false,reason:'原始輸出沒有任何可確認的執行證據，Recovery 失敗；不得創造 evidence。',missing:['evidence'],notes,source:structured?'structured':'text'};

  const candidate={
    summary:summary.slice(0,SUMMARY_LIMIT),
    questions:questions||[],
    artifacts:artifacts||(gitFiles.length?gitFiles:extractArtifacts(corpus)),
    evidence:recoveredEvidence,
    // browserValidation 與 userActionRequired 刻意不從壞掉的輸出沿用：兩者在
    // runner 內都會依實際 tool_use 證據與 summary/evidence 重新判定，交給 schema
    // 預設值才是保守解。
    passed:recoverPassed(structured)
  };
  if(!candidate.passed)notes.push('passed 未知時一律 false，不從「工作完成」之類的文字推論。');

  const checked=resultSchema.safeParse(candidate);
  if(!checked.success)return {ok:false,reason:'還原後的結果仍不符合 Result Schema：'+checked.error.issues.map(i=>`${i.path.join('.')||'根物件'} ${i.message}`).join('；'),missing:missingFromIssues(checked.error.issues),notes,source:structured?'structured':'text'};
  return {ok:true,result:checked.data,missing:[],notes,source:structured?'structured':'text'};
}

function saveRecovery(runDir,payload){
  if(!runDir)return;
  try{mkdirSync(runDir,{recursive:true});writeFileSync(join(runDir,'recovered-output.json'),JSON.stringify(payload,null,2));}
  catch{/* 保存只是為了 debug，寫不進去不該讓工作再失敗一次 */}
}

// runner 的單一進入點。回傳 {ok:false} 時，呼叫端維持原本的 Output Issue 流程。
export function recoverFormatFailure(error,{phase,runDir=error?.runDir,gitFiles=[]}={}){
  if(error?.code!=='OUTPUT_FORMAT')return {ok:false,reason:'不是輸出格式問題，不進行 Result Recovery。',missing:[],notes:[]};
  if(!RECOVERABLE_PHASES.includes(phase))return {ok:false,reason:`${phase} 階段不套用 Result Recovery；計畫缺少的內容沒有安全的補值方式。`,missing:[],notes:[]};
  const recovery=deterministicResultRecovery(error.candidate!==undefined?error.candidate:error.rawResult,{gitFiles});
  saveRecovery(runDir,{ok:recovery.ok,source:recovery.source,reason:recovery.reason||null,missing:recovery.missing||[],notes:recovery.notes,result:recovery.result||null,at:new Date().toISOString(),issues:error.issues||[]});
  if(!recovery.ok)return {ok:false,reason:recovery.reason,missing:recovery.missing||[],notes:recovery.notes};
  return {ok:true,result:recovery.result,missing:[],notes:recovery.notes,
    message:`AI 回傳格式不完整，已從原始輸出還原結果（來源：${recovery.source==='text'?'原始文字':'結構化輸出'}），未重新執行任何工作。${recovery.notes.join('')}`};
}
