import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {infrastructureEnvironment} from './ports.js';

// Windows background descendants can inherit execFile's output pipes and keep
// its callback waiting after PowerShell exits. Use a result file and no pipes.
// build=true 時會先建置再停機：合併進 main 的原始碼不會自己變成 dist/，
// 不重建的話重新啟動之後網頁還是舊的。建置失敗就直接回報失敗，
// 而且**不會停掉正在執行的服務**——使用者不會因為一次建置錯誤而失去網頁。
export async function runServiceRecovery({checkOnly=false,build=false,spawnProcess=spawn,timeoutMs=build?600000:300000}={}){
  const directory=mkdtempSync(join(tmpdir(),'taskflow-recovery-'));
  const resultFile=join(directory,'result.json');
  const errorFile=join(directory,'stderr.log');
  try{
    const code=await new Promise((resolveExit,reject)=>{
      // 這支腳本會再啟動一次 server/index.js。它繼承到的環境若帶著某個 runtime 的 PORT，
      // 新的主服務就會綁到那個 port——所以在這裡就把 port 身分清乾淨並釘上正式值。
      // Keep startup/parser errors even when PowerShell cannot write result.json.
      // A file descriptor preserves the no-pipes contract for background children.
      const errorFd=openSync(errorFile,'w');
      let child;
      try{
        child=spawnProcess('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/Recover-TaskFlow.ps1'),checkOnly?'-CheckOnly':'-Restart',...(build?['-Build']:[]),'-ResultFile',resultFile],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','ignore',errorFd],env:infrastructureEnvironment()});
      }finally{closeSync(errorFd);}
      const timer=setTimeout(()=>{child.kill();reject(new Error('Service recovery timed out'));},timeoutMs);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',exitCode=>{clearTimeout(timer);resolveExit(exitCode);});
    });
    let result;
    try{result=JSON.parse(readFileSync(resultFile,'utf8').replace(/^\uFEFF/,''));}
    catch{
      const detail=readFileSync(errorFile,'utf8').trim().slice(-4000);
      const error=new Error(`Recovery exited with code ${code} without a valid result${detail?`: ${detail}`:''}`);
      error.stderr=error.message;
      throw error;
    }
    if(code!==0||result.ok!==true){
      const error=new Error(result.error||`Recovery exited with code ${code}`);
      error.stderr=error.message;throw error;
    }
    return result;
  }finally{rmSync(directory,{recursive:true,force:true});}
}
