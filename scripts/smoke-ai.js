import 'dotenv/config';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {cliAdapter} from '../server/runner.js';
import {resultJson,resultSchema} from '../server/domain.js';
const engine=process.argv[2]||'codex';
if(!['codex','claude'].includes(engine))throw new Error('Engine must be codex or claude');
const dir=resolve('data','validation',`${engine}-${Date.now()}`),workspace=join(dir,'workspace');mkdirSync(workspace,{recursive:true});
const marker=`TASKFLOW_${randomUUID()}`;writeFileSync(join(workspace,'CHECK.txt'),marker);
console.log(`Starting real ${engine} read-only smoke check…`);
const started=Date.now();
try {
const output=await cliAdapter({engine,cwd:workspace,runDir:join(dir,'run'),schema:resultJson,readOnly:true,prompt:'Read CHECK.txt in the current working directory using your file reading tool. Return its exact content in summary. Set passed=true only after reading it. Return questions=[], artifacts=[], and evidence describing the actual file read. Do not modify files or use external services. Return only the required structured result.',onEvent:()=>{}});
const result=resultSchema.parse(output.result);if(result.summary.trim()!==marker||!result.passed)throw new Error('Output did not prove the fixture was read.');
const report={engine,passed:true,elapsedSeconds:Math.round((Date.now()-started)/1000),sessionId:output.sessionId,checks:['real CLI process','local fixture read','JSON schema response','provider session identifier'],at:new Date().toISOString()};writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){writeFileSync(join(dir,'report.json'),JSON.stringify({engine,passed:false,error:e.message,at:new Date().toISOString()},null,2));console.error(e.message);process.exitCode=1;}
