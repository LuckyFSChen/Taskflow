import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {cliAdapter} from '../server/runner.js';
import {resultJson,resultSchema} from '../server/domain.js';
const root=resolve('data/validation/npm-sandbox-'+Date.now()),cwd=join(root,'workspace');
mkdirSync(cwd,{recursive:true});
writeFileSync(join(cwd,'package.json'),JSON.stringify({name:'taskflow-sandbox-smoke',version:'1.0.0',private:true,scripts:{test:'node --test sharp.test.cjs'}}));
writeFileSync(join(cwd,'sharp.test.cjs'),`const test=require('node:test');const assert=require('node:assert/strict');test('sharp resizes an image',async()=>{const sharp=require('sharp');const image=await sharp({create:{width:8,height:8,channels:3,background:'#ffffff'}}).resize(4,4).png().toBuffer();const meta=await sharp(image).metadata();assert.equal(meta.width,4);assert.equal(meta.height,4);});`);
try{
  const output=await cliAdapter({engine:'codex',cwd,runDir:join(root,'run'),schema:resultJson,readOnly:false,onEvent:()=>{},prompt:'在目前測試工作區執行 npm --version、npm install sharp、npm test。已授權安裝公開 sharp 套件。必須在沙箱內執行，不提升權限。不要修改測試程式或 package scripts。只在三者皆成功時 passed=true；否則 false 並回報原始錯誤。回傳實際 evidence。'});
  const result=resultSchema.parse(output.result);writeFileSync(join(root,'report.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({root,...result}));if(!result.passed)process.exitCode=1;
}catch(e){console.error(e.message);process.exitCode=1;}
