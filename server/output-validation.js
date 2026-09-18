import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Only lossless structural conversions are permitted. Missing content is never
// invented, and the adapter (which may have changed files) is invoked just once.
function extract(value){
  if(typeof value==='string'){
    const text=value.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    try{return JSON.parse(text);}catch{return value;}
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const keys=Object.keys(value);
    if(keys.length===1&&['result','output'].includes(keys[0]))return value[keys[0]];
  }
  return value;
}
function normalize(value,schema){
  value=extract(value);
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const copy=structuredClone(value);
  for(const [key,property] of Object.entries(schema.properties||{})){
    if(property.type==='array'&&property.items?.type==='string'&&typeof copy[key]==='string'&&copy[key].length)copy[key]=[copy[key]];
    if(property.type==='boolean'&&['true','false'].includes(copy[key]))copy[key]=copy[key]==='true';
  }
  return copy;
}
// Only for the execute/repair/review result schema (identified by its unique 'passed' field —
// the plan schema never has it). questions/artifacts/passed have unambiguous, always-safe
// defaults when the engine's structured output simply omits them; summary and evidence carry
// substantive content that must come from the actual work and are never invented here, so a
// response genuinely missing those still fails closed afterwards.
function fillSafeResultDefaults(value){
  value=extract(value);
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const copy=structuredClone(value);
  if(copy.questions===undefined)copy.questions=[];
  if(copy.artifacts===undefined)copy.artifacts=[];
  if(copy.passed===undefined)copy.passed=false;
  return copy;
}
export async function validatedOutput(adapter,options,validator){
  let output,raw,originalError;
  try{output=await adapter(options);raw=output.result;}
  catch(error){if(error.code!=='OUTPUT_FORMAT')throw error;originalError=error;raw=error.rawResult;output={sessionId:error.sessionId};}
  mkdirSync(options.runDir,{recursive:true});
  writeFileSync(join(options.runDir,'original-output.json'),JSON.stringify({result:raw??null,error:originalError?.message||null,sessionId:output.sessionId||null},null,2));
  const isResultSchema=Array.isArray(options.schema?.required)&&options.schema.required.includes('passed');
  const steps=isResultSchema
    ?[candidate=>extract(candidate),candidate=>normalize(candidate,options.schema),candidate=>fillSafeResultDefaults(candidate)]
    :[candidate=>extract(candidate),candidate=>normalize(candidate,options.schema)];
  let candidate=raw,checked=validator.safeParse(candidate);
  for(let attempt=1;!checked.success&&attempt<=steps.length;attempt++){
    candidate=steps[attempt-1](candidate);
    writeFileSync(join(options.runDir,`format-repair-${attempt}.json`),JSON.stringify(candidate??null,null,2));
    options.onEvent?.(attempt<steps.length||!isResultSchema?`純格式修復 ${attempt}/${steps.length}：未重新執行工作或補寫內容`:`純格式修復 ${attempt}/${steps.length}：安全補上缺少的 questions/artifacts/passed 預設值，不臆測 summary 或 evidence`);
    checked=validator.safeParse(candidate);
  }
  if(!checked.success){
    const issues=checked.error.issues.map(issue=>`${issue.path.join('.')||'根物件'}：${issue.message}`);
    const error=new Error('AI 回傳格式仍不完整，已停止自動處理；需求與進度均保留。\n'+issues.join('\n')+'\n建議：查看保留的原始結果，補充缺失內容或審核重新規劃；不會自動重跑已執行的工作。');
    error.code='OUTPUT_FORMAT';error.sessionId=output.sessionId;error.issues=issues;error.runDir=options.runDir;throw error;
  }
  return {...output,result:checked.data};
}
