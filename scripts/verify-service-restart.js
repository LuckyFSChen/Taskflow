// Maintenance verification: drain current AI work without cancelling it, then
// verify the same restart script used by the LINE guardian. Restore dispatch.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {runServiceRecovery} from '../server/service-recovery.js';
const db=new DatabaseSync('data/taskflow.sqlite');
db.exec('PRAGMA busy_timeout=5000');
const original=db.prepare('SELECT value FROM settings WHERE key=?').get('runnerEnabled');
const started=Date.now();
const before=readFileSync('data/server.pid','utf8').trim();
try{
  db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('runnerEnabled','false');
  let lastLog=0;
  while(true){
    const active=db.prepare('SELECT data FROM threads').all().filter(r=>JSON.parse(r.data).status==='running').length;
    const chats=db.prepare("SELECT count(*) n FROM line_chats WHERE status='running'").get().n;
    if(!active&&!chats)break;
    if(Date.now()-started>30*60*1000)throw new Error('Timed out waiting for AI work; no restart performed.');
    if(Date.now()-lastLog>30000){console.log(`Waiting for ${active} AI task(s), ${chats} chat(s); new task dispatch paused.`);lastLog=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  const result=await runServiceRecovery();
  const after=readFileSync('data/server.pid','utf8').trim();
  if(!result.ok||after===before)throw new Error('Restart did not produce a new healthy server process.');
  const report={verifiedAt:new Date().toISOString(),beforePid:Number(before),afterPid:Number(after),...result};
  writeFileSync('data/service-restart-verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{
  if(original)db.prepare('UPDATE settings SET value=? WHERE key=?').run(original.value,'runnerEnabled');
  else db.prepare('DELETE FROM settings WHERE key=?').run('runnerEnabled');
  db.close();console.log('Original task dispatch setting restored.');
}
