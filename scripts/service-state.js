import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('data/taskflow.sqlite');
db.exec('PRAGMA busy_timeout=5000');
function securePublicOrigin(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.includes('.'))return null;
    return url.origin;
  }catch{return null;}
}
try{
  if(process.argv[2]==='check-idle'){
    const active=db.prepare('SELECT data FROM threads').all().some(row=>JSON.parse(row.data).status==='running')||db.prepare("SELECT COUNT(*) n FROM line_chats WHERE status='running'").get().n>0;
    process.exitCode=active?2:0;
  }else if(process.argv[2]==='set-url'){
    const origin=securePublicOrigin(process.argv[3]||'');
    if(!origin)throw new Error('Invalid secure public origin');
    db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('publicOrigin',JSON.stringify(origin));
  }else throw new Error('Invalid service-state operation');
}finally{db.close();}
