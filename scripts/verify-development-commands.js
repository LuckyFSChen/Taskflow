import 'dotenv/config';
import {resolve,join} from 'node:path';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {cliAdapter} from '../server/runner.js';
import {resultJson,resultSchema} from '../server/domain.js';
if(!process.argv[2])throw new Error('Provide a trusted Vue workspace path');
const cwd=resolve(process.argv[2]);
const runDir=resolve('data/validation',`commands-${Date.now()}`);
mkdirSync(runDir,{recursive:true});
const output=await cliAdapter({engine:'claude',cwd,runDir,readOnly:false,schema:resultJson,
  prompt:'在目前已授權的 Vue 工作副本，使用 Bash 依序實際執行 npm install 與 npm run build。不要修改原始碼，不要部署。只驗證安裝與建置，不要宣稱已做瀏覽器視覺驗證。回傳結果及實際命令證據；遇到權限拒絕時 passed=false 並寫明指令。',onEvent:message=>console.log(message)});
const result=resultSchema.parse(output.result);
const passed=result.passed&&existsSync(join(cwd,'node_modules'))&&existsSync(join(cwd,'dist/index.html'));
writeFileSync(join(runDir,'report.json'),JSON.stringify({...output,passed,cwd},null,2));
console.log(JSON.stringify({passed,sessionId:output.sessionId,report:join(runDir,'report.json')}));
if(!passed)process.exitCode=1;
