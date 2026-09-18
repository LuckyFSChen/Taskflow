import {existsSync,readdirSync,statSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
export function resolveCliExecutable(engine,{env=process.env,platform=process.platform}={}){
  const configured=env[engine==='codex'?'CODEX_BIN':'CLAUDE_BIN'];
  if(configured&&configured!==engine)return configured;
  if(platform!=='win32')return configured||engine;
  const pathValue=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1]||'';
  for(const dir of pathValue.split(';').filter(Boolean)){const candidate=join(dir.replace(/^"|"$/g,''),engine+'.exe');if(isAbsolute(candidate)&&existsSync(candidate))return candidate;}
  if(engine==='codex'&&env.LOCALAPPDATA){
    const root=join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    if(existsSync(root)){
      const candidates=readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>join(root,e.name,'codex.exe')).filter(p=>existsSync(p));
      candidates.sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
      if(candidates.length)return candidates[0];
    }
  }
  return configured||engine;
}
