// Disposable local UI verification fixture. Never starts a LINE sender.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createApp} from '../server/app.js';
const root=mkdtempSync(join(tmpdir(),'tf-notification-ui-')),store=createStore(join(root,'db.sqlite'));
store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('publicOrigin',JSON.stringify('http://127.0.0.1:14313'));
const admin=store.addUser('測試管理者','admin','notification-ui-fixture','admin'),line='U'+'1'.repeat(32);
store.db.prepare('INSERT INTO line_links(id,user_id,line_id,label,created) VALUES (?,?,?,?,?)').run(id(),admin.id,line,'測試 LINE',new Date().toISOString());
const app=createApp(store,{status:{},stop(){}});
for(let i=0;i<24;i++){
 store.enqueueLine(line,[{type:'text',text:`[測試專案 ${i+1}]\n${i%3===0?'等待你審核計畫，請查看完整內容。':'這是通知紀錄管理介面的隔離測試資料。'}`}]);
 const row=store.db.prepare('SELECT id FROM outbox ORDER BY rowid DESC LIMIT 1').get();
 if(i%3===1)store.db.prepare('UPDATE outbox SET error=?,attempts=3,next_try=? WHERE id=?').run('雲端收件服務 502 (LINE HTTP 429)',Date.now()+60000,row.id);
 if(i%3===2)store.db.prepare('UPDATE outbox SET sent=1,sent_at=? WHERE id=?').run(Date.now(),row.id);
}
const server=app.listen(14313,'127.0.0.1',()=>console.log('Notification fixture: http://127.0.0.1:14313/settings'));
function stop(){server.close(()=>{store.close();rmSync(root,{recursive:true,force:true});process.exit(0);});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
