import {z} from 'zod';
import {initServiceControl} from './service-control.js';

const sources={outbox:['outbox','id'],service:['service_requests','event_id']};
const input=z.object({action:z.enum(['cancel','retry']),confirm:z.literal(true),items:z.array(z.object({source:z.enum(['outbox','service']),id:z.string().min(1).max(200)}).strict()).min(1).max(100)}).strict();
const querySchema=z.object({state:z.enum(['all','unsent','pending','failed','sending','processing','sent','cancelled']).default('unsent'),source:z.enum(['all','outbox','service']).default('all'),search:z.string().max(200).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)});
const base=`SELECT 'outbox' source,id,line_id,binding_id,message,created_at created,sent_at,sent,attempts,next_try,error,cancelled_at,cancelled_by,cancel_reason,claimed_at,1 ready,rowid sequence FROM outbox
 UNION ALL SELECT 'service',event_id,line_id,binding_id,COALESCE(reply,CASE action WHEN 'restart' THEN '正在處理重啟服務指令' ELSE '正在確認服務網址' END),created,sent_at,sent,attempts,next_try,error,cancelled_at,cancelled_by,cancel_reason,claimed_at,CASE status WHEN 'done' THEN 1 ELSE 0 END,rowid FROM service_requests`;

export function notificationSnapshot(store,query={}){
  const {state,source,search,page}=querySchema.parse(query),now=Date.now();
  const sql=`WITH raw AS (${base}), records AS (
    SELECT r.*,COALESCE(u.name,'未綁定／已解除') member,COALESCE(l.label,'LINE') recipient,
    COALESCE(actor.name,'') cancelledByName,
    CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' WHEN sent=1 THEN 'sent' WHEN ready=0 THEN 'processing' WHEN claimed_at>? THEN 'sending' WHEN error IS NOT NULL THEN 'failed' ELSE 'pending' END state
    FROM raw r LEFT JOIN line_links l ON l.id=r.binding_id LEFT JOIN users u ON u.id=l.user_id LEFT JOIN users actor ON actor.id=r.cancelled_by
  )`;
  const where=`WHERE (?='all' OR source=?) AND (?='' OR instr(lower(message||' '||member||' '||recipient),lower(?))>0)`;
  const filtered=`${where} AND (?='all' OR state=? OR (?='unsent' AND state IN ('pending','failed','sending','processing')))`;
  const params=[now-120000,source,source,search,search,state,state,state];
  const total=store.db.prepare(`${sql} SELECT COUNT(*) n FROM records ${filtered}`).get(...params).n;
  const counts=Object.fromEntries(store.db.prepare(`${sql} SELECT state,COUNT(*) n FROM records ${where} GROUP BY state`).all(now-120000,source,source,search,search).map(r=>[r.state,r.n]));
  const rows=store.db.prepare(`${sql} SELECT source,id,member,recipient,substr(line_id,1,5)||'…'||substr(line_id,-4) lineHint,message,created,sent_at sentAt,attempts,next_try nextTry,error,state,cancelled_at cancelledAt,cancelledByName,cancel_reason cancelReason FROM records ${filtered} ORDER BY COALESCE(created,0) DESC,sequence DESC,source LIMIT 20 OFFSET ?`).all(...params,(page-1)*20);
  return {rows,total,page,pageSize:20,counts};
}

export function manageNotifications(store,user,body){
  const {action,items}=input.parse(body),now=Date.now();
  return store.transaction(()=>{
    const changed=[],skipped=[],seen=new Set();
    for(const item of items){
      const key=item.source+':'+item.id;if(seen.has(key))continue;seen.add(key);
      const [table,pk]=sources[item.source];
      const row=store.db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(item.id);
      let reason=!row?'找不到紀錄':row.sent?'已送出，不能撤回':row.cancelled_at?'已取消':row.claimed_at>now-120000?'正在傳送，請稍後確認結果':item.source==='service'&&row.status!=='done'?'服務指令仍在執行，不能取消回覆':null;
      if(!reason&&action==='retry'&&!row.error)reason='目前不是失敗通知';
      if(!reason&&action==='retry'&&row.binding_id&&store.lineLink(row.line_id)?.id!==row.binding_id)reason='LINE 綁定已變更';
      if(reason){skipped.push({...item,reason});continue;}
      if(action==='cancel')store.db.prepare(`UPDATE ${table} SET cancelled_at=?,cancelled_by=?,cancel_reason='管理者取消待送通知',reply_token=NULL,claimed_at=NULL WHERE ${pk}=?`).run(now,user.id,item.id);
      else store.db.prepare(`UPDATE ${table} SET next_try=0,error=NULL,claimed_at=NULL WHERE ${pk}=?`).run(item.id);
      store.db.prepare('INSERT INTO notification_actions(source,notification_id,action,actor,at) VALUES (?,?,?,?,?)').run(item.source,item.id,action,user.id,now);
      changed.push(item);
    }
    return {changed,skipped};
  });
}

export function registerNotificationAdmin(app,store,admin){
  initServiceControl(store);
  store.db.exec('CREATE TABLE IF NOT EXISTS notification_actions(seq INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,notification_id TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL)');
  app.get('/api/admin/notifications',admin,(req,res)=>res.json(notificationSnapshot(store,req.query)));
  app.post('/api/admin/notifications/action',admin,(req,res)=>res.json(manageNotifications(store,req.user,req.body)));
}
