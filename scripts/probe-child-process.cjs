// Read-only runtime check: no installs, network calls, or project changes.
const {spawn}=require('node:child_process');
async function probe(label,command,args){
  return new Promise(resolve=>{
    let finished=false;
    const done=result=>{if(finished)return;finished=true;clearTimeout(timer);console.log(JSON.stringify({label,...result}));resolve(result.ok);};
    const timer=setTimeout(()=>{child.kill();done({ok:false,error:'TIMEOUT'});},10000);
    let child;
    try{child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch(e){done({ok:false,error:e.code||e.message});return;}
    child.stdout.resume();child.stderr.resume();
    child.on('error',e=>done({ok:false,error:e.code||e.message}));
    child.on('close',code=>done({ok:code===0,exitCode:code}));
  });
}
(async()=>{
  const results=[await probe('node-child',process.execPath,['--version'])];
  if(process.platform==='win32')results.push(await probe('npm-script-shell',process.env.ComSpec||'C:\\Windows\\System32\\cmd.exe',['/d','/s','/c','exit 0']));
  if(results.some(ok=>!ok))process.exitCode=1;
})();
