import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

// Windows background descendants can inherit execFile's output pipes and keep
// its callback waiting after PowerShell exits. Use a result file and no pipes.
export async function runServiceRecovery({checkOnly=false,spawnProcess=spawn,timeoutMs=300000}={}){
  const directory=mkdtempSync(join(tmpdir(),'taskflow-recovery-'));
  const resultFile=join(directory,'result.json');
  try{
    const code=await new Promise((resolveExit,reject)=>{
      const child=spawnProcess('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/Recover-TaskFlow.ps1'),checkOnly?'-CheckOnly':'-Restart','-ResultFile',resultFile],{cwd:resolve('.'),windowsHide:true,stdio:'ignore'});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Service recovery timed out'));},timeoutMs);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',exitCode=>{clearTimeout(timer);resolveExit(exitCode);});
    });
    let result;
    try{result=JSON.parse(readFileSync(resultFile,'utf8').replace(/^\uFEFF/,''));}
    catch{throw new Error(`Recovery exited with code ${code} without a valid result`);}
    if(code!==0||result.ok!==true){
      const error=new Error(result.error||`Recovery exited with code ${code}`);
      error.stderr=error.message;throw error;
    }
    return result;
  }finally{rmSync(directory,{recursive:true,force:true});}
}
