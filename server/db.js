import { DatabaseSync } from 'node:sqlite';
import {initDeliveryState} from './delivery-state.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = text => createHash('sha256').update(text).digest('hex');
export function passwordHash(password) { const salt=randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function passwordMatches(password, stored) { const [salt,value]=stored.split(':'); const computed=scryptSync(password,salt,64); const expected=Buffer.from(value,'hex'); return expected.length===computed.length && timingSafeEqual(computed,expected); }

export function createStore(filename=resolve(process.env.TASKFLOW_DB_FILE||'data/taskflow.sqlite')) {
  mkdirSync(dirname(filename),{recursive:true});
  const db=new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL,line_id TEXT UNIQUE,link_hash TEXT,link_expires INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(user_id TEXT REFERENCES users(id),project_id TEXT REFERENCES projects(id),PRIMARY KEY(user_id,project_id));
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,priority INTEGER NOT NULL,position REAL NOT NULL,updated TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(status,priority DESC,position);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id,updated);
    CREATE TABLE IF NOT EXISTS plan_groups(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_plan_groups_project ON plan_groups(project_id,created);
    CREATE INDEX IF NOT EXISTS idx_plan_groups_owner ON plan_groups(owner_id,created);
    CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_threads_task ON threads(task_id);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),thread_id TEXT,at TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id,seq);
    CREATE TABLE IF NOT EXISTS inbox(event_id TEXT PRIMARY KEY,processed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,line_id TEXT NOT NULL,message TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_try INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL DEFAULT 0,error TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS line_flows(user_id TEXT PRIMARY KEY REFERENCES users(id),data TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS line_chats(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),line_id TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reply TEXT,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_line_chats_pending ON line_chats(status,created);
  `);
  if(!db.prepare('PRAGMA table_info(outbox)').all().some(c=>c.name==='payload'))db.exec('ALTER TABLE outbox ADD COLUMN payload TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS line_links(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),line_id TEXT NOT NULL UNIQUE,label TEXT NOT NULL DEFAULT '',notifications INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,last_seen TEXT);
    CREATE INDEX IF NOT EXISTS idx_line_links_user ON line_links(user_id);`);
  if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='link_label'))db.exec("ALTER TABLE users ADD COLUMN link_label TEXT NOT NULL DEFAULT ''");
  for(const u of db.prepare('SELECT id,line_id FROM users WHERE line_id IS NOT NULL').all())db.prepare('INSERT OR IGNORE INTO line_links(id,user_id,line_id,label,created) VALUES (?,?,?,?,?)').run(id(),u.id,u.line_id,'原有 LINE',now());
  // Legacy single-link writes remain compatible; additional links are not overwritten.
  db.exec(`CREATE TRIGGER IF NOT EXISTS legacy_line_link_update AFTER UPDATE OF line_id ON users WHEN OLD.line_id IS NOT NEW.line_id BEGIN
    DELETE FROM line_links WHERE user_id=OLD.id AND line_id=OLD.line_id;
    INSERT INTO line_links(id,user_id,line_id,label,created) SELECT lower(hex(randomblob(16))),NEW.id,NEW.line_id,'LINE',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NEW.line_id IS NOT NULL;
  END;`);
  if(!db.prepare('PRAGMA table_info(line_flows)').all().some(c=>c.name==='line_id')){
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE line_flows RENAME TO legacy_line_flows;
      CREATE TABLE line_flows(user_id TEXT NOT NULL REFERENCES users(id),line_id TEXT NOT NULL,data TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(user_id,line_id));
      INSERT INTO line_flows SELECT f.user_id,u.line_id,f.data,f.expires FROM legacy_line_flows f JOIN users u ON u.id=f.user_id WHERE u.line_id IS NOT NULL;
      DROP TABLE legacy_line_flows;COMMIT;`);
  }
  for(const table of ['outbox','line_chats'])if(!db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name==='binding_id')){
    db.exec('ALTER TABLE '+table+' ADD COLUMN binding_id TEXT');
    db.exec('UPDATE '+table+' SET binding_id=(SELECT id FROM line_links WHERE line_links.line_id='+table+'.line_id)');
  }
  for(const table of ['outbox','line_chats']){
    const columns=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
    if(!columns.includes('reply_token'))db.exec('ALTER TABLE '+table+' ADD COLUMN reply_token TEXT');
    if(!columns.includes('reply_expires'))db.exec('ALTER TABLE '+table+' ADD COLUMN reply_expires INTEGER NOT NULL DEFAULT 0');
  }
  // 方案群組（Plan Group）：舊資料庫沒有這個欄位，補上之後一律是 NULL。
  // NULL 代表「這個任務不屬於任何方案」，前端會當成獨立任務放進「其他任務」；
  // 絕對不用標題、專案名稱或任何模糊規則回填，否則會把不相干的舊任務黏在一起。
  if(!db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='plan_group_id')){
    // 刻意不加 FOREIGN KEY：這個欄位只是 JSON data 的鏡像，用來做索引與聚合查詢。
    // 從備份還原時 JSON 裡可能留著一個 plan_groups 已經不存在的 id，加了 FK 會讓
    // 整個還原失敗；真正的存在性與授權檢查在 domain 層（requirePlanGroup）。
    db.exec('ALTER TABLE tasks ADD COLUMN plan_group_id TEXT');
    // 既有任務的 JSON 裡也可能已經有 planGroupId（例如從備份還原），一併同步到欄位，
    // 但只認 JSON 裡真的存在的值，不做任何推測。
    for(const row of db.prepare('SELECT id,data FROM tasks').all()){
      let gid=null;try{gid=JSON.parse(row.data).planGroupId||null;}catch{gid=null;}
      if(gid)db.prepare('UPDATE tasks SET plan_group_id=? WHERE id=?').run(gid,row.id);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_plan_group ON tasks(plan_group_id,position)');
  initDeliveryState(db,'outbox');
  const store={db,
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value=fn(); db.exec('COMMIT'); return value; } catch(e) {db.exec('ROLLBACK'); throw e;} },
    setting(key,fallback=null) {const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row?JSON.parse(row.value):fallback;},
    setSetting(key,value) { db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); },
    user(userId) {const user=db.prepare('SELECT id,name,username,role,line_id FROM users WHERE id=?').get(userId);if(user)user.line_id=store.lineLinks(userId)[0]?.line_id||null;return user;},
    lineLinks(userId) {return db.prepare('SELECT * FROM line_links WHERE user_id=? ORDER BY created,id').all(userId);},
    lineLink(lineId) {return db.prepare('SELECT * FROM line_links WHERE line_id=?').get(lineId);},
    unlinkLine(userId,linkId) {return store.transaction(()=>{const link=db.prepare('SELECT * FROM line_links WHERE id=? AND user_id=?').get(linkId,userId);if(!link)return false;db.prepare('UPDATE users SET line_id=NULL WHERE id=? AND line_id=?').run(userId,link.line_id);db.prepare('DELETE FROM line_links WHERE id=?').run(linkId);db.prepare('DELETE FROM line_flows WHERE user_id=? AND line_id=?').run(userId,link.line_id);db.prepare('DELETE FROM outbox WHERE line_id=? AND sent=0').run(link.line_id);db.prepare("UPDATE line_chats SET status='cancelled' WHERE user_id=? AND line_id=? AND status IN ('pending','running')").run(userId,link.line_id);return true;});},
    addUser(name,username,password,role='member') { const uid=id(); db.prepare('INSERT INTO users(id,name,username,password,role) VALUES (?,?,?,?,?)').run(uid,name,username,passwordHash(password),role); return store.user(uid); },
    // Preview 驗收帳號專用：每次啟動 Preview 都要讓帳號的密碼**確定**是這一輪產生的那一組。
    // 只在「資料庫完全沒有使用者」時才建立的舊寫法，遇到跨次保留的 Preview 資料庫就必定 401。
    upsertUser(name,username,password,role='member') {
      const existing=db.prepare('SELECT id FROM users WHERE username=?').get(username);
      if(!existing)return store.addUser(name,username,password,role);
      db.prepare('UPDATE users SET name=?,password=?,role=? WHERE id=?').run(name,passwordHash(password),role,existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
      return store.user(existing.id);
    },
    // 驗收結束的清除：帳號與它的工作階段一起消失，Preview 資料庫裡不留下可再登入的身份。
    removeAcceptanceUser(username) {
      const existing=db.prepare('SELECT id FROM users WHERE username=?').get(username);
      if(!existing)return false;
      return store.transaction(()=>{
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
        db.prepare('DELETE FROM memberships WHERE user_id=?').run(existing.id);
        db.prepare('DELETE FROM line_links WHERE user_id=?').run(existing.id);
        // 這個帳號名下還有任務時不刪帳號（外鍵會擋，而且那代表它不只是驗收身份）：
        // 改成把密碼換成無人知道的亂數，一樣登不進去。
        if(db.prepare('SELECT 1 FROM tasks WHERE owner_id=?').get(existing.id)){
          db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(randomBytes(24).toString('base64url')),existing.id);
          return true;
        }
        db.prepare('DELETE FROM users WHERE id=?').run(existing.id);
        return true;
      });
    },
    project(pid) {return db.prepare('SELECT * FROM projects WHERE id=?').get(pid);},
    hasProject(user,pid) {return !!store.project(pid) && (user.role==='admin'||!!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND project_id=?').get(user.id,pid));},
    task(tid) {const row=db.prepare('SELECT data FROM tasks WHERE id=?').get(tid);return row?JSON.parse(row.data):null;},
    // 欄位一律寫明：tasks 已經多了 plan_group_id，位置式 INSERT ... VALUES 會在下次加欄位時再壞一次。
    // JSON data 仍是任務的唯一真相；plan_group_id 只是給索引與聚合查詢用的鏡像欄位，兩者永遠一起寫入。
    saveTask(t) {t.updated=now(); db.prepare('INSERT INTO tasks(id,owner_id,project_id,status,priority,position,updated,data,plan_group_id) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,priority=excluded.priority,position=excluded.position,updated=excluded.updated,data=excluded.data,plan_group_id=excluded.plan_group_id').run(t.id,t.ownerId,t.projectId,t.status,t.priority,t.position,t.updated,JSON.stringify(t),t.planGroupId||null); return t;},
    planGroup(gid) {const r=gid?db.prepare('SELECT * FROM plan_groups WHERE id=?').get(gid):null;return r?{id:r.id,projectId:r.project_id,ownerId:r.owner_id,name:r.name,created:r.created,updated:r.updated}:null;},
    savePlanGroup(g) {g.updated=now();db.prepare('INSERT INTO plan_groups(id,project_id,owner_id,name,created,updated) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated=excluded.updated').run(g.id,g.projectId,g.ownerId,g.name,g.created,g.updated);return store.planGroup(g.id);},
    // 成員只看得到自己的任務，所以也只列出自己的方案；管理者看得到全部。
    planGroups(user) {const rows=user?.role==='admin'||!user?db.prepare('SELECT * FROM plan_groups ORDER BY created,id').all():db.prepare('SELECT * FROM plan_groups WHERE owner_id=? ORDER BY created,id').all(user.id);return rows.map(r=>({id:r.id,projectId:r.project_id,ownerId:r.owner_id,name:r.name,created:r.created,updated:r.updated}));},
    tasks(user) {const rows=user?.role==='admin'||!user?db.prepare('SELECT data FROM tasks ORDER BY priority DESC,position,updated').all():db.prepare('SELECT data FROM tasks WHERE owner_id=? ORDER BY priority DESC,position,updated').all(user.id);return rows.map(r=>JSON.parse(r.data));},
    threads(tid) {return db.prepare('SELECT data FROM threads WHERE task_id=? ORDER BY rowid').all(tid).map(r=>JSON.parse(r.data));},
    saveThread(t) {db.prepare('INSERT INTO threads VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id,t.taskId,JSON.stringify(t));return t;},
    event(tid,kind,message,threadId=null) {db.prepare('INSERT INTO events(task_id,thread_id,at,kind,message) VALUES (?,?,?,?,?)').run(tid,threadId,now(),kind,String(message).slice(0,16000));},
    events(tid) {return db.prepare('SELECT * FROM (SELECT * FROM events WHERE task_id=? ORDER BY seq DESC LIMIT 300) ORDER BY seq').all(tid);},
    enqueueLine(lineId,messages,{replyToken=null,replyExpires=0}={}) {const text=messages.map(m=>m.text).join('\n');db.prepare('INSERT INTO outbox(id,line_id,message,payload,binding_id,reply_token,reply_expires,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id(),lineId,text,JSON.stringify(messages),store.lineLink(lineId)?.id||null,replyToken,replyExpires,Date.now());},
    notify(t,message) {for(const link of store.lineLinks(t.ownerId).filter(l=>l.notifications))store.enqueueLine(link.line_id,[{type:'text',text:`[${t.title}]\n${message}`.slice(0,4900),quickReply:{items:[{type:'action',action:{type:'postback',label:'查看任務',data:`tf:view:${t.id}`}},{type:'action',action:{type:'postback',label:'主選單',data:'tf:home'}}]}}]);},
    close() {db.close();}
  };
  return store;
}
