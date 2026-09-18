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
export async function validatedOutput(adapter,options,validator){
  let output,raw,originalError;
  try{output=await adapter(options);raw=output.result;}
  catch(error){if(error.code!=='OUTPUT_FORMAT')throw error;originalError=error;raw=error.rawResult;output={sessionId:error.sessionId};}
  mkdirSync(options.runDir,{recursive:true});
  writeFileSync(join(options.runDir,'original-output.json'),JSON.stringify({result:raw??null,error:originalError?.message||null,sessionId:output.sessionId||null},null,2));
  let candidate=raw,checked=validator.safeParse(candidate);
  for(let attempt=1;!checked.success&&attempt<=2;attempt++){
    candidate=attempt===1?extract(candidate):normalize(candidate,options.schema);
    writeFileSync(join(options.runDir,`format-repair-${attempt}.json`),JSON.stringify(candidate??null,null,2));
    options.onEvent?.(`純格式修復 ${attempt}/2：未重新執行工作或補寫內容`);
    checked=validator.safeParse(candidate);
  }
  if(!checked.success){
    const issues=checked.error.issues.map(issue=>`${issue.path.join('.')||'根物件'}：${issue.message}`);
    const error=new Error('AI 回傳格式仍不完整，已停止自動處理；需求與進度均保留。\n'+issues.join('\n')+'\n建議：查看保留的原始結果，補充缺失內容或審核重新規劃；不會自動重跑已執行的工作。');
    error.code='OUTPUT_FORMAT';error.sessionId=output.sessionId;error.issues=issues;error.runDir=options.runDir;throw error;
  }
  return {...output,result:checked.data};
}
